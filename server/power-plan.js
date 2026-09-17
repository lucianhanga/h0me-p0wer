// Power-plan controller: drives the Solarbank 2 output preset (custom rate
// plan, param_type "6") instead of relying on the static schedule set in the
// Anker app. Goal: avoid the charge/discharge jojo around a fixed preset,
// and let the user choose HOW PV/battery/grid should be prioritized.
//
// Strategy engine (2026-09-16, simplified same day — see below). Three
// mutually-exclusive strategies:
//   anker_app        -> (2026-09-17, user request) this app writes NOTHING —
//                        the device runs whatever schedule/behavior the user
//                        has configured directly in the Anker mobile app.
//                        Distinct from the overall enabled/disabled toggle
//                        (Live tab): that restores a ONE-TIME snapshot taken
//                        whenever the controller first took over, which goes
//                        stale the moment the user edits anything in the
//                        Anker app afterward. anker_app never writes at all,
//                        so whatever the user sets stays in effect
//                        indefinitely, not just until the next tick.
//                        tick() short-circuits before any read/write; no
//                        target, no decision beyond "not writing" — see the
//                        early-return block below. Switching INTO or OUT OF
//                        this strategy invalidates the cached schedule
//                        template (setStrategy()) so the next active tick
//                        re-reads and reconciles lastWrittenPower against
//                        whatever the device actually has, instead of
//                        trusting a belief that predates the user's own
//                        Anker-app edits.
//   house_priority   -> (the default) battery tops up the house continuously,
//                        down to dischargeFloorPct + DISCHARGE_TOLERANCE_PCT,
//                        regardless of PV level — via dischargeToTarget().
//                        This ABSORBED what was briefly a separate 3rd
//                        strategy ("grid ≈ 100 W best-effort") — the same
//                        day it was decided House Priority should just BE
//                        that behavior, and the 3rd option was removed.
//   battery_priority -> while soc < chargeCeilingPct AND pv > 0: target=0
//                        (PV is deliberately withheld from the house so it
//                        charges the battery instead; house demand comes
//                        from the grid meanwhile — confirmed intentional
//                        with the user, not a bug). Once full: a cautious
//                        hill-climb toward demandW - GRID_TARGET_W, gated
//                        on the REAL cellsW signal (deriveBatteryFlow) so
//                        the battery is never knowingly asked to
//                        discharge — see computeBatteryPriority()'s own
//                        comment for the full reasoning and the three
//                        earlier same-day attempts this replaced. The
//                        charge/hold switch is latched with
//                        CHARGE_RESUME_HYSTERESIS_PCT, not a bare
//                        threshold — see that constant's comment.
// Discharge trigger — auto | manual:
//   auto   -> the strategy above decides (dischargeToTarget() for
//             house_priority; the hold-phase hill-climb for
//             battery_priority once full, target=0 while still charging).
//   manual -> a persisted `manualDischarge` boolean toggle OVERRIDES the
//             selected strategy entirely (confirmed: "will overwrite
//             whatever the strategy was selected before") — true ->
//             dischargeToTarget(), false -> passthroughOnly(), regardless
//             of `strategy`. Persisted (not time-limited like an earlier,
//             now-removed "discharge now for 15 min" design) — a deliberate
//             standing choice, not a one-off action.
// Never above houseDemand in any branch => zero export by construction. The
// device itself enforces its configured SOC reserve / charge limits on top.
//
// Grid target (GRID_TARGET_W env var, default 100 W) and discharge
// tolerance (DISCHARGE_TOLERANCE_PCT env var, default 4 points) are BOTH
// deployment-time constants, not user-adjustable at runtime (like
// TARIFF_EUR_PER_KWH elsewhere in this codebase) — not exposed in the
// Strategy tab UI, by request, to keep the UI to just the two dropdowns +
// the manual toggle. dischargeToTarget() leaves demandW - GRID_TARGET_W for
// PV+battery to cover (the original ask was "keep grid supply UNDER 100 W",
// not literally 0), down to dischargeFloorPct + DISCHARGE_TOLERANCE_PCT
// (padding the account's real reserve, since this mode bypasses the normal
// PV-based restraint that would otherwise protect it).
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
import { getBatteryLimits, deriveBatteryFlow } from "./battery-params.js";

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
// Lowered 90s -> from the original 3 min (2026-09-16, user request, after
// the step-up-hold-never-fires fix made the hold's real-world lag visible)
// — still comfortably above the ~1 min device response lag that motivates
// the hold at all, so it shouldn't reintroduce PV-noise-chasing, while
// responding noticeably faster to genuine demand/strategy changes.
const STEP_UP_HOLD_MS = 90 * 1000;
// Deployment-time constants (2026-09-16) — see the file header for why
// these aren't runtime/UI-adjustable.
const GRID_TARGET_W = Number(process.env.GRID_TARGET_W ?? 100);
const DISCHARGE_TOLERANCE_PCT = Number(process.env.DISCHARGE_TOLERANCE_PCT ?? 4);
// Charge/hold hysteresis for battery_priority (2026-09-17, real production
// incident: at a fixed chargeCeilingPct threshold, the unit's OWN standby/
// BMS draw — a few watts, continuous, not something this app controls or
// can prevent — nudges SOC down ~1 point even while "full". A bare
// threshold snapped straight back into target=0 (withhold ALL PV from the
// house, pull 100% of demand from grid) just to claw that 1 point back,
// then flipped straight back to passthrough at the ceiling — a visible
// jojo between chargeCeilingPct and chargeCeilingPct-1 every few minutes.
// Once the ceiling is reached, hold the hill-climb probe below (see
// PROBE_STEP_W) until SOC has actually dropped this many points below the
// ceiling before resuming withhold-and-charge — absorbs the standby-draw
// wobble without flipping state every tick.
const CHARGE_RESUME_HYSTERESIS_PCT = Number(process.env.CHARGE_RESUME_HYSTERESIS_PCT ?? 3);
// battery_priority's hold-at-ceiling probe (2026-09-17, fifth same-day
// revision — see computeBatteryPriority()'s comment for the full history
// and reasoning). The hardware exposes only ONE flat output-power preset;
// the device decides internally whether to source it from PV or cells, so
// discovering "how much PV is actually available beyond what's currently
// reported" requires asking for more, which risks a brief real pull from
// the battery if the panels can't cover it. This climbs toward the safe
// ceiling in small, validated PROBE_STEP_W steps, gated on
// deriveBatteryFlow()'s real cellsW — the one signal that reflects what
// the CURRENTLY ACTIVE preset is actually doing, not what we're about to
// ask for. Any real discharge corrects in exactly one step (the exact
// observed amount, not a fixed decrement, so a bigger step size doesn't
// increase the WORST-CASE EXPOSURE TIME — still one ~10-20 s tick — only
// its worst-case MAGNITUDE). 150 W (2026-09-17, raised from an initial
// 50 W same day — full recovery at 50 W/step was over an hour, "still
// very slow" per the user, and they explicitly asked to go faster after
// seeing the first, more conservative revision of this same tuning
// pass). PROBE_STEP_W smaller than WRITE_MIN_DELTA_W would never
// actually reach the device.
const PROBE_STEP_W = Number(process.env.PROBE_STEP_W ?? 150);
// Minimum time between successive upward probe steps (2026-09-17, added
// after a real incident: web research — thomluther/anker-solix-api, the
// reference Solarbank reverse-engineering project, and Anker's own
// support docs — confirmed Solarbank 2 only reports fresh telemetry to
// Anker's cloud every ~5 MINUTES by default (worse than the ~1 min this
// file previously assumed elsewhere). That same research found the
// maintainer's own explicit recommendation: don't change presets faster
// than every 2 MINUTES — that, not 5, is the documented safe floor; 5 min
// was this file's own extra-conservative first choice. Lowered to
// exactly that floor (2026-09-17, same day, user asked for a faster
// ramp) — NOT lowered further than this: going below the maintainer's
// explicit recommendation is what reintroduces the stale-telemetry bug
// this constant exists to prevent (see the incident this same day where
// a 10 s-cadence probe validated "confirmed safe" against data that
// couldn't possibly reflect the previous step yet). An earlier version
// of this probe advanced its candidate every 10 s tick regardless of
// whether the cloud had reported on the PREVIOUS step yet — "confirmed
// safe" was frequently just stale data, which both produced a visible
// "Home consumption rising with PV" display artifact (the fast local
// grid meter reacting to real changes the cloud hadn't caught up to) and
// undermined the actual safety property.
const PROBE_MIN_INTERVAL_MS = Number(process.env.PROBE_MIN_INTERVAL_MS ?? 2 * 60 * 1000);
// Hard local safety switch (2026-09-16): a dev instance and production can
// both run against the same real meter/Anker account at once (see AGENTS.md
// dual-control note) — only ONE should ever hold the battery schedule.
// Relying on "just don't call /enable" isn't enough (a copied state file,
// a stray curl, a future automated test could flip it) — when this is set,
// enable() refuses outright, regardless of persisted state or who calls it.
const POWER_PLAN_DISABLE = process.env.POWER_PLAN_DISABLE === "true";

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
    this.trigger = "auto";
    this.manualDischarge = false;
    this.holdingAtCeiling = false; // battery_priority charge/hold latch — see CHARGE_RESUME_HYSTERESIS_PCT
    this.holdProbeW = 0; // battery_priority hold-phase hill-climb state — see PROBE_STEP_W
    this.lastProbeUpAt = 0; // last time the hold-phase probe stepped up — see PROBE_MIN_INTERVAL_MS
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
      // Remap older strategy/trigger models (2026-09-16 had two revisions
      // the same day) onto the current one, so an upgrade never silently
      // lands on an invalid enum value:
      //   - pre-strategy-engine files have no `trigger` at all.
      //   - the short-lived 3-strategy/2-trigger model used
      //     "grid_zero_besteffort" (-> house_priority, which now IS that
      //     behavior) and "pv_zero"/"grid_zero" triggers (-> "auto", the
      //     closest equivalent; "manual" didn't exist yet so it can't be
      //     the right remap target).
      const legacy = saved.trigger === undefined || saved.strategy === "grid_zero_besteffort" ||
        saved.trigger === "pv_zero" || saved.trigger === "grid_zero";
      this.strategy = saved.strategy === "grid_zero_besteffort" ? "house_priority" : (saved.strategy ?? "house_priority");
      this.trigger =
        saved.trigger === "pv_zero" || saved.trigger === "grid_zero" ? "auto" : (saved.trigger ?? "auto");
      this.manualDischarge = saved.manualDischarge ?? false;
      if (this.enabled && legacy) {
        console.log(
          "[power-plan] upgraded: simplified to house_priority/battery_priority + " +
            `auto/manual trigger; remapped to strategy=${this.strategy}, trigger=${this.trigger}`,
        );
      }
    } catch {
      /* no saved state — controller starts disabled */
    }
    if (POWER_PLAN_DISABLE && this.enabled) {
      console.log(
        "[power-plan] POWER_PLAN_DISABLE=true — forcing disabled despite saved state " +
          "(this instance must never write to the real device)",
      );
      this.enabled = false;
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
          manualDischarge: this.manualDischarge,
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

  // Reconcile our belief about the device's current preset against what's
  // ACTUALLY on the device right now (2026-09-16 fix — a real incident, not
  // theoretical: production was stopped for a while, then restarted; the
  // persisted lastWrittenPower (0) was stale relative to the device's real
  // schedule, but tick()'s write-discipline blindly trusted it, computed a
  // matching target (0, correct for battery_priority), saw "no change
  // needed", and never wrote anything — while the device kept discharging
  // hundreds of watts under its actual, unreconciled preset. lastWrittenPower
  // must reflect the DEVICE's truth after any restart/re-enable, not just
  // whatever we last remembered before an unknown gap.
  reconcileWrittenPower(parsed) {
    const actual = parsed?.custom_rate_plan?.[0]?.ranges?.[0]?.power;
    if (typeof actual === "number" && actual !== this.lastWrittenPower) {
      console.log(
        `[power-plan] reconciling: device schedule shows ${actual} W, we remembered ${this.lastWrittenPower} W`,
      );
      this.lastWrittenPower = actual;
      this.saveState();
    }
  }

  // Discharge continuously to cover demand (minus GRID_TARGET_W), regardless
  // of PV level, down to dischargeFloorPct + DISCHARGE_TOLERANCE_PCT. Used
  // by house_priority (always) and by the manual "discharge" toggle.
  dischargeToTarget({ demandW, soc, dischargeFloorPct, max, step }) {
    const effectiveFloor = dischargeFloorPct + DISCHARGE_TOLERANCE_PCT;
    if (soc <= effectiveFloor) return 0;
    return this.roundDown(Math.max(0, Math.min(max, demandW - GRID_TARGET_W)), step);
  }

  // Never ask the battery to discharge: PV (if any) passes straight through
  // to the house, the rest comes from the grid. Used by the manual "don't
  // discharge" toggle only.
  passthroughOnly({ pvW, demandW, soc, dischargeFloorPct, max, step }) {
    if (soc <= dischargeFloorPct) return 0;
    return this.roundDown(Math.min(pvW, demandW, max), step);
  }

  // battery_priority's hold-at-ceiling phase (2026-09-17, fifth same-day
  // revision — see git history for the four rejected earlier attempts:
  // passthroughOnly() [uncapped by GRID_TARGET_W], dischargeToTarget()
  // [drew from the battery whenever PV fell short — rejected],
  // pvOnlyToGridTarget() [capped at raw current PV — self-defeating,
  // caused a stuck-low PV lock], and a first hill-climb draft that
  // advanced its own candidate every 10 s tick regardless of whether a
  // write had even happened yet. That last bug was caught by the user
  // noticing displayed "Home consumption" rising in lockstep with PV —
  // web research (thomluther/anker-solix-api project, Anker's own
  // support docs) confirmed Solarbank 2 only reports fresh telemetry to
  // Anker's cloud every ~5 MINUTES by default (not ~1 min as this file
  // previously assumed) — the maintainer explicitly warns against
  // changing presets faster than every 2 minutes for exactly this
  // reason. A probe advancing every 10 s was validating almost every
  // step against STALE cloud data from before the PREVIOUS step had even
  // been reported, which both produced the visible "Home" display
  // artifact (grid, fast/local, reacting to real changes the cloud
  // hadn't caught up to yet) and undermined the "never touch the
  // battery" safety property itself (a "confirmed safe" reading might
  // just be old data, not a real confirmation).
  //
  // Fix: the probe candidate is now computed FROM lastWrittenPower (what
  // is verifiably, currently active on the device) rather than its own
  // running internal state — so calling this function many times between
  // actual writes recomputes the SAME candidate instead of compounding
  // it. Upward steps are additionally gated by PROBE_MIN_INTERVAL_MS, set
  // well above Anker's documented ~5 min reporting cadence, so each step
  // is validated against telemetry that has had time to actually reflect
  // it. Downward correction remains IMMEDIATE and ungated — "never touch
  // the battery" means any detected discharge is corrected as fast as
  // possible, not paced to match cloud latency.
  computeBatteryPriority({ pvW, demandW, soc, dischargeFloorPct, chargeCeilingPct, max, step, cellsW }) {
    if (soc <= dischargeFloorPct) return 0;
    if (soc >= chargeCeilingPct) {
      this.holdingAtCeiling = true;
    } else if (soc <= chargeCeilingPct - CHARGE_RESUME_HYSTERESIS_PCT) {
      this.holdingAtCeiling = false;
    }
    if (!this.holdingAtCeiling) {
      this.holdProbeW = 0; // start conservative every time we (re)enter hold
      this.lastProbeUpAt = 0;
      if (pvW > 0) return 0; // withhold PV, charge the battery
    }
    const ceilingW = this.roundDown(Math.max(0, demandW - GRID_TARGET_W), step);
    const now = Date.now();
    if (cellsW > 0) {
      // The battery IS being touched right now — drop straight back to
      // what the CURRENTLY ACTIVE preset was actually covering
      // (lastWrittenPower - cellsW, ground truth — not holdProbeW, which
      // may be a not-yet-written candidate), not a fixed small decrement,
      // so a hard PV crash corrects in ONE step. This also counts as
      // "just tested" — don't immediately retry upward.
      this.holdProbeW = Math.max(0, (this.lastWrittenPower ?? this.holdProbeW) - cellsW);
      this.lastProbeUpAt = now;
    } else if (this.holdProbeW < ceilingW && now - this.lastProbeUpAt >= PROBE_MIN_INTERVAL_MS) {
      // Confirmed safe, and enough time has passed since the last probe
      // for the cloud to have actually reported on it — try one step
      // beyond the current candidate.
      this.holdProbeW = Math.min(this.holdProbeW + PROBE_STEP_W, ceilingW);
      this.lastProbeUpAt = now;
    }
    // else: leave holdProbeW UNCHANGED (do not snap back to whatever's
    // currently written) — it must hold steady across ticks for the
    // write-discipline's STEP_UP_HOLD_MS to ever actually see a
    // continuously-elevated target and commit the write at all.
    return this.roundDown(this.holdProbeW, step);
  }

  computeTarget(ctx) {
    const max = this.template?.max_load ?? 800;
    const step = this.template?.step ?? 10;
    const args = { ...ctx, max, step };
    if (ctx.trigger === "manual") {
      return ctx.manualDischarge ? this.dischargeToTarget(args) : this.passthroughOnly(args);
    }
    return ctx.strategy === "battery_priority"
      ? this.computeBatteryPriority(args)
      : this.dischargeToTarget(args); // "house_priority" (default)
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
    // Real (not target-derived) signal for "is the battery actually
    // discharging right now" — see computeBatteryPriority()'s hold-phase
    // comment for why this, and not raw pvW, is what the hold-phase probe
    // must be gated on.
    const { cellsW } = deriveBatteryFlow({ pvW, chargeW: info.chargeW ?? 0, outputW: info.outputW ?? 0 });
    if (demandW == null || soc == null) return;
    if (this.strategy === "anker_app") {
      // Never read, never write — the device runs whatever the user has
      // configured directly in the Anker app. Still surface live numbers
      // in lastDecision for the Strategy tab, just no target/write fields.
      this.lastError = null;
      this.lastDecision = {
        at: Date.now(),
        pvW,
        demandW,
        soc,
        cellsW,
        strategy: this.strategy,
        trigger: this.trigger,
        manualDischarge: this.manualDischarge,
        reason: "anker_app — not writing, device follows its own Anker-app schedule",
      };
      return;
    }
    try {
      if (!this.template) {
        const { parsed, raw } = await this.readSchedule();
        this.template = parsed;
        if (this.enabled && !this.originalRaw) {
          this.originalRaw = raw;
          this.saveState();
        }
        this.reconcileWrittenPower(parsed);
      }
      const { dischargeFloorPct, chargeCeilingPct } = await getBatteryLimits(
        this.anker,
        this.getLiveBattery,
      );
      const targetW = this.computeTarget({
        pvW,
        demandW,
        soc,
        cellsW,
        strategy: this.strategy,
        trigger: this.trigger,
        manualDischarge: this.manualDischarge,
        dischargeFloorPct,
        chargeCeilingPct,
      });
      const now = Date.now();
      const cur = this.lastWrittenPower;
      let shouldWrite = false;
      let reason = "within deadband";
      let holdProgress = null; // {heldMs, totalMs} while waiting out the step-up hold
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
        // Step up only after the target has stayed ABOVE cur continuously —
        // NOT after it's been the exact same value continuously. targetW is
        // demandW-derived and fluctuates with real house load essentially
        // every tick, so requiring an exact match (2026-09-16 bug) reset
        // this timer almost every tick and could never reach STEP_UP_HOLD_MS
        // — the preset silently never stepped up at all. The hold only
        // needs to survive a target that wobbles ACROSS the cur boundary
        // (the documented intent — see the file header's PV-wobble
        // simulation note), not one that merely changes magnitude while
        // staying above it.
        if (!this.pendingUp) {
          this.pendingUp = { since: now };
        }
        const heldMs = now - this.pendingUp.since;
        const heldS = Math.round(heldMs / 1000);
        if (targetW - cur >= WRITE_MIN_DELTA_W && heldMs >= STEP_UP_HOLD_MS) {
          shouldWrite = true;
          reason = `step up (held ${heldS}s)`;
        } else {
          reason = `holding up-step (${heldS}s/${STEP_UP_HOLD_MS / 1000}s)`;
          if (targetW - cur >= WRITE_MIN_DELTA_W) {
            holdProgress = { heldMs: Math.max(0, heldMs), totalMs: STEP_UP_HOLD_MS };
          }
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
        cellsW,
        strategy: this.strategy,
        trigger: this.trigger,
        manualDischarge: this.manualDischarge,
        gridTargetW: GRID_TARGET_W,
        dischargeTolerancePct: DISCHARGE_TOLERANCE_PCT,
        targetW,
        wrote,
        reason,
        holdProgress,
        dischargeFloorPct,
        chargeCeilingPct,
        atChargeCeiling: soc >= chargeCeilingPct,
        holdingAtCeiling: this.holdingAtCeiling,
        holdProbeW: this.holdProbeW,
      };
    } catch (err) {
      this.lastError = err.message;
      console.warn(`[power-plan] tick failed: ${err.message}`);
    }
  }

  async enable() {
    if (POWER_PLAN_DISABLE) {
      throw new Error(
        "power plan is disabled on this instance (POWER_PLAN_DISABLE=true) — " +
          "this is likely a dev/secondary instance; enable it only on the primary",
      );
    }
    const { raw, parsed } = await this.readSchedule();
    if (!this.originalRaw) this.originalRaw = raw;
    this.template = parsed;
    this.enabled = true;
    this.lastWriteAt = 0; // force an immediate write on next tick
    this.reconcileWrittenPower(parsed); // don't trust a stale belief across a disable/gap
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
  setStrategy({ strategy, trigger, manualDischarge } = {}) {
    if (strategy !== undefined) {
      if (strategy !== this.strategy && (strategy === "anker_app" || this.strategy === "anker_app")) {
        // Entering or leaving anker_app: the device's real preset may have
        // changed independently (the user editing it directly in the Anker
        // app) without this controller ever knowing. Force the next active
        // tick to re-read the schedule and reconcile lastWrittenPower
        // against reality instead of trusting a now-possibly-stale belief.
        this.template = null;
      }
      this.strategy = strategy;
    }
    if (trigger !== undefined) this.trigger = trigger;
    if (manualDischarge !== undefined) this.manualDischarge = manualDischarge;
    this.saveState();
  }

  getState() {
    return {
      enabled: this.enabled,
      canRestore: this.originalRaw != null,
      strategy: this.strategy,
      trigger: this.trigger,
      manualDischarge: this.manualDischarge,
      gridTargetW: GRID_TARGET_W,
      dischargeTolerancePct: DISCHARGE_TOLERANCE_PCT,
      lastWrittenPower: this.lastWrittenPower,
      lastWriteAt: this.lastWriteAt || null,
      lastError: this.lastError,
      lastDecision: this.lastDecision,
    };
  }
}
