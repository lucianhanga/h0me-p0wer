// Garmin Connect IQ watch app ("Home Power", repo h0me-p0wer-garmin) status
// route — see WATCH.readme at the repo root for the full spec this
// implements. A thin response-shaping layer: no new data collection,
// storage, or polling, just reshaping values already flowing through
// computeFlowPayload() (live) and /api/stats/overview (today's totals) into
// the flat contract the watch expects. GET /api/watch/status returns the
// bare object directly — NOT the { ok, data } envelope every other endpoint
// uses — the watch app merges whatever arrives onto cached defaults, so
// partial data beats no endpoint: every step below is best-effort and a
// failure anywhere still falls through to whatever fields were resolved.

import { fetchJson } from "./welcome-sources.js";
import { deriveBatteryFlow } from "./battery-params.js";

const w2kw = (w) => (w == null ? null : Math.round((w / 1000) * 100) / 100);

// Minutes until the account's charge ceiling at the current charge rate —
// same arithmetic the React frontend's battery ETA does client-side (see
// batteryEta.js), done here server-side since the watch has no JS runtime
// of its own to run it in. null while idle/discharging or already at
// ceiling (the watch merges onto its cached default rather than showing a
// stale number).
function minutesToFull(battery) {
  if (!battery) return null;
  const { soc, maxPct, capacityKwh, charge } = battery;
  if (soc == null || maxPct == null || !(capacityKwh > 0) || !(charge > 0)) return null;
  if (soc >= maxPct) return 0;
  const kwhNeeded = ((maxPct - soc) / 100) * capacityKwh;
  return Math.round((kwhNeeded / (charge / 1000)) * 60);
}

// Minutes until the account's (effective) discharge floor at the current
// discharge rate — the mirror image of minutesToFull, for the Garmin
// watch's Battery page ("time until empty" while discharging). Uses
// `floorPct` (the EFFECTIVE floor including the controller's safety
// margin — see its own comment in index.js) and `cells` (pure discharge
// to the house, excluding PV pass-through — the same field the Live
// tab's charge/discharge tile uses), not `outputW`/`discharge`. null
// while idle/charging or already at the floor.
function minutesToEmpty(battery) {
  if (!battery) return null;
  const { soc, floorPct, capacityKwh, cells } = battery;
  if (soc == null || floorPct == null || !(capacityKwh > 0) || !(cells > 0)) return null;
  if (soc <= floorPct) return 0;
  const kwhAvailable = ((soc - floorPct) / 100) * capacityKwh;
  return Math.round((kwhAvailable / (cells / 1000)) * 60);
}

// Today's solar/home/grid power as hourly averages, from local midnight up
// to now — display-only, but the Garmin app's Solar page plots these on a
// fixed 0h-24h x-axis (left edge = midnight, a pulsing dot at "now"), so
// the array has to actually start at midnight rather than some trailing
// window, or the graph stretches a partial-day slice across the whole
// axis and looks wrong (empty for most of the day, bunched up wherever
// the real samples landed). Reuses /api/timeseries (internal loopback
// call, same pattern as the stats-overview reuse below) rather than
// re-querying the DB directly: it already merges local Modbus samples
// with cloud day-trend fallback for BOTH grid and PV (the local `solar`
// column has no such fallback — `pv` does, so that's the field used
// here), which a from-scratch query would have to reimplement to stay
// correct when Modbus is down.
//
// homeFromGridHistory/homeFromBatteryHistory split `home` into its two
// non-solar sources for the watch's stacked-bar Home page (grid at the
// base, battery cells in the middle, PV→home as the remainder on top —
// the watch derives that remainder itself as
// home[i] - homeFromGrid[i] - homeFromBattery[i], no need to send it).
// Uses the SAME pvToHome/cells split deriveBatteryFlow does everywhere
// else in this backend (battery-params.js) — NOT a fresh approximation —
// so a bucket's `battOut` (which includes PV pass-through) doesn't double
// book that pass-through as "battery" on top of the separate PV figure.
const HISTORY_BUCKET_MS = 3600 * 1000; // 1 h buckets — up to ~24 points/day

async function recentHistory(timeseriesUrl) {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const from = todayStart.getTime();
  // `bucket`, not `points` — /api/timeseries clamps `points` to a minimum
  // of 50 (sized for its pan/zoom chart use), which would silently ignore
  // a request for a day's worth of hourly sparkline points. `bucket` sets
  // the bucket size directly instead.
  const url = `${timeseriesUrl}?from=${from}&to=${now}&bucket=${HISTORY_BUCKET_MS}`;
  const res = await fetchJson(url);
  const points = res?.data ?? [];
  const solarHistory = [];
  const solarBatteryHistory = [];
  const homeHistory = [];
  const homeFromGridHistory = [];
  const homeFromBatteryHistory = [];
  const gridHistory = [];
  for (const p of points) {
    const pvW = p.pv ?? 0;
    const chargeW = p.battChg ?? 0;
    const outputW = p.battOut ?? 0;
    const gridW = p.grid ?? 0;
    const { pvToHome, cellsW } = deriveBatteryFlow({ pvW, chargeW, outputW });
    const gridToHomeW = Math.max(gridW, 0);

    solarHistory.push(w2kw(pvW) ?? 0);
    solarBatteryHistory.push(w2kw(chargeW) ?? 0);
    gridHistory.push(w2kw(gridW) ?? 0);
    homeFromGridHistory.push(w2kw(gridToHomeW) ?? 0);
    homeFromBatteryHistory.push(w2kw(cellsW) ?? 0);
    homeHistory.push(w2kw(gridToHomeW + cellsW + pvToHome) ?? 0);
  }
  return {
    solarHistory,
    solarBatteryHistory,
    homeHistory,
    homeFromGridHistory,
    homeFromBatteryHistory,
    gridHistory,
  };
}

