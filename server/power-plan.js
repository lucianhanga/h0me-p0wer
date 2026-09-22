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
//   house_priority   -> (the default) the device's NATIVE self-consumption
//                        mode (schedule mode_type 1 = smartmeter,
//                        community-verified SolarbankUsageMode: "AC output
//                        based on measured smart meter power") — exactly the
//                        Anker app's Self-Consumption Mode (2026-09-22, user
//                        request: "behave exactly like the Anker app"). The
//                        device follows house demand LOCALLY, sub-second,
//                        zero export; this controller writes the mode once,
//                        re-verifies it periodically, and otherwise only
//                        monitors. GRID_TARGET_W / discharge floor margins /
//                        the export watchdog don't apply in this mode — the
//                        device's own Anker-app SOC cutoffs are enforced
//                        locally. The MANUAL discharge trigger and
//                        battery_priority still use the preset path below
//                        (dischargeToTarget() etc.).
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
// Grid target (GRID_TARGET_W env var, default 25 W — lowered from 100,
// 2026-09-21 user request) and discharge tolerance
// (DISCHARGE_TOLERANCE_PCT env var, default 3 points — lowered
// from 4, 2026-09-19 user request: "the defined SOC + 3%") are BOTH
// deployment-time constants, not user-adjustable at runtime (like
// TARIFF_EUR_PER_KWH elsewhere in this codebase) — not exposed in the
// Strategy tab UI, by request, to keep the UI to just the two dropdowns +
// the manual toggle. dischargeToTarget() leaves demandW - GRID_TARGET_W for
// PV+battery to cover (the ask is "keep grid supply around 25 W",
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
// these aren't runtime/UI-adjustable. GRID_TARGET_W is exported so
// stats.js's gridTracking metrics use the exact same number the
// controller aims for, not a second copy.
export const GRID_TARGET_W = Number(process.env.GRID_TARGET_W ?? 25);
const DISCHARGE_TOLERANCE_PCT = Number(process.env.DISCHARGE_TOLERANCE_PCT ?? 3);
// Discharge/hold hysteresis for house_priority (2026-09-21, identified
// before it hit production — same failure mode as CHARGE_RESUME_HYSTERESIS_PCT
// below, just on the floor instead of the ceiling: the unit's own standby/
// BMS draw, or a brief PV dip, nudges SOC across a BARE floor threshold
// back and forth, snapping the preset between full discharge and 0 every
// time. Once the floor is hit, hold PV-passthrough-only mode (see
// dischargeToTarget()) until SOC has climbed this many points back above
// the floor, not just 1.
const DISCHARGE_RESUME_HYSTERESIS_PCT = Number(process.env.DISCHARGE_RESUME_HYSTERESIS_PCT ?? 3);
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
// Export watchdog (2026-09-22, user request: "I don't want to push power
// into the grid — ramp down fast if I start exporting"). The strategy
// target is computed from ESTIMATED demand (despiked, partly cloud-lagged)
// and structurally cannot see export at all: index.js's
// refreshHomeConsumption() clamps negative grid to 0, so while the device
// overshoots, demandW keeps reading ~the OLD demand until cloud telemetry
// catches up (~1 min typical, up to ~5). Only the local meter sees real
// export, within ~5 s — when it does, cut the preset by exactly the
// exported amount plus GRID_TARGET_W (landing grid ON the target, not at
// 0). EXPORT_RECORRECT_MS ≈ the device's apply lag: re-correcting against
// a grid reading that still reflects the PREVIOUS preset would subtract
// the same export twice (double-correction). cloud-live grid is excluded
// on purpose: it's import-minus-PV-feed-in and can never report battery
// overshoot as negative — only the meter sees true export.
const EXPORT_CORRECT_MIN_W = Number(process.env.EXPORT_CORRECT_MIN_W ?? 20);
const EXPORT_RECORRECT_MS = 60 * 1000;
const EXPORT_WRITE_GAP_MS = 15 * 1000;
// Solarbank 2 usage mode for native Self-Consumption (2026-09-22, user
// request: "House priority should behave exactly like the Anker app's
// Self-Consumption Mode — use the app's setting directly if there is one").
// There is: community-verified SolarbankUsageMode — schedule mode_type 1
// (smartmeter) = "AC output based on measured smart meter power". The
// device then follows house demand LOCALLY against the Smart Meter,
// sub-second, zero export — no cloud-preset loop can match that (~1 min
// floor, see the export-watchdog entry). 3 = manual preset schedule (what
// the preset path writes); 5/7/8 = TOU / AI-EMS / dynamic-tariff.
const NATIVE_SELF_CONSUMPTION_MODE = 1;
// How long reverse-direction changes are suppressed after a write — the
// demand estimate is unreliable until the device+cloud have reflected the
// new preset: INFLATED by cloud-lagged outputW after a down-write (would
// falsely re-raise the preset — see tick()'s settling guard), DEFLATED
// after an up-write (would falsely step back down). Must cover apply lag
// (~60 s) + reporting lag (~30 s) + the median-of-3 despike (2 ticks) —
// 90 s was caught one tick short by the simulation (guard lifted exactly
// as the despike still held the stale value). Export corrections are
// exempt — export is wasted energy NOW and must always correct
// immediately.
const SETTLE_AFTER_WRITE_MS = 120 * 1000;
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
    this.holdingAtFloor = false; // house_priority discharge/hold latch — see DISCHARGE_RESUME_HYSTERESIS_PCT
    this.lastWriteDown = false; // last write direction — see SETTLE_AFTER_WRITE_MS
    this.nativeMode = false; // device confirmed in native self-consumption (mode_type 1)
    this.lastScheduleReadAt = 0; // last time the schedule was (re-)read from the cloud
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
    // In native self-consumption (mode_type 1) the custom-rate-plan value is
    // dormant — the device follows the smart meter, not the plan — so there
    // is nothing to reconcile against (2026-09-22).
    if (parsed?.mode_type === NATIVE_SELF_CONSUMPTION_MODE) return;
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
  //
  // Floor/resume hysteresis (2026-09-21, caught before it hit production —
  // same failure mode CHARGE_RESUME_HYSTERESIS_PCT already fixed on the
  // ceiling side, see that constant's comment for the real incident it
  // mirrors): a bare `soc <= effectiveFloor` check would let the unit's own
  // standby draw, or a brief PV dip, tick SOC back and forth across the
  // floor, snapping the preset between full discharge and 0 every time.
  // Once the floor is hit, stay in floor mode until SOC has climbed
  // DISCHARGE_RESUME_HYSTERESIS_PCT points back above it, not just 1.
  //
  // Floor mode is passthroughOnly(), not a hard 0: this function's return
  // value is the Solarbank's single inverter-output preset, sourced from
  // EITHER PV or cells by the device itself — a hard 0 would block
  // legitimate free PV pass-through too, forcing 100% grid draw even when
  // PV alone could already cover some or all of demand without ever
  // touching the battery.
  dischargeToTarget(args) {
    const { soc, dischargeFloorPct, demandW, max, step } = args;
    const effectiveFloor = dischargeFloorPct + DISCHARGE_TOLERANCE_PCT;
    if (soc <= effectiveFloor) {
      this.holdingAtFloor = true;
    } else if (soc >= effectiveFloor + DISCHARGE_RESUME_HYSTERESIS_PCT) {
      this.holdingAtFloor = false;
    }
    if (this.holdingAtFloor) return this.passthroughOnly(args);
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
        exportW: info.gridSource === "meter" && info.gridW != null ? Math.min(0, info.gridW) : 0,
        strategy: this.strategy,
        trigger: this.trigger,
        manualDischarge: this.manualDischarge,
        reason: "anker_app — not writing, device follows its own Anker-app schedule",
      };
      return;
    }
    // house_priority + auto trigger = the device's NATIVE self-consumption
    // mode (schedule mode_type 1 — see the constant's comment above). The
    // device regulates locally, so this branch only ensures the mode is set
    // (written once, re-verified every REFRESH_MS in case it was changed in
    // the Anker app) and then just monitors — no preset writes, no watchdog
    // (zero export is enforced on-device), no GRID_TARGET_W / floor margin
    // (the device's own Anker-app SOC cutoffs apply instead). The manual
    // trigger is preset-based by nature and bypasses this branch entirely.
    if (this.strategy === "house_priority" && this.trigger === "auto") {
      try {
        const now = Date.now();
        if (!this.template || now - this.lastScheduleReadAt >= REFRESH_MS) {
          const { parsed, raw } = await this.readSchedule();
          this.template = parsed;
          this.lastScheduleReadAt = now;
          if (this.enabled && !this.originalRaw) {
            this.originalRaw = raw;
            this.saveState();
          }
        }
        let wrote = false;
        let reason = "native self-consumption — device follows the smart meter locally, no preset writes";
        if (this.template?.mode_type !== NATIVE_SELF_CONSUMPTION_MODE) {
          if (now - this.lastWriteAt >= MIN_WRITE_GAP_MS) {
            await this.writeSchedule({ ...this.template, mode_type: NATIVE_SELF_CONSUMPTION_MODE });
            this.lastWriteAt = now;
            wrote = true;
            this.template = null; // re-read next tick to confirm the mode landed
            this.lastScheduleReadAt = 0;
            reason = "switched the device to native self-consumption (mode_type=1)";
            console.log("[power-plan] house_priority: wrote mode_type=1 (native self-consumption)");
          } else {
            reason = "switching to native self-consumption — waiting (min write gap)";
          }
        } else {
          this.nativeMode = true;
        }
        this.lastError = null;
        this.lastDecision = {
          at: now,
          pvW,
          demandW,
          soc,
          cellsW,
          exportW: info.gridSource === "meter" && info.gridW != null ? Math.min(0, info.gridW) : 0,
          strategy: this.strategy,
          trigger: this.trigger,
          manualDischarge: this.manualDischarge,
          nativeMode: true, // this decision came from the native path
          wrote,
          reason,
        };
        return;
      } catch (err) {
        this.lastError = err.message;
        console.warn(`[power-plan] tick failed: ${err.message}`);
        return;
      }
    }
    try {
      if (this.nativeMode) {
        // Leaving native self-consumption: force a fresh schedule read and an
        // unconditional preset write — lastWrittenPower refers to a dormant
        // custom-rate-plan value the device wasn't following while in mode 1.
        this.nativeMode = false;
        this.lastWrittenPower = null;
        this.template = null;
      }
      if (!this.template) {
        const { parsed, raw } = await this.readSchedule();
        this.template = parsed;
        this.lastScheduleReadAt = Date.now();
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
      let targetW = this.computeTarget({
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
      // Export watchdog — see the constants' comment above for the full
      // reasoning. Meter-sourced only; cut by exactly the exported amount
      // plus GRID_TARGET_W, never above the strategy's own target.
      const exportW =
        info.gridSource === "meter" && info.gridW != null ? Math.min(0, info.gridW) : 0;
      let exportCorrection = false;
      if (
        exportW <= -EXPORT_CORRECT_MIN_W &&
        cur != null &&
        now - this.lastWriteAt >= EXPORT_RECORRECT_MS
      ) {
        const step = this.template?.step ?? 10;
        const cut = this.roundDown(Math.max(0, cur + exportW - GRID_TARGET_W), step);
        if (cut < targetW) {
          targetW = cut;
          exportCorrection = true;
        }
      }
      let shouldWrite = false;
      let reason = "within deadband";
      let holdProgress = null; // {heldMs, totalMs} while waiting out the step-up hold
      if (cur == null) {
        shouldWrite = true;
        reason = "initial";
      } else if (targetW < cur) {
        // Step down promptly (preset above PV burns the battery). An active
        // export correction tightens the deadband — export is wasted energy
        // NOW, not a drift to smooth out.
        //
        // Settling guard (symmetric to the up-side one below, caught by the
        // same simulation): right after a step-UP write, demandW is
        // DEFLATED by the cloud-lagged outputW (still reporting the OLD,
        // lower output) — the difference shows up as grid import instead.
        // Acting on it steps straight back down and oscillates (sim: up at
        // t=400, false down at t=470, repeat). Suppress reverse direction
        // until the device+cloud reflect the write; export corrections stay
        // exempt.
        this.pendingUp = null;
        const minDelta = exportCorrection ? EXPORT_CORRECT_MIN_W : WRITE_MIN_DELTA_W;
        if (
          !exportCorrection &&
          this.lastWriteDown === false &&
          this.lastWriteAt > 0 &&
          now - this.lastWriteAt < SETTLE_AFTER_WRITE_MS
        ) {
          reason = `settling after step up (${Math.round((now - this.lastWriteAt) / 1000)}s/${SETTLE_AFTER_WRITE_MS / 1000}s)`;
        } else if (cur - targetW >= minDelta) {
          shouldWrite = true;
          reason = exportCorrection ? `export correction (${exportW} W)` : "step down";
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
        //
        // Settling guard (2026-09-22, caught by the export-watchdog
        // simulation): right after a step-DOWN write, demandW is inflated
        // by the cloud-lagged outputW (it still reports the OLD, higher
        // output — the meter-preferred formula max(grid,0)+outputW can't
        // tell consumption from export). A demand estimate inflated by the
        // just-removed output pushes the target back ABOVE the corrected
        // preset, and the 90 s hold can complete BEFORE the cloud catches
        // up (sim: hold reached 80s/90s, 10 s from a false re-raise that
        // would have recreated the export the watchdog just fixed). Don't
        // accumulate hold time until the device+cloud have had time to
        // reflect the last down-write.
        if (this.lastWriteDown && now - this.lastWriteAt < SETTLE_AFTER_WRITE_MS) {
          this.pendingUp = null;
          reason = `settling after step down (${Math.round((now - this.lastWriteAt) / 1000)}s/${SETTLE_AFTER_WRITE_MS / 1000}s)`;
        } else {
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
        }
      } else {
        this.pendingUp = null;
      }
      let wrote = false;
      if (shouldWrite) {
        const writeGap = exportCorrection ? EXPORT_WRITE_GAP_MS : MIN_WRITE_GAP_MS;
        if (now - this.lastWriteAt >= writeGap) {
          const body = this.buildPresetSchedule(targetW);
          await this.writeSchedule(body);
          // Keep the cache truthful: the device now holds exactly this
          // schedule (mode_type 3 included) — a stale cached template would
          // mislead the native-mode check if the strategy flips back to
          // house_priority before the next re-read (sim-verified 2026-09-22).
          this.template = body;
          this.lastScheduleReadAt = now;
          this.lastWriteDown = targetW < cur; // cur == null handled above (initial)
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
        dischargeResumeHysteresisPct: DISCHARGE_RESUME_HYSTERESIS_PCT,
        holdingAtFloor: this.holdingAtFloor,
        exportW,
        exportCorrection,
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
