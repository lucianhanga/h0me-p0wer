// Power-plan controller: drives the Solarbank 2 output preset (custom rate
// plan, param_type "6") instead of relying on the static schedule set in the
// Anker app. Goal: avoid the charge/discharge jojo around a fixed preset and
// push as much PV into the house as possible — without ever exporting.
//
// Algorithm (agreed with the user, 2026-09-15):
//   PV = 0          -> discharge min(800, houseDemand)        (SOC > reserve)
//   PV > 0          -> output min(floor(PV/100)*100, houseDemand)
//   battery full    -> min(PV, houseDemand)  (all PV to house)
// Never above houseDemand => zero export by construction. The device itself
// enforces its configured SOC reserve / charge limits on top.
//
// Write path (spike-verified 2026-09-15): param_type "6", cmd 17 via
// set_site_device_param; always TWO slots (Anker single-slot 0 W export bug).
// Preset is only rewritten on a >= 50 W change (or as a 5-min refresh), so
// the endpoint sees writes a few times per hour at most.

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GET_EP = "power_service/v1/site/get_site_device_param";
const SET_EP = "power_service/v1/site/set_site_device_param";
const PARAM_TYPE = "6"; // Solarbank 2 schedule
const CMD = 17;

const WRITE_MIN_DELTA_W = 50; // rewrite when target moved at least this much
const REFRESH_MS = 5 * 60 * 1000; // re-write smaller drifts after this long
const MIN_WRITE_GAP_MS = 30 * 1000; // never write more often than this
const FULL_SOC = 99; // "battery full" threshold (charge limit not exposed)
// Asymmetric hysteresis (2026-09-15, preset-lag fix): step DOWN promptly —
// a preset above current PV is served from the CELLS (the jojo this
// controller exists to kill). Step UP only after the higher target holds
// continuously for this long — cloud wobble around a 100 W boundary
// otherwise makes the preset chase PV while the device lags ~1 min behind.
const STEP_UP_HOLD_MS = 3 * 60 * 1000;