export function registerWatchRoute(app, deps) {
  app.get("/api/watch/status", async (req, res) => {
    const out = {};
    try {
      const flow = await deps.getFlowPayload();
      const battery = flow?.battery;
      // Signed grid (positive = importing, negative = exporting) — same
      // convention /api/flow's diagram uses, reconstructed from the
      // already-split import/export the payload returns (do not flip it).
      const gridW =
        flow?.grid?.import != null || flow?.grid?.export != null
          ? (flow.grid.import ?? 0) - (flow.grid.export ?? 0)
          : null;
      // Net battery power (positive = charging) — charge minus the actual
      // cells discharge (NOT outputW, which also carries PV pass-through;
      // same `cells` field the Live tab's charge/discharge tile uses).
      const batteryPowerW =
        battery?.charge != null || battery?.cells != null
          ? (battery?.charge ?? 0) - (battery?.cells ?? 0)
          : null;
      Object.assign(out, {
        solar: w2kw(flow?.pv?.production),
        home: w2kw(flow?.home?.consumption),
        grid: w2kw(gridW),
        // Already the SYSTEM-wide aggregate, not one unit's reading —
        // battery.soc comes from Anker's site-level total_battery_power
        // (see recomputeAggregate()'s comment in index.js), and
        // capacityKwh is systemCapacityKwh()'s sum over every unit/pack.
        battery: battery?.soc ?? null,
        batteryPower: w2kw(batteryPowerW),
        batteryCapacity: battery?.capacityKwh ?? null,
        batteryMinutesToFull: minutesToFull(battery),
        batteryMinutesToEmpty: minutesToEmpty(battery),
        // Low/high SOC thresholds for the watch's fill-bar markers (the
        // SAME effective floor/ceiling the account and the power-plan
        // controller use elsewhere in this backend — see the comment on
        // `floorPct` in index.js).
        batteryFloorPct: battery?.floorPct ?? null,
        batteryMaxPct: battery?.maxPct ?? null,
      });
    } catch (err) {
      console.warn(`[watch] live flow failed (${err.message})`);
    }

    try {
      // Internal loopback call, same process (see welcome.js/daybrief.js
      // for the same pattern) — reuses /api/stats/overview's existing,
      // gap-handling-heavy today computation rather than re-deriving it.
      const overview = await fetchJson(deps.statsOverviewUrl).catch(() => null);
      const flows = overview?.data?.flows;
      const today = overview?.data?.byPeriod?.today;
      const costs = overview?.data?.costs;
      // homeToday/exportedToday/importedToday read from `flows` — verified
      // against `today` (gridKwh/exportKwh/homeKwh) to be the exact same
      // values, just differently named, so either source works for those.
      //
      // solarDirectToday/batteryDischargedToday/batteryChargedToday MUST
      // come from `today`, not `flows` — they are NOT interchangeable
      // there, despite the similar names (a bug previously, fixed here to
      // match the web app's own Dashboard.jsx, which reads this same
      // `byPeriod.today` object):
      //   - flows.pvKwh is TOTAL production (identical to
      //     today.pvProducedKwh) — NOT PV-direct-to-home. today.pvKwh is
      //     the real direct-to-home figure, derived from pvToHomeKwh.
      //   - flows.battDischargedKwh is the inverter's RAW discharge,
      //     which still includes PV pass-through — double-counting that
      //     pass-through against the separate PV figure above.
      //     today.battKwh is cells-only (dischargedKwh − pvToHomeKwh),
      //     the figure that actually sums with grid/PV to ~homeKwh.
      //   - flows.battChargedKwh vs today.battInKwh differ by small gap-
      //     backfill rounding; today.battInKwh is what Dashboard.jsx
      //     actually reads for "to battery," so use that for parity.
      Object.assign(out, {
        solarToday: today?.pvProducedKwh ?? null,
        solarDirectToday: today?.pvKwh ?? null,
        homeToday: flows?.homeKwh ?? null,
        exportedToday: flows?.gridExportKwh ?? null,
        importedToday: flows?.gridImportKwh ?? null,
        batteryDischargedToday: today?.battKwh ?? null,
        batteryChargedToday: today?.battInKwh ?? null,
        spentToday: costs?.today ?? null,
        savedToday: costs?.batterySavingsToday ?? null,
      });
    } catch (err) {
      console.warn(`[watch] stats-overview fetch failed (${err.message})`);
    }

    try {
      Object.assign(out, await recentHistory(deps.timeseriesUrl));
    } catch (err) {
      console.warn(`[watch] timeseries fetch failed (${err.message})`);
    }

    res.json(out);
  });
}
