// Power-plan controller: drives the Solarbank 2 output preset (custom rate
// plan, param_type "6") instead of relying on the static schedule set in the
// Anker app. Goal: avoid the charge/discharge jojo around a fixed preset,
// and let the user choose HOW PV/battery/grid should be prioritized.
//
// Strategy engine (2026-09-16). Three mutually-exclusive strategies:
//   house_priority     -> target = min(pv, demand, max) while PV covers
//                          something; once the discharge trigger fires,
//                          target = min(max, demand) (battery tops up the
//                          gap). This is the original 2026-09-15 algorithm,
//                          generalized: the discharge trigger REPLACES the
//                          old fuzzy isEveningBridge() heuristic with an
//                          explicit user choice (see below).
//   battery_priority    -> while soc < chargeCeilingPct AND pv > 0: target=0
//                          (PV is deliberately withheld from the house so it
//                          charges the battery instead; house demand comes
//                          from the grid meanwhile — confirmed intentional
//                          with the user, not a bug). Once the ceiling is
//                          hit or PV drops to 0, falls back to
//                          house_priority's rule (same discharge trigger
//                          governs the handoff).
//   grid_zero_besteffort -> the normal reserve guard is REPLACED (not just
//                          capped) by effectiveFloor = dischargeFloorPct +
//                          tolerancePct (tolerance has no Anker API
//                          equivalent — always a locally-configured value,
//                          default 3 points). While soc > effectiveFloor:
//                          target = min(max, demand) UNCONDITIONALLY,
//                          ignoring PV level and the discharge trigger
//                          entirely (confirmed with the user). Below that
//                          floor: target = 0 until SOC recovers.
// Discharge trigger (house_priority / battery_priority only; ignored by
// grid_zero_besteffort):
//   pv_zero    -> shortfall branch fires only once pv <= 0 exactly.
//   grid_zero  -> shortfall branch fires whenever pv < demand at all, i.e.
//                 discharge immediately to keep grid import near zero
//                 continuously (confirmed via a PV=400W/demand=600W
//                 example). This makes house_priority+grid_zero converge to
//                 the same shape as grid_zero_besteffort — they share the
//                 fullDemandTarget() helper below, differing only in which
//                 floor gates them.
// Never above houseDemand in any branch => zero export by construction. The
// device itself enforces its configured SOC reserve / charge limits on top.
//
// SOC limits (2026-09-15/16): the discharge floor ("reserve") and charge
// ceiling ("max charging") are read from the SAME account config
// (`battery-params.js`'s `getBatteryLimits()`, 6 h cache — now sourced from
// get_power_cutoff, the endpoint that actually works for this bare-SB2
// hardware, see battery-params.js) the Battery tab already uses — not
// guessed locally. `atChargeCeiling` in `lastDecision` is informational
// (used by battery_priority's own branch condition, not a separate export
// guard — raising target above houseDemand to "use up" a full battery would
// risk exporting, which the device must never do).
//
// Write path (spike-verified 2026-09-15): param_type "6", cmd 17 via
// set_site_device_param; always TWO slots (Anker single-slot 0 W export bug).
// Preset is only rewritten on a >= 50 W change (or as a 5-min refresh), so
// the endpoint sees writes a few times per hour at most. This write
// discipline (below) is shared UNCHANGED by all three strategies — it only
// ever sees the final numeric target, so a strategy switch is naturally
// subject to the same step-down-promptly/step-up-after-hold hysteresis as
// any other target change.

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBatteryLimits } from "./battery-params.js";

const GET_EP = "power_service/v1/site/get_site_device_param";
const SET_EP = "power_service/v1/site/set_site_device_param";
const PARAM_TYPE = "6"; // Solarbank 2 schedule
const CMD = 17;

const WRITE_MIN_DELTA_W = 50; // rewrite when target moved at least this much
const REFRESH_MS = 5 * 60 * 1000; // re-write smaller drifts after this long
const MIN_WRITE_GAP_MS = 30 * 1000; // never write more often than this
// Asymmetric hysteresis (2026-09-15, preset-lag fix): step DOWN promptly —
// a preset above current PV is served from the CELLS (the jojo this
// controller exists to kill). Step UP only after the higher target holds
// continuously for this long — cloud wobble around a 100 W boundary
// otherwise makes the preset chase PV while the device lags ~1 min behind.
const STEP_UP_HOLD_MS = 3 * 60 * 1000;