export class PowerPlanController {
  constructor(anker) {
    this.anker = anker;
    const dbDir = path.dirname(
      process.env.DB_PATH ??
        path.join(path.dirname(fileURLToPath(import.meta.url)), "data.db"),
    );
    this.stateFile = path.join(dbDir, ".power-plan-state.json");
    this.enabled = false;
    this.originalRaw = null; // schedule as found before we took over (restore)
    this.template = null; // last-read parsed schedule (limits etc.)
    this.lastWrittenPower = null;
    this.lastWriteAt = 0;
    this.lastError = null;
    this.lastDecision = null; // {at, pvW, demandW, soc, targetW, wrote, reason}
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, "utf8"));
      this.enabled = saved.enabled === true;
      this.originalRaw = saved.originalRaw ?? null;
      this.lastWrittenPower = saved.lastWrittenPower ?? null;
      this.lastWriteAt = saved.lastWriteAt ?? 0;
    } catch {
      /* no saved state — controller starts disabled */
    }
  }

  saveState() {
    try {
      writeFileSync(
        this.stateFile,
        JSON.stringify({
          enabled: this.enabled,
          originalRaw: this.originalRaw,
          lastWrittenPower: this.lastWrittenPower,
          lastWriteAt: this.lastWriteAt,
        }),
      );
      chmodSync(this.stateFile, 0o600);
    } catch {
      /* state write failed — non-fatal */
    }
  }

  async readSchedule() {
    const resp = await this.anker.post(GET_EP, {
      site_id: this.anker.siteId,
      param_type: PARAM_TYPE,
    });
    const raw = resp?.param_data ?? resp?.data?.param_data;
    if (typeof raw !== "string" || !raw) {
      throw new Error("no param_data in get_site_device_param response");
    }
    return { raw, parsed: JSON.parse(raw) };
  }

  async writeSchedule(parsed) {
    const resp = await this.anker.post(SET_EP, {
      site_id: this.anker.siteId,
      param_type: PARAM_TYPE,
      cmd: CMD,
      param_data: JSON.stringify(parsed),
    });
    const code = resp?.code ?? 0; // post() unwraps data; empty success = {}
    if (code !== 0) throw new Error(`set_site_device_param code ${code}`);
  }

  // Build the schedule body for a flat preset: same power all week, split
  // into two half-day slots (a single 0 W slot misbehaves on the device).
  buildPresetSchedule(powerW) {
    const t = this.template ?? {};
    const range0 = t.custom_rate_plan?.[0]?.ranges?.[0] ?? {};
    const slot = (start, end) => ({
      start_time: start,
      end_time: end,
      power: powerW,
      charging_type: range0.charging_type ?? null,
    });
    return {
      ...t,
      mode_type: 3, // custom/manual rate plan
      custom_rate_plan: [
        {
          index: 0,
          week: [0, 1, 2, 3, 4, 5, 6],
          ranges: [slot("00:00", "12:00"), slot("12:00", "24:00")],
        },
      ],
    };
  }

  computeTarget({ pvW, demandW, soc }) {
    const max = this.template?.max_load ?? 800;
    const step = this.template?.step ?? 10;
    const reserve = this.template?.reserved_soc ?? 0;
    let target;
    if (soc <= reserve) target = 0;
    else if (pvW <= 0) target = Math.min(max, demandW);
    else if (soc >= FULL_SOC) target = Math.min(pvW, demandW, max);
    else target = Math.min(Math.floor(pvW / 100) * 100, demandW, max);
    target = Math.max(0, Math.floor(target / step) * step);
    return target;
  }

  // Called on every battery sync with the latest scen_info payload.
  async tick(info) {
    if (!this.enabled || !info || !this.anker.siteId) return;
    const pvW = info.pvW ?? 0;
    const demandW = info.homeLoadW ?? null;
    const soc = info.soc ?? null;
    if (demandW == null || soc == null) return;
    try {
      if (!this.template) {
        const { parsed, raw } = await this.readSchedule();
        this.template = parsed;
        if (this.enabled && !this.originalRaw) {
          this.originalRaw = raw;
          this.saveState();
        }
      }
      const targetW = this.computeTarget({ pvW, demandW, soc });
      const now = Date.now();
      const cur = this.lastWrittenPower;
      let shouldWrite = false;
      let reason = "within deadband";
      if (cur == null) {
        shouldWrite = true;
        reason = "initial";
      } else if (targetW < cur) {
        // Step down promptly (preset above PV burns the battery).
        this.pendingUp = null;
        if (cur - targetW >= WRITE_MIN_DELTA_W) {
          shouldWrite = true;
          reason = "step down";
        } else if (now - this.lastWriteAt >= REFRESH_MS) {
          shouldWrite = true;
          reason = "refresh";
        }
      } else if (targetW > cur) {
        // Step up only after the higher target holds continuously.
        if (this.pendingUp?.target !== targetW) {
          this.pendingUp = { target: targetW, since: now };
        }
        const heldS = Math.round((now - this.pendingUp.since) / 1000);
        if (
          targetW - cur >= WRITE_MIN_DELTA_W &&
          now - this.pendingUp.since >= STEP_UP_HOLD_MS
        ) {
          shouldWrite = true;
          reason = `step up (held ${heldS}s)`;
        } else {
          reason = `holding up-step (${heldS}s/${STEP_UP_HOLD_MS / 1000}s)`;
        }
      } else {
        this.pendingUp = null;
      }
      let wrote = false;
      if (shouldWrite) {
        if (now - this.lastWriteAt >= MIN_WRITE_GAP_MS) {
          await this.writeSchedule(this.buildPresetSchedule(targetW));
          this.lastWrittenPower = targetW;
          this.lastWriteAt = now;
          this.pendingUp = null;
          wrote = true;
          this.saveState();
        } else {
          reason = `${reason} — waiting (min write gap)`;
        }
      }
      this.lastError = null;
      this.lastDecision = { at: now, pvW, demandW, soc, targetW, wrote, reason };
    } catch (err) {
      this.lastError = err.message;
      console.warn(`[power-plan] tick failed: ${err.message}`);
    }
  }

  async enable() {
    const { raw, parsed } = await this.readSchedule();
    if (!this.originalRaw) this.originalRaw = raw;
    this.template = parsed;
    this.enabled = true;
    this.lastWriteAt = 0; // force an immediate write on next tick
    this.saveState();
  }

  async disable() {
    this.enabled = false;
    this.saveState();
    if (this.originalRaw && this.anker.siteId) {
      // Restore the exact schedule the device had before we took over.
      await this.anker.post(SET_EP, {
        site_id: this.anker.siteId,
        param_type: PARAM_TYPE,
        cmd: CMD,
        param_data: this.originalRaw,
      });
      this.template = null;
      this.lastWrittenPower = null;
    }
  }

  getState() {
    return {
      enabled: this.enabled,
      canRestore: this.originalRaw != null,
      lastWrittenPower: this.lastWrittenPower,
      lastWriteAt: this.lastWriteAt || null,
      lastError: this.lastError,
      lastDecision: this.lastDecision,
    };
  }
}
