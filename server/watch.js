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

// Last HISTORY_HOURS of solar/home/grid power as hourly averages —
// display-only sparklines for the watch (any reasonable number of recent
// points works, per WATCH.readme). Reuses /api/timeseries
// (internal loopback call, same pattern as the stats-overview reuse below)
// rather than re-querying the DB directly: it already merges local Modbus
// samples with cloud day-trend fallback for BOTH grid and PV (the local
// `solar` column has no such fallback — `pv` does, so that's the field
// used here), which a from-scratch query would have to reimplement to
// stay correct when Modbus is down. Home has no direct column anywhere, so
// it's reconstructed the same way computeFlowPayload's own meter-fallback
// does elsewhere in this backend: max(grid, 0) + battery output.
const HISTORY_HOURS = 8;
const HISTORY_BUCKET_MS = 3600 * 1000; // 1 h buckets — ~HISTORY_HOURS+1 points

async function recentHistory(timeseriesUrl) {
  const now = Date.now();
  const from = now - HISTORY_HOURS * HISTORY_BUCKET_MS;
  // `bucket`, not `points` — /api/timeseries clamps `points` to a minimum
  // of 50 (sized for its pan/zoom chart use), which would silently ignore
  // a request for just 8-9 sparkline points. `bucket` sets the bucket size
  // directly instead.
  const url = `${timeseriesUrl}?from=${from}&to=${now}&bucket=${HISTORY_BUCKET_MS}`;
  const res = await fetchJson(url);
  const points = res?.data ?? [];
  const solarHistory = [];
  const homeHistory = [];
  const gridHistory = [];
  for (const p of points) {
    solarHistory.push(w2kw(p.pv) ?? 0);
    gridHistory.push(w2kw(p.grid) ?? 0);
    homeHistory.push(w2kw(Math.max(p.grid ?? 0, 0) + (p.battOut ?? 0)) ?? 0);
  }
  return { solarHistory, homeHistory, gridHistory };
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
        battery: battery?.soc ?? null,
        batteryPower: w2kw(batteryPowerW),
        batteryCapacity: battery?.capacityKwh ?? null,
        batteryMinutesToFull: minutesToFull(battery),
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
      // pvProducedKwh (byPeriod.today), not flows.pvKwh — flows.pvKwh is
      // PV-direct-to-home only; the watch's `solar`/`solarToday` pair both
      // want TOTAL production (see WATCH.readme).
      const pvProducedKwh = overview?.data?.byPeriod?.today?.pvProducedKwh;
      Object.assign(out, {
        solarToday: pvProducedKwh ?? null,
        homeToday: flows?.homeKwh ?? null,
        exportedToday: flows?.gridExportKwh ?? null,
        importedToday: flows?.gridImportKwh ?? null,
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