export class PowerPlanController {
  constructor(anker, getLiveBattery) {
    this.anker = anker;
    this.getLiveBattery = getLiveBattery;
    const dbDir = path.dirname(
      process.env.DB_PATH ??
        path.join(path.dirname(fileURLToPath(import.meta.url)), "data.db"),
    );
    this.stateFile = path.join(dbDir, ".power-plan-state.json");
    this.enabled = false;
    this.originalRaw = null; // schedule as found before we took over (restore)
    this.template = null; // last-read parsed schedule (limits etc.)
    this.strategy = "house_priority";
    this.trigger = "pv_zero";
    this.tolerancePct = 3;
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
      this.strategy = saved.strategy ?? "house_priority";
      this.trigger = saved.trigger ?? "pv_zero";
      this.tolerancePct = saved.tolerancePct ?? 3;
      // 2026-09-16: state files from before the strategy engine have no
      // `trigger` field — pv_zero is the closer, strictly-more-conservative
      // analog of the deleted isEveningBridge() heuristic (never fires
      // earlier than it would have), but it IS a behavior shift, so make it
      // visible rather than silent for anyone upgrading with the controller
      // already enabled.
      if (this.enabled && saved.trigger === undefined) {
        console.log(
          "[power-plan] upgraded: discharge-trigger model replaces the evening-bridge " +
            "heuristic; defaulting to house_priority + pv_zero trigger",
        );
      }
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
          strategy: this.strategy,
          trigger: this.trigger,
          tolerancePct: this.tolerancePct,
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

  roundDown(v, step) {
    return Math.max(0, Math.floor(v / step) * step);
  }

  // Shared "serve full demand from PV+battery combined" building block —
  // used by house_priority's/battery_priority's shortfall branch AND by
  // grid_zero_besteffort's unconditional formula. The only thing that ever
  // differs between callers is which floor gates the soc <= check.
  fullDemandTarget(demandW, max, step) {
    return this.roundDown(Math.min(max, demandW), step);
  }

  computeHousePriority({ pvW, demandW, soc, trigger, dischargeFloorPct, max, step }) {
    if (soc <= dischargeFloorPct) return 0;
    const shortfall = trigger === "grid_zero" ? pvW < demandW : pvW <= 0;
    if (pvW <= 0 || shortfall) return this.fullDemandTarget(demandW, max, step);
    return this.roundDown(Math.min(pvW, demandW, max), step);
  }

  computeBatteryPriority({ pvW, demandW, soc, trigger, dischargeFloorPct, chargeCeilingPct, max, step }) {
    if (soc <= dischargeFloorPct) return 0;
    if (soc < chargeCeilingPct && pvW > 0) return 0; // withhold PV, charge the battery
    return this.computeHousePriority({ pvW, demandW, soc, trigger, dischargeFloorPct, max, step });
  }

  computeGridZeroBestEffort({ demandW, soc, tolerancePct, dischargeFloorPct, max, step }) {
    const effectiveFloor = dischargeFloorPct + (tolerancePct ?? 3);
    if (soc <= effectiveFloor) return 0;
    return this.fullDemandTarget(demandW, max, step);
  }

  computeTarget(ctx) {
    const max = this.template?.max_load ?? 800;
    const step = this.template?.step ?? 10;
    const args = { ...ctx, max, step };
    switch (ctx.strategy) {
      case "battery_priority":
        return this.computeBatteryPriority(args);
      case "grid_zero_besteffort":
        return this.computeGridZeroBestEffort(args);
      default:
        return this.computeHousePriority(args); // "house_priority"
    }
  }

  // Called on every battery sync with the latest scen_info payload.
  async tick(info) {
    if (!this.enabled || !info || !this.anker.siteId) return;
    // Never act on stale samples: right after a (re)start the DB/MQTT merge
    // can hand us an old reading, and a prompt step-down on that once wrote
    // a bogus 100 W preset (2026-09-15).
    if (!info.ts || Date.now() - info.ts > 30 * 1000) return;
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
      const { dischargeFloorPct, chargeCeilingPct } = await getBatteryLimits(
        this.anker,
        this.getLiveBattery,
      );
      const targetW = this.computeTarget({
        pvW,
        demandW,
        soc,
        strategy: this.strategy,
        trigger: this.trigger,
        tolerancePct: this.tolerancePct,
        dischargeFloorPct,
        chargeCeilingPct,
      });
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
      this.lastDecision = {
        at: now,
        pvW,
        demandW,
        soc,
        strategy: this.strategy,
        trigger: this.trigger,
        tolerancePct: this.tolerancePct,
        targetW,
        wrote,
        reason,
        dischargeFloorPct,
        chargeCeilingPct,
        atChargeCeiling: soc >= chargeCeilingPct,
      };
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

  // Partial update — pass only the field(s) being changed. Takes effect on
  // the next tick (no special hysteresis reset needed: the existing
  // step-up-hold logic already re-arms itself the moment the computed
  // target differs from before, so a strategy switch is subject to the same
  // write discipline as any other target change).
  setStrategy({ strategy, trigger, tolerancePct } = {}) {
    if (strategy !== undefined) this.strategy = strategy;
    if (trigger !== undefined) this.trigger = trigger;
    if (tolerancePct !== undefined) this.tolerancePct = tolerancePct;
    this.saveState();
  }

  getState() {
    return {
      enabled: this.enabled,
      canRestore: this.originalRaw != null,
      strategy: this.strategy,
      trigger: this.trigger,
      tolerancePct: this.tolerancePct,
      lastWrittenPower: this.lastWrittenPower,
      lastWriteAt: this.lastWriteAt || null,
      lastError: this.lastError,
      lastDecision: this.lastDecision,
    };
  }
}
