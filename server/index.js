// MUST be the first import — see env.js for why (ES module import
// hoisting means this has to run before power-plan.js/anker-cloud.js/etc.
// are evaluated, not just before this file's OWN body runs).
import "./env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { MeterPoller } from "./modbus.js";
import { AnkerClient, AnkerApiError } from "./anker-cloud.js";
import { AnkerMqtt } from "./mqtt.js";
import { registerWelcomeRoute } from "./welcome.js";
import { registerRoiRoute } from "./roi.js";
import { registerBatteryParamsRoute, deriveBatteryFlow } from "./battery-params.js";
import { pvKwhForDay } from "./welcome-ai.js";
import { PowerPlanController } from "./power-plan.js";
import { savedEur } from "./savings.js";
import {
  saveSnapshot,
  pruneOld,
  getHistory,
  saveCloudTrend,
  getCloudTrend,
  getStoredPeriodStarts,
  getSnapshotBuckets,
  getCloudDayPower,
  getSnapshotRows,
  getAnyDeviceSn,
  getBatterySn,
  getEarliestCloudDay,
  saveBatterySnapshot,
  getLatestBattery,
  getBatteryHistory,
  getPvStringKwhForDay,
  integrateBatteryEnergy,
  saveCloudPvTrend,
  getCloudPvDayPower,
  getStoredPvPeriodStarts,
  sumCloudEnergyInGaps,
  pruneBattery,
  savePvDaily,
  getPvDaily,
  getPvDailyDates,
  saveCloudGridSnapshot,
  getCloudGridRows,
  pruneCloudGrid,
} from "./db.js";

const PORT = Number(process.env.PORT ?? 3001);
const METER_IP = process.env.METER_IP ?? "192.168.1.102";
const METER_PORT = Number(process.env.METER_PORT ?? 502);

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(SERVER_DIR, "..", "web", "dist");

// Cloud period dates are interpreted by Anker as ACCOUNT-LOCAL days, so they
// must come from local components — toISOString() is UTC and shifts the day
// for the first 1–2 h after local midnight.
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const poller = new MeterPoller(METER_IP, METER_PORT, {
  // POLL_INTERVAL_MS: poll cadence (default 5000). MODBUS_TRANSIENT=true:
  // connect-read-disconnect per cycle so two instances can share the meter.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  transient: process.env.MODBUS_TRANSIENT === "true",
});
// CLOUD_ENABLED=false runs meter-only: no Anker login attempts at all
// (credentials stay in .env for when the throttle clears).
const cloudEnabled = process.env.CLOUD_ENABLED !== "false";
const anker = new AnkerClient(
  cloudEnabled ? process.env.ANKER_EMAIL : "",
  cloudEnabled ? process.env.ANKER_PASSWORD : "",
  process.env.ANKER_COUNTRY ?? "DE",
);

const app = express();
app.use(express.json());

app.get("/api/live", (req, res) => {
  const state = poller.getState();
  // Modbus down: attach the shared grid fallback so the UI shows the SAME
  // cloud value as /api/flow (source: cloud-live → live scen_info, cloud →
  // newest closed 20-min interval).
  if (!state.snapshot) {
    const gl = getGridLive();
    if (gl.power != null) state.cloud = gl;
  }
  res.json(state);
});

// Connectivity health for the Live tab badges.
app.get("/api/health", (req, res) => {
  const batt = latestBattery ?? getLatestBattery();
  res.json({
    ok: true,
    data: {
      meterDirect: poller.getState().connected, // Modbus TCP healthy
      cloud: { enabled: anker.configured, lastOkAt: lastCloudOkAt },
      battery: { lastTs: batt?.ts ?? null },
    },
  });
});

// Latest battery (Solarbank) status: memory first, DB fallback.
app.get("/api/battery/live", (req, res) => {
  res.json({ ok: true, data: latestBattery ?? getLatestBattery() });
});

// Computed power flows between grid / battery / PV / home.
// Model (validated against live data 2026-09-13): the Solarbank's
// output_power is the inverter's TOTAL AC output to the house — PV
// pass-through is already inside it (its own to_home field ≈ output_power).
// So: bank→home = outputW (never plus pvW), and PV-to-home only exists when
// the inverter is actually outputting. The old `pvToHome = pvW − chargeW`
// double-counted PV and invented a PV→home flow while the bank was charging.
// Newest CLOSED 20-min cloud interval for today (grid total W) — the
// fallback source when the meter's Modbus server is unreachable.
// (Snapshot freshness itself is enforced in MeterPoller.getState — a stale
// snapshot is nulled there, which is what triggers this fallback.)
function getCloudGridLive() {
  const sn = poller.snapshot?.meter?.sn ?? getAnyDeviceSn();
  if (!sn) return null;
  const CLOUD_INTERVAL_MS = 20 * 60 * 1000;
  const rows = getCloudDayPower(sn, localDate(), localDate());
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.power == null) continue;
    if (r.ts + CLOUD_INTERVAL_MS > Date.now()) continue; // interval still open
    return { power: r.power, ts: r.ts + CLOUD_INTERVAL_MS };
  }
  return null;
}

// Persist PV energy for the last finished day (raw samples live only 48 h).
// Recompute YESTERDAY only — it is always fully inside the retention window.
// Recomputing older days would overwrite good full-day rows with shrinking
// partial ones as their early samples get pruned (and before the
// getBatteryHistory end-bound fix it also leaked later days into them).
function rollupPvDaily() {
  const today = localDate();
  const dateStr = localDate(new Date(Date.now() - 86400000));
  if (dateStr >= today) return;
  const v = pvKwhForDay(dateStr);
  savePvDaily(dateStr, v.produced, v.toHome, v.toBatt);
}

// Monday (local midnight) of the calendar week containing d.
function mondayOf(d) {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

// Bucket 20-min {ts, power} cloud rows (getCloudDayPower/getCloudPvDayPower
// shape) into a 24-length hourly kWh array (local hours 0-23), clamping
// negative (export) power to 0 — shared by the "day" tile's current-day and
// past-day flip-side bars so both use the same hour buckets.
function hourlyKwhFromRows(rows) {
  const sums = new Array(24).fill(0);
  for (const r of rows) {
    if (r.power == null) continue;
    const hour = new Date(r.ts).getHours();
    if (hour < 0 || hour > 23) continue;
    sums[hour] += (Math.max(r.power, 0) * (20 / 60)) / 1000;
  }
  return sums;
}

// Stored PV totals over a date range (finished days only; today is added
// live by the caller).
function pvStoredTotals(fromDate, toDate) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const today = localDate();
  let produced = 0;
  let toHome = 0;
  let toBatt = 0;
  for (const r of getPvDaily(fromDate, toDate)) {
    if (r.date >= today) continue;
    produced += r.produced;
    toHome += r.to_home;
    toBatt += r.to_batt;
  }
  return { produced: r2(produced), toHome: r2(toHome), toBatt: r2(toBatt) };
}

// One shared grid source for /api/flow AND /api/live (they must agree —
// seen 2026-09-14: the tile read the 20-min trend while the diagram read
// live scen_info). Priority: fresh meter snapshot → live scen_info grid
// channel (<60 s old) → newest closed 20-min cloud interval.
function getGridLive() {
  const snap = poller.getState().snapshot; // freshness-gated in getState()
  if (snap) {
    return { power: snap.primary?.totalPower ?? null, ts: snap.timestamp, source: "meter" };
  }
  const b = latestBattery ?? getLatestBattery();
  if (b?.gridToHomeW != null && b.ts != null && Date.now() - b.ts < 60000) {
    return {
      power: b.gridToHomeW - (b.pvToGridW ?? 0), // import minus PV feed-in
      ts: new Date(b.ts).toISOString(),
      source: "cloud-live",
    };
  }
  const c = getCloudGridLive();
  if (c) return { power: c.power, ts: c.ts, source: "cloud" };
  return { power: null, ts: null, source: "meter" };
}

// Single source of truth for "how much is the house drawing right now" —
// used by BOTH /api/flow (Live tab) and the power-plan controller/Strategy
// tab, refreshed once per 10 s tick below (2026-09-17 fix, user report: the
// Strategy tab's "house W" swung 600 -> 1000 -> 200 -> 600 across two
// strategy switches, and the Live tab's flow diagram showed a matching
// too-low Home reading). Root cause was two-fold: (1) power-plan.js ALWAYS
// read the battery's own cloud-reported homeLoadW, while /api/flow
// preferred the fast local grid meter + battery output when available —
// two different formulas for the exact same physical quantity, computed
// independently, occasionally disagreeing; (2) neither was despiked, so a
// single bad cloud reading right after a preset change (the device is
// mid-transition — same class of lag as the Home Power Usage chart
// artifact, but here feeding the CONTROLLER's target computation directly,
// not just a display) showed up as a real, visible swing. Fix: one
// function, used everywhere, computed once per tick and despiked with a
// median-of-3 (rejects an isolated bad reading without lagging behind a
// genuine, sustained demand change the way an averaging filter would).
// Prefers grid (meter, or any independently-sourced grid reading) +
// battery output; falls back to the battery's own reported homeLoadW only
// when grid itself came FROM the battery (cloud-live) — combining two
// battery-derived numbers there would double up on the same lag source
// instead of adding information.
const homeLoadHistory = [];
function despikeHomeLoad(raw) {
  if (raw == null) return raw;
  homeLoadHistory.push(raw);
  if (homeLoadHistory.length > 3) homeLoadHistory.shift();
  const sorted = [...homeLoadHistory].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
let latestHomeConsumptionW = null;
function refreshHomeConsumption() {
  const gl = getGridLive();
  const raw =
    gl.source !== "cloud-live" && gl.power != null && latestBattery?.outputW != null
      ? Math.max(gl.power, 0) + latestBattery.outputW
      : (latestBattery?.homeLoadW ?? null);
  latestHomeConsumptionW = despikeHomeLoad(raw);
  return latestHomeConsumptionW;
}

// Per-string PV kWh for today, memoized for 30 s — /api/flow is polled every
// 5 s per client and the trapezoid scans the whole day's battery_snapshots.
let pvStringKwhCache = { date: null, at: 0, result: { pv1Kwh: 0, pv2Kwh: 0 } };
function getPvStringKwhToday() {
  const today = localDate();
  if (pvStringKwhCache.date !== today || Date.now() - pvStringKwhCache.at > 30000) {
    pvStringKwhCache = { date: today, at: Date.now(), result: getPvStringKwhForDay(today) };
  }
  return pvStringKwhCache.result;
}

app.get("/api/flow", (req, res) => {
  const gl = getGridLive();
  const grid = gl.power;
  const gridTs = gl.ts;
  const gridSource = gl.source;
  const b = latestBattery ?? getLatestBattery();
  const pvW = b?.pvW ?? 0;
  const chargeW = b?.chargeW ?? 0;
  const outputW = b?.outputW ?? 0;
  // Shared with /api/battery/params (battery-params.js) so the Live tab's
  // flow diagram and the Strategy/Battery tab's charge/discharge readout
  // can never disagree again (they did: see deriveBatteryFlow's comment).
  const { pvToBattery, pvToHome, cellsW, gridChargeW } = deriveBatteryFlow({ pvW, chargeW, outputW });
  res.json({
    ok: true,
    data: {
      ts: Date.now(),
      obtainedAt: new Date().toISOString(), // when the server obtained these values
      grid: {
        import: grid != null ? Math.max(grid, 0) : null,
        export: grid != null ? Math.max(-grid, 0) : null,
        ts: gridTs,
        source: gridSource,
      },
      battery: b
        ? {
            soc: b.soc,
            discharge: b.outputW,
            charge: chargeW,
            // Cells-only output to the house (inverter total minus the PV
            // pass-through) — the PV→Home arc carries pvToHome separately.
            cells: cellsW,
            // Charging sourced from the grid (chargeW beyond what PV covers)
            // — the Home→Battery arc, normally 0.
            gridCharge: gridChargeW,
            name: b.name ?? "Solarbank",
            pv1W: b.pv1W ?? 0,
            pv2W: b.pv2W ?? 0,
            ts: b.ts ?? null,
            source: "online", // battery data is always cloud (REST/MQTT)
          }
        : null,
      pv: {
        production: pvW,
        toBattery: pvToBattery,
        toHome: pvToHome,
        // Per-string energy today (kWh), integrated locally from the 10 s
        // per-string power samples — the cloud has no per-string kWh.
        pv1KwhToday: getPvStringKwhToday().pv1Kwh,
        pv2KwhToday: getPvStringKwhToday().pv2Kwh,
        ts: b?.ts ?? null,
        source: b ? "online" : null,
      },
      home: {
        // Shared, despiked computation — see refreshHomeConsumption() above
        // for why (2026-09-17: this used to be computed inline here with a
        // DIFFERENT formula than the power-plan controller used, and
        // un-despiked, so the two could disagree and both could show a
        // transient bad reading right after a preset change).
        consumption: latestHomeConsumptionW,
      },
    },
  });
});

// Persisted live samples for chart backfill: /api/history?minutes=60
app.get("/api/history", (req, res) => {
  const minutes = Math.min(Number(req.query.minutes ?? 60), 2880);
  res.json({ ok: true, data: getHistory(Date.now() - minutes * 60 * 1000) });
});

// Unified power time series for the pan/zoom chart. Merges 5 s Modbus
// samples (with per-phase data) and the cloud 20-min grid trend (for periods
// without local samples), aggregated server-side into buckets sized so the
// response holds at most `points` rows — unless `bucket` (ms) is passed to
// force a fixed granularity (clamped so responses stay below 4000 rows).
app.get("/api/timeseries", (req, res) => {
  const to = Math.min(Number(req.query.to ?? Date.now()), Date.now());
  const from = Number(req.query.from ?? to - 24 * 3600 * 1000);
  const points = Math.min(Math.max(Number(req.query.points ?? 800), 50), 2000);
  if (!(from < to)) {
    return res.status(400).json({ ok: false, error: "from must be before to" });
  }
  // Round the bucket up to a whole poll-interval step; never finer than the
  // actual sampling rate. `view` (ms) is the VISIBLE window: buckets are
  // sized for it even when the fetched range is padded wider.
  const minBucketMs = poller.pollIntervalMs;
  const viewMs = Math.max(Number(req.query.view ?? 0) || to - from, 1000);
  const autoBucketMs = Math.max(
    minBucketMs,
    Math.ceil(viewMs / points / minBucketMs) * minBucketMs,
  );
  const requestedBucketMs = Number(req.query.bucket ?? 0);
  const bucketMs =
    requestedBucketMs > 0
      ? Math.max(
          minBucketMs,
          requestedBucketMs,
          Math.ceil((to - from) / 4000 / minBucketMs) * minBucketMs,
        )
      : autoBucketMs;

  const acc = new Map(); // bt -> {grid:{s,c}, l1.., solar:{s,c}}
  function add(bt, key, value) {
    if (value == null) return;
    let b = acc.get(bt);
    if (!b) {
      b = {};
      acc.set(bt, b);
    }
    const cell = (b[key] ??= { s: 0, c: 0 });
    cell.s += value;
    cell.c++;
  }

  // Source 1: local 5 s samples (has phases + solar + min/max envelope).
  const envelope = new Map(); // bt -> {min, max} for grid, from local samples
  for (const r of getSnapshotBuckets(from, to, bucketMs)) {
    add(r.bt, "grid", r.grid);
    add(r.bt, "l1", r.l1);
    add(r.bt, "l2", r.l2);
    add(r.bt, "l3", r.l3);
    add(r.bt, "solar", r.solar);
    if (r.gridMin != null) envelope.set(r.bt, { min: r.gridMin, max: r.gridMax });
  }

  const CLOUD_INTERVAL_MS = 20 * 60 * 1000;

  // Source 1b: battery (Solarbank) snapshots every 30 s — signed power:
  // discharge positive, charge negative; plus PV input watts. battOut is the
  // unsigned inverter output (home = grid + battOut; PV is inside it).
  for (const r of getBatteryHistory(from - CLOUD_INTERVAL_MS, to)) {
    const bt = Math.floor(r.ts / bucketMs) * bucketMs;
    add(bt, "batt", (r.output_w ?? 0) - (r.charge_w ?? 0));
    add(bt, "battOut", r.output_w ?? 0);
    add(bt, "battChg", r.charge_w ?? 0);
    add(bt, "pv", r.pv_w ?? 0);
  }

  // Source 1c: cloud-live grid samples (scen_info grid_info, ~10 s) — the
  // best available grid source when Modbus is down; signed like the meter
  // (import − PV feed-in). Only fills buckets the meter hasn't covered.
  for (const r of getCloudGridRows(from - CLOUD_INTERVAL_MS, to)) {
    const bt = Math.floor(r.ts / bucketMs) * bucketMs;
    if (!acc.get(bt)?.grid) add(bt, "grid", r.grid_w - (r.pv_to_grid_w ?? 0));
  }

  // Source 2: cloud 20-min trend as ANCHOR points in buckets without local
  // data (local wins). Still-open 20-min intervals are skipped — their
  // partial averages produce phantom dips.
  const sn = poller.snapshot?.meter?.sn;
  if (sn) {
    const fromDate = localDate(new Date(from - 86400000));
    const toDate = localDate(new Date(to));
    // Anchors reach one cloud interval past the window edges so interpolation
    // can bridge gaps that straddle the boundary (the edge buckets otherwise
    // stay null — a data outage ending just inside the window has no in-window
    // left anchor). Edge anchors are never emitted (output starts at `from`).
    const anchorFrom = from - CLOUD_INTERVAL_MS;
    const cloudRows = [];
    for (const r of getCloudDayPower(sn, fromDate, toDate)) {
      if (r.power == null || r.ts < anchorFrom || r.ts > to) continue;
      if (r.ts + CLOUD_INTERVAL_MS > Date.now()) continue; // interval not closed
      cloudRows.push(r);
    }
    // The cloud occasionally reports a 20-min average of EXACTLY 0 between
    // two healthy intervals (seen 2026-09-11 23:40: ~581 → 0 → ~595) — a
    // bogus anchor that V-dips the interpolated line toward zero. Drop a
    // zero anchor only when BOTH neighboring closed intervals are healthy;
    // keep zeros where a neighbor is also ~0 (legit low/export regions).
    const plausible = cloudRows.filter(
      (r, i) =>
        r.power !== 0 ||
        !(cloudRows[i - 1]?.power > 200 && cloudRows[i + 1]?.power > 200),
    );
    const cloudBuckets = new Map(); // bt -> {s, c}
    for (const r of plausible) {
      const bt = Math.floor(r.ts / bucketMs) * bucketMs;
      const cell = (cloudBuckets.get(bt) ?? cloudBuckets.set(bt, { s: 0, c: 0 }).get(bt));
      cell.s += r.power;
      cell.c++;
    }
    for (const [bt, cell] of cloudBuckets) {
      if (!acc.get(bt)?.grid) add(bt, "grid", cell.s / cell.c);
    }

    // Battery cloud fallback: day-trend anchors where live 5-min battery
    // snapshots haven't synced yet (e.g. right after server start).
    if (latestBattery?.sn) {
      for (const r of getCloudDayPower(latestBattery.sn, fromDate, toDate)) {
        if (r.power == null || r.ts < anchorFrom || r.ts > to) continue;
        if (r.ts + CLOUD_INTERVAL_MS > Date.now()) continue; // open interval
        const bt = Math.floor(r.ts / bucketMs) * bucketMs;
        if (!acc.get(bt)?.batt) {
          add(bt, "batt", r.power);
          add(bt, "battOut", Math.max(r.power, 0)); // signed trend: discharge+
          add(bt, "battChg", Math.max(-r.power, 0)); // charge is negative power
        }
      }
    }
  }

  // Final pass: bridge consecutive GRID-bearing buckets (local or cloud
  // anchors) with linear interpolation, so the line is always continuous.
  // Anchors must be buckets that actually hold grid data: a bucket holding
  // ONLY battery/PV data is not a grid anchor — treating it as one made the
  // !c0/!c1 guard skip both adjacent intervals and left the bucket null
  // (the periodic single-bucket dips, 2026-09-12). Wherever cloud history
  // exists, real grid anchors are at most 20 min apart — interpolation only
  // ever crosses the distance between two real measurements.
  const anchors = [...acc.keys()].sort((a, b) => a - b);

  // Phase shares (l_i / grid) at anchors with local data; used to split the
  // grid total proportionally in bridged buckets so phase lines stay
  // continuous. Anchors without local data inherit the nearest known share.
  function sharesAt(bt) {
    const b = acc.get(bt);
    if (!b?.grid?.c || !b.l1?.c || !b.l2?.c || !b.l3?.c) return null;
    const g = b.grid.s / b.grid.c;
    if (Math.abs(g) < 1) return null;
    return [b.l1.s / b.l1.c / g, b.l2.s / b.l2.c / g, b.l3.s / b.l3.c / g];
  }
  const gridAnchors = anchors.filter((bt) => acc.get(bt)?.grid);
  const gridShares = gridAnchors.map(sharesAt);
  const nearestShares = (i) => {
    for (let d = 0; d < gridAnchors.length; d++) {
      if (gridShares[i - d]) return gridShares[i - d];
      if (gridShares[i + d]) return gridShares[i + d];
    }
    return null;
  };

  for (let i = 1; i < gridAnchors.length; i++) {
    const bt0 = gridAnchors[i - 1];
    const bt1 = gridAnchors[i];
    const c0 = acc.get(bt0).grid;
    const c1 = acc.get(bt1).grid;
    const v0 = c0.s / c0.c;
    const v1 = c1.s / c1.c;
    const b0 = acc.get(bt0).batt;
    const b1 = acc.get(bt1).batt;
    const p0 = acc.get(bt0).pv;
    const p1 = acc.get(bt1).pv;
    const sh0 = gridShares[i - 1] ?? nearestShares(i - 1);
    const sh1 = gridShares[i] ?? nearestShares(i);
    for (let t = bt0 + bucketMs; t < bt1; t += bucketMs) {
      // Skip buckets that already have grid data — but a bucket holding ONLY
      // battery/PV data must still get its grid value filled.
      if (t < from || t > to || acc.get(t)?.grid) continue;
      const frac = (t - bt0) / (bt1 - bt0);
      const grid = v0 + (v1 - v0) * frac;
      add(t, "grid", grid);
      const existing = acc.get(t) ?? {};
      const o0 = acc.get(bt0).battOut;
      const o1 = acc.get(bt1).battOut;
      const c0 = acc.get(bt0).battChg;
      const c1 = acc.get(bt1).battChg;
      if (!existing.batt && b0 && b1)
        add(t, "batt", b0.s / b0.c + (b1.s / b1.c - b0.s / b0.c) * frac);
      if (!existing.battOut && o0 && o1)
        add(t, "battOut", o0.s / o0.c + (o1.s / o1.c - o0.s / o0.c) * frac);
      if (!existing.battChg && c0 && c1)
        add(t, "battChg", c0.s / c0.c + (c1.s / c1.c - c0.s / c0.c) * frac);
      if (!existing.pv && p0 && p1) add(t, "pv", p0.s / p0.c + (p1.s / p1.c - p0.s / p0.c) * frac);
      if (sh0 && sh1) {
        add(t, "l1", grid * (sh0[0] + (sh1[0] - sh0[0]) * frac));
        add(t, "l2", grid * (sh0[1] + (sh1[1] - sh0[1]) * frac));
        add(t, "l3", grid * (sh0[2] + (sh1[2] - sh0[2]) * frac));
      }
    }
  }

  // Battery/PV interpolation pass: their samples arrive every 30 s while the
  // bucket grid can be as fine as 5 s — and the grid-anchor pass above never
  // fills between them when grid data is continuous. Interpolate between
  // consecutive battery anchors regardless of what else is in the buckets.
  const battAnchors = anchors.filter((bt) => acc.get(bt)?.batt);
  for (let i = 1; i < battAnchors.length; i++) {
    const bt0 = battAnchors[i - 1];
    const bt1 = battAnchors[i];
    const b0 = acc.get(bt0).batt;
    const b1 = acc.get(bt1).batt;
    const p0 = acc.get(bt0).pv;
    const p1 = acc.get(bt1).pv;
    for (let t = bt0 + bucketMs; t < bt1; t += bucketMs) {
      if (t < from || t > to) continue;
      const frac = (t - bt0) / (bt1 - bt0);
      const b = acc.get(t) ?? {};
      const o0 = acc.get(bt0).battOut;
      const o1 = acc.get(bt1).battOut;
      const c0 = acc.get(bt0).battChg;
      const c1 = acc.get(bt1).battChg;
      if (!b.batt && b0 && b1)
        add(t, "batt", b0.s / b0.c + (b1.s / b1.c - b0.s / b0.c) * frac);
      if (!b.battOut && o0 && o1)
        add(t, "battOut", o0.s / o0.c + (o1.s / o1.c - o0.s / o0.c) * frac);
      if (!b.battChg && c0 && c1)
        add(t, "battChg", c0.s / c0.c + (c1.s / c1.c - c0.s / c0.c) * frac);
      if (!b.pv && p0 && p1) add(t, "pv", p0.s / p0.c + (p1.s / p1.c - p0.s / p0.c) * frac);
    }
  }

  // PV interpolation pass with PV-bearing anchors only: battery CLOUD anchors
  // carry no PV channel (the battery day-trend is signed battery power), so
  // the pass above leaves pv null across cloud-only regions (e.g. overnight
  // when the laptop slept and no local battery rows exist). Bridge between
  // the local pv anchors that bracket such regions.
  const pvAnchors = anchors.filter((bt) => acc.get(bt)?.pv);
  for (let i = 1; i < pvAnchors.length; i++) {
    const bt0 = pvAnchors[i - 1];
    const bt1 = pvAnchors[i];
    const p0 = acc.get(bt0).pv;
    const p1 = acc.get(bt1).pv;
    for (let t = bt0 + bucketMs; t < bt1; t += bucketMs) {
      if (t < from || t > to || acc.get(t)?.pv) continue;
      const frac = (t - bt0) / (bt1 - bt0);
      add(t, "pv", p0.s / p0.c + (p1.s / p1.c - p0.s / p0.c) * frac);
    }
  }

  const round = (cell) => (cell ? Math.round((cell.s / cell.c) * 100) / 100 : null);

  // Emit EVERY bucket in the window (nulls where no data exists). The chart
  // spaces points by index, so sparse data would visually collapse time gaps;
  // dense buckets keep the x-axis proportional to real time.
  const firstBucket = Math.floor(from / bucketMs) * bucketMs;
  const lastBucket = Math.floor(to / bucketMs) * bucketMs;
  const data = [];
  for (let bt = firstBucket; bt <= lastBucket; bt += bucketMs) {
    const b = acc.get(bt);
    const env = envelope.get(bt);
    data.push({
      t: bt,
      grid: b ? round(b.grid) : null,
      // Envelope only where local samples exist; cloud-only buckets stay flat.
      gridMin: env ? Math.round(env.min * 100) / 100 : b && b.grid ? round(b.grid) : null,
      gridMax: env ? Math.round(env.max * 100) / 100 : b && b.grid ? round(b.grid) : null,
      l1: b ? round(b.l1) : null,
      l2: b ? round(b.l2) : null,
      l3: b ? round(b.l3) : null,
      solar: b ? round(b.solar) : null,
      batt: b ? round(b.batt) : null,
      battOut: b ? round(b.battOut) : null,
      battChg: b ? round(b.battChg) : null,
      pv: b ? round(b.pv) : null,
    });
  }

  // Post-pass: cloud anchor buckets have grid but no phase split. Fill them
  // proportionally, interpolating shares between the nearest phase-bearing
  // buckets left and right, so phase lines have no single-bucket holes.
  const shareOf = (r) =>
    r.grid != null && r.l1 != null && Math.abs(r.grid) >= 1
      ? [r.l1 / r.grid, r.l2 / r.grid, r.l3 / r.grid]
      : null;
  const leftShares = new Array(data.length).fill(null);
  const rightShares = new Array(data.length).fill(null);
  let last = null;
  for (let i = 0; i < data.length; i++) {
    const s = shareOf(data[i]);
    if (s) last = s;
    leftShares[i] = last;
  }
  last = null;
  for (let i = data.length - 1; i >= 0; i--) {
    const s = shareOf(data[i]);
    if (s) last = s;
    rightShares[i] = last;
  }
  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (r.grid == null || r.l1 != null) continue;
    const ls = leftShares[i];
    const rs = rightShares[i];
    const sh = ls && rs ? ls.map((v, k) => (v + rs[k]) / 2) : (ls ?? rs);
    if (!sh) continue;
    r.l1 = Math.round(r.grid * sh[0] * 100) / 100;
    r.l2 = Math.round(r.grid * sh[1] * 100) / 100;
    r.l3 = Math.round(r.grid * sh[2] * 100) / 100;
  }

  res.json({ ok: true, bucketMs, data });
});

// Aggregate stats for the dashboard tiles: one call, local DB only.
app.get("/api/stats/overview", (req, res) => {
  const sn = poller.snapshot?.meter?.sn ?? getAnyDeviceSn();
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dayStartMs = todayStart.getTime();

  // --- Today: 30-min buckets, local samples where present, cloud 20-min
  // trend elsewhere (anchors), interpolation between anchors. Same merge
  // spirit as /api/timeseries.
  const BUCKET = 30 * 60 * 1000;
  const anchors = new Map(); // bt -> {s, c}
  const put = (bt, v) => {
    const cell = (anchors.get(bt) ?? anchors.set(bt, { s: 0, c: 0 }).get(bt));
    cell.s += v;
    cell.c++;
  };
  let peak = null;
  let localCount = 0;
  for (const r of getSnapshotRows(dayStartMs, now)) {
    if (r.grid_total == null) continue;
    put(Math.floor(r.ts / BUCKET) * BUCKET, r.grid_total);
    localCount++;
    if (peak == null || r.grid_total > peak) peak = r.grid_total;
  }
  if (sn) {
    const today = localDate(new Date(dayStartMs));
    for (const r of getCloudDayPower(sn, today, today)) {
      if (r.power == null || r.ts < dayStartMs || r.ts > now) continue;
      if (r.ts + 20 * 60 * 1000 > now) continue; // skip open interval
      const bt = Math.floor(r.ts / BUCKET) * BUCKET;
      if (!anchors.has(bt)) put(bt, r.power);
    }
  }
  const sorted = [...anchors.entries()].sort(([a], [b]) => a - b);
  const profile = [];
  const MAX_GAP_MS = 30 * 60 * 1000;
  for (let i = 0; i < sorted.length; i++) {
    const [bt, cell] = sorted[i];
    profile.push({ t: bt, power: Math.round(cell.s / cell.c) });
    const next = sorted[i + 1];
    if (next) {
      const [nbt] = next;
      if (nbt - bt > MAX_GAP_MS) continue; // real outage — don't guess across it
      const nv = next[1].s / next[1].c;
      for (let t = bt + BUCKET; t < nbt; t += BUCKET) {
        const frac = (t - bt) / (nbt - bt);
        profile.push({ t, power: Math.round(cell.s / cell.c + (nv - cell.s / cell.c) * frac) });
      }
    }
  }
  // Energy for today = sum over profile buckets (W * 0.5 h), split by sign.
  let importKwh = 0;
  let exportKwh = 0;
  for (const p of profile) {
    if (p.power >= 0) importKwh += (p.power * 0.5) / 1000;
    else exportKwh += (-p.power * 0.5) / 1000;
  }
  const avgW = profile.length
    ? Math.round(profile.reduce((a, p) => a + p.power, 0) / profile.length)
    : null;
  const elapsedBuckets = Math.max(1, Math.floor((now - dayStartMs) / BUCKET));
  const coverage = Math.min(100, Math.round((profile.length / elapsedBuckets) * 100));

  // --- Battery profile for today: 30-s live snapshots as anchors, cloud
  // battery day-trend as fallback, interpolated (same pattern as grid).
  const battSn = latestBattery?.sn ?? getBatterySn(sn);
  const battAnchors = new Map(); // bt -> {s, c} signed battery flow (out − charge)
  const cellsAnchors = new Map(); // bt -> {s, c} cells-only output (excl. PV pass-through)
  const pvAnchors = new Map(); // bt -> {s, c} PV direct-to-home
  const putInto = (map, bt, v) => {
    const cell = (map.get(bt) ?? map.set(bt, { s: 0, c: 0 }).get(bt));
    cell.s += v;
    cell.c++;
  };
  // Validated split (see /api/flow): PV→home exists only while the inverter
  // outputs; cells = output minus that pass-through. Never both booked.
  const pvHomeOfRow = (r) =>
    (r.output_w ?? 0) > 0 ? Math.max(0, (r.pv_w ?? 0) - (r.charge_w ?? 0)) : 0;
  for (const r of getBatteryHistory(dayStartMs, now)) {
    if (r.output_w == null) continue;
    const bt = Math.floor(r.ts / BUCKET) * BUCKET;
    const pvHome = pvHomeOfRow(r);
    putInto(battAnchors, bt, (r.output_w ?? 0) - (r.charge_w ?? 0));
    putInto(cellsAnchors, bt, Math.max(0, (r.output_w ?? 0) - pvHome));
    putInto(pvAnchors, bt, pvHome);
  }
  if (battSn) {
    const todayStr = localDate(new Date(dayStartMs));
    for (const r of getCloudDayPower(battSn, todayStr, todayStr)) {
      if (r.power == null || r.ts < dayStartMs || r.ts > now) continue;
      if (r.ts + 20 * 60 * 1000 > now) continue;
      const bt = Math.floor(r.ts / BUCKET) * BUCKET;
      if (!battAnchors.has(bt)) putInto(battAnchors, bt, r.power);
      // The cloud battery series is CELLS-only (verified 2026-09-15) — use
      // it as the cells fallback too (no local samples that bucket).
      if (!cellsAnchors.has(bt)) putInto(cellsAnchors, bt, Math.max(0, r.power));
    }
  }
  // 2026-09-16 fix: this used to interpolate a straight line across ANY gap
  // between anchors, no matter how long — a real multi-hour outage (see
  // AGENTS.md) got smoothly guessed across instead of showing as missing,
  // while the headline today-kWh totals below (integrateBatteryEnergy)
  // correctly dropped that same gap — so the "Today" bar chart and its own
  // headline number could disagree about the same outage. Both now share the
  // same "don't guess across gaps > 30 min" policy (MAX_GAP_MS, declared
  // above for the grid profile).
  const interp = (anchors) => {
    const sorted = [...anchors.entries()].sort(([a], [b]) => a - b);
    const byT = new Map();
    for (let i = 0; i < sorted.length; i++) {
      const [bt, cell] = sorted[i];
      byT.set(bt, Math.round(cell.s / cell.c));
      const next = sorted[i + 1];
      if (next) {
        const [nbt] = next;
        if (nbt - bt > MAX_GAP_MS) continue; // real outage — don't guess across it
        const nv = next[1].s / next[1].c;
        for (let t = bt + BUCKET; t < nbt; t += BUCKET) {
          const frac = (t - bt) / (nbt - bt);
          byT.set(t, Math.round(cell.s / cell.c + (nv - cell.s / cell.c) * frac));
        }
      }
    }
    return byT;
  };
  const battByT = interp(battAnchors);
  const cellsByT = interp(cellsAnchors);
  const pvByT = interp(pvAnchors);
  for (const p of profile) {
    p.batt = battByT.get(p.t) ?? null;
    p.cells = cellsByT.get(p.t) ?? null;
    p.pvHome = pvByT.get(p.t) ?? null;
  }

  // --- Battery kWh per day (for week/month tiles): integrate the cloud
  // battery day trend (20-min signed power; discharge +, charge −).
  function battKwhForDay(dateStr) {
    if (!battSn) return { disKwh: 0, chgKwh: 0 };
    const rows = getCloudTrend(battSn, "day", dateStr).rows;
    let disKwh = 0;
    let chgKwh = 0;
    for (const r of rows) {
      if (r.power == null) continue;
      const kwh = (r.power * (20 / 60)) / 1000;
      if (kwh >= 0) disKwh += kwh;
      else chgKwh += -kwh;
    }
    return { disKwh: Math.round(disKwh * 100) / 100, chgKwh: Math.round(chgKwh * 100) / 100 };
  }

  // --- Week (last 7 days) & month: daily kWh from cloud_history month rows.
  function monthKwh(yearMonth) {
    if (!sn) return [];
    return getCloudTrend(sn, "month", yearMonth).rows.map((r) => ({
      label: r.time,
      importKwh: r.import_energy ?? 0,
      exportKwh: r.export_energy ?? 0,
    }));
  }
  const ym = localDate().slice(0, 7);
  const prevYm = localDate(new Date(dayStartMs - 7 * 86400000)).slice(0, 7);
  const monthRows = prevYm === ym ? monthKwh(ym) : [...monthKwh(prevYm), ...monthKwh(ym)];
  // Attach per-day battery kWh (from the battery's cloud day trends).
  for (const r of monthRows) Object.assign(r, battKwhForDay(r.label));
  // Calendar week (Monday..Sunday) containing today — NOT a rolling 7-day
  // window (2026-09-16 fix: "This week" used to mean "the last 7 days,"
  // which doesn't match the label or how This month/This year behave).
  const weekStartMs = mondayOf(dayStartMs).getTime();
  const weekEndMs = weekStartMs + 7 * 86400000;
  const weekRows = monthRows.filter((r) => {
    const t = new Date(`${r.label}T12:00:00`).getTime();
    return t >= weekStartMs && t < weekEndMs;
  });

  // --- Year: monthly kWh from cloud_history year rows.
  const yearRows = sn
    ? getCloudTrend(sn, "year", String(new Date().getFullYear())).rows.map((r) => ({
        label: r.time,
        importKwh: r.import_energy ?? 0,
        exportKwh: r.export_energy ?? 0,
      }))
    : [];

  // --- Battery (Solarbank) today: SOC + integrated discharge/charge/PV kWh
  // from the 30-s live snapshots — shared trapezoid + gap policy, see
  // integrateBatteryEnergy (db.js). A real ~5h battery-telemetry outage
  // (2026-09-16, see AGENTS.md) silently zeroed today's PV production with
  // no way to tell "measured, genuinely low" from "measured, but a chunk of
  // the day is missing." Fix has two parts: (1) dischargedKwh/chargedKwh/
  // pvKwh (standalone totals, safe to recover) get backfilled from Anker's
  // own cloud day-trends for exactly the gap windows — the cloud has this
  // data regardless of whether OUR poller was running. (2) pvToHomeKwh/
  // pvToBattKwh are a DERIVED SPLIT that can't be reconstructed the same
  // way (the cloud only reports totals, not the home/battery split), so
  // those deliberately stay local-only/conservative — backfilling
  // dischargedKwh without a matching pvToHomeKwh backfill would otherwise
  // inflate todayCellsKwh (= dischargedKwh − pvToHomeKwh) below.
  const battRows = getBatteryHistory(dayStartMs, now);
  const todayDateStr = localDate(new Date(dayStartMs));
  const battEnergy = integrateBatteryEnergy(battRows, {
    windowStartMs: dayStartMs,
    windowEndMs: now,
  });
  const pvToHomeKwh = battEnergy.toHomeKwh;
  const pvToBattKwh = battEnergy.toBattKwh;
  let dischargedKwh = battEnergy.dischargedKwh;
  let chargedKwh = battEnergy.chargedKwh;
  let pvKwh = battEnergy.producedKwh;
  let recoveredMs = 0;
  if (battEnergy.gaps.length) {
    const cloudPvRows = getCloudPvDayPower(todayDateStr, todayDateStr);
    pvKwh = Math.round((pvKwh + sumCloudEnergyInGaps(cloudPvRows, battEnergy.gaps)) * 100) / 100;
    if (cloudPvRows.some((r) => battEnergy.gaps.some((g) => r.ts >= g.startMs && r.ts < g.endMs))) {
      recoveredMs += battEnergy.gaps.reduce((a, g) => a + (g.endMs - g.startMs), 0);
    }
    if (battSn) {
      const cloudBattRows = getCloudDayPower(battSn, todayDateStr, todayDateStr);
      let gapDis = 0;
      let gapChg = 0;
      for (const r of cloudBattRows) {
        if (r.power == null) continue;
        if (!battEnergy.gaps.some((g) => r.ts >= g.startMs && r.ts < g.endMs)) continue;
        const kwh = (r.power * (20 / 60)) / 1000;
        if (kwh >= 0) gapDis += kwh;
        else gapChg += -kwh;
      }
      dischargedKwh = Math.round((dischargedKwh + gapDis) * 100) / 100;
      chargedKwh = Math.round((chargedKwh + gapChg) * 100) / 100;
    }
  }
  const todayElapsedMs = Math.max(1, now - dayStartMs);
  const todayDataCoveragePct = Math.max(
    0,
    Math.min(100, Math.round(((battEnergy.coveredMs + recoveredMs) / todayElapsedMs) * 100)),
  );
  const battLatest = latestBattery ?? getLatestBattery();
  const battery = battLatest
    ? {
        name: battLatest.name ?? "Solarbank",
        soc: battLatest.soc,
        outputW: battLatest.outputW,
        chargeW: battLatest.chargeW,
        pvW: battLatest.pvW,
        dischargedKwh: Math.round(dischargedKwh * 100) / 100,
        chargedKwh: Math.round(chargedKwh * 100) / 100,
      }
    : null;
  // Per-flow kWh totals for today (documented approximations, see /api/flow).
  const flows = {
    gridImportKwh: Math.round(importKwh * 100) / 100,
    gridExportKwh: Math.round(exportKwh * 100) / 100,
    battDischargedKwh: battery?.dischargedKwh ?? 0,
    battChargedKwh: battery?.chargedKwh ?? 0,
    pvKwh: Math.round(pvKwh * 100) / 100,
    homeKwh: Math.round((importKwh + dischargedKwh) * 100) / 100,
  };

  // Costs from kWh × tariff (what was actually SPENT on grid import — a
  // different quantity from "saved," which is production-based; see
  // savings.js).
  const tariff = Number(process.env.TARIFF_EUR_PER_KWH ?? 0);
  const eur = (kwh) => Math.round(kwh * tariff * 100) / 100;
  const weekImport = weekRows.reduce((a, r) => a + r.importKwh, 0);
  const monthRowsCur = monthRows.filter((r) => r.label.startsWith(ym));
  const monthImport = monthRowsCur.reduce((a, r) => a + r.importKwh, 0);
  const yearImport = yearRows.reduce((a, r) => a + r.importKwh, 0);
  const costs = {
    tariffEurPerKwh: tariff,
    today: eur(importKwh),
    week: eur(weekImport),
    month: eur(monthImport),
    year: eur(yearImport),
    batterySavingsToday: savedEur(pvKwh, tariff),
  };

  // Consumption by source per period (dashboard tiles), uniform per-day
  // channel split — NO double booking:
  //   pvKwh(day)   = PV direct-to-home (pv_daily rollup for finished days,
  //                  live trapezoid for today)
  //   battKwh(day) = CELLS-only discharge. The cloud battery day-trend IS a
  //                  cells-only series (verified 2026-09-15 vs local
  //                  integration); for today the cloud series lags, so use
  //                  the live trapezoid (discharge − PV pass-through).
  // PV→battery ("loaded") is reported separately and NEVER added to savings:
  // that energy counts when it comes back as cells discharge.
  const r2 = (v) => Math.round(v * 100) / 100;
  const todayDs = localDate();
  // Deliberately battEnergy.dischargedKwh (LOCAL-ONLY), not the backfilled
  // `dischargedKwh` above — cells = discharge − PV-passthrough, and only
  // discharge got a cloud backfill (no matching pvToHomeKwh backfill
  // exists), so subtracting the backfilled figure here would inflate
  // today's "From battery" savings for any gap window. See the battery
  // block's comment above.
  const todayCellsKwh = Math.max(0, r2(battEnergy.dischargedKwh - pvToHomeKwh));
  const todayPvBattKwh = r2(pvToBattKwh);
  const pvDayKwh = (dateStr) =>
    dateStr === todayDs ? r2(pvToHomeKwh) : (getPvDaily(dateStr, dateStr)[0]?.to_home ?? 0);
  // Total PV production (to-home + to-battery, i.e. everything the panels
  // made) — distinct from pvDayKwh, which is PV-direct-to-home only.
  const pvProducedDayKwh = (dateStr) =>
    dateStr === todayDs ? r2(pvKwh) : (getPvDaily(dateStr, dateStr)[0]?.produced ?? 0);
  // Today's cells override in the per-day rows the sums/bars are built from.
  for (const r of monthRows) if (r.label === todayDs) r.disKwh = todayCellsKwh;
  const battYear = (() => {
    let sum = 0;
    const d = new Date(dayStartMs);
    for (let date = new Date(d.getFullYear(), 0, 1); date <= d; date.setDate(date.getDate() + 1)) {
      const ds = localDate(date);
      sum += ds === todayDs ? todayCellsKwh : battKwhForDay(ds).disKwh;
    }
    return r2(sum);
  })();
  const byPeriod = {
    today: {
      homeKwh: flows.homeKwh,
      gridKwh: flows.gridImportKwh,
      // "From battery" = CELLS only: the inverter's output includes the PV
      // pass-through, so subtract it or PV energy counts twice.
      battKwh: todayCellsKwh,
      pvKwh: r2(pvToHomeKwh),
      // Total PV production today (to-home + to-battery) — informational,
      // not part of the home-total sum (that's pvKwh + battInKwh already).
      pvProducedKwh: r2(pvKwh),
      // "Loaded into the battery" (from PV) — informational, no € attached.
      battInKwh: todayPvBattKwh,
      // % of today's elapsed time covered by continuous LOCAL telemetry OR
      // successfully backfilled from Anker's cloud (see integrateBatteryEnergy
      // + the battery block above) — pvProducedKwh/battKwh are already
      // corrected for any gap this covers, so a value below 100 here means
      // even the cloud couldn't fill it (a rarer, more serious case: the
      // account/cloud was unreachable too), not just "today looks quiet."
      dataCoveragePct: todayDataCoveragePct,
    },
    week: {
      gridKwh: r2(weekImport),
      battKwh: r2(weekRows.reduce((a, r) => a + (r.disKwh ?? 0), 0)),
      pvKwh: r2(weekRows.reduce((a, r) => a + pvDayKwh(r.label), 0)),
      pvProducedKwh: r2(weekRows.reduce((a, r) => a + pvProducedDayKwh(r.label), 0)),
    },
    month: {
      gridKwh: r2(monthImport),
      battKwh: r2(monthRowsCur.reduce((a, r) => a + (r.disKwh ?? 0), 0)),
      pvKwh: r2(monthRowsCur.reduce((a, r) => a + pvDayKwh(r.label), 0)),
      pvProducedKwh: r2(monthRowsCur.reduce((a, r) => a + pvProducedDayKwh(r.label), 0)),
    },
    year: {
      gridKwh: r2(yearImport),
      battKwh: battYear,
      pvKwh: r2(
        pvStoredTotals(`${new Date(dayStartMs).getFullYear()}-01-01`, todayDs).toHome +
          r2(pvToHomeKwh),
      ),
      pvProducedKwh: r2(
        pvStoredTotals(`${new Date(dayStartMs).getFullYear()}-01-01`, todayDs).produced +
          r2(pvKwh),
      ),
    },
  };
  for (const p of [byPeriod.week, byPeriod.month, byPeriod.year]) {
    p.homeKwh = r2(p.gridKwh + p.battKwh + p.pvKwh);
  }
  // Money view: grid = spent; savedEur = the ONE canonical savings figure,
  // production-based (savings.js — 2026-09-17 fix, see there for why).
  // gridEur/battEur/pvEur stay as per-row kWh×tariff figures for the
  // individual "PV direct"/"From battery" lines (informational — they no
  // longer sum to savedEur, since that's now produced-based, not
  // consumed-based; the frontend shows kWh only on those rows, not €, to
  // avoid implying they do). battInKwh deliberately gets NO € — it's PV
  // already counted inside pvProducedKwh, not a separate flow.
  for (const p of Object.values(byPeriod)) {
    p.gridEur = eur(p.gridKwh);
    p.battEur = eur(p.battKwh);
    p.pvEur = eur(p.pvKwh);
    p.savedEur = savedEur(p.pvProducedKwh, tariff);
  }

  // Stacked-bar data for the tiles' flip sides: per-bucket kWh split by
  // source (grid / battery-cells / PV-to-home). Today = hourly (profile is
  // 30-min, summed in pairs — half-hourly bars were too dense/cluttered on
  // the flip side); week/month = per day (cloud month rows + battery
  // day-trends + pv_daily); year = per month.
  //
  // Always emit all 24 hourly slots (2026-09-16 fix: this used to only
  // create a slot for hours that had profile data, so the chart's x-axis
  // silently shrank/grew as the day went on instead of showing a stable
  // 24-hour day with the not-yet-happened part visibly blank). Hours later
  // than the current one are null (genuinely hasn't happened — a real gap,
  // not a measured zero); the in-progress current hour shows its partial
  // total so far, same as every other "today" figure in this app.
  const HOUR_MS = 3600 * 1000;
  const nowHour = new Date(now).getHours();
  const hourlySums = Array.from({ length: 24 }, () => ({ grid: 0, batt: 0, pv: 0 }));
  for (const p of profile) {
    const hour = new Date(p.t).getHours();
    if (hour < 0 || hour > 23) continue;
    hourlySums[hour].grid += (Math.max(p.power, 0) * 0.5) / 1000;
    hourlySums[hour].batt += (Math.max(p.cells ?? 0, 0) * 0.5) / 1000;
    hourlySums[hour].pv += (Math.max(p.pvHome ?? 0, 0) * 0.5) / 1000;
  }
  byPeriod.today.bars = Array.from({ length: 24 }, (_, h) => ({
    label: dayStartMs + h * HOUR_MS,
    grid: h > nowHour ? null : r2(hourlySums[h].grid),
    batt: h > nowHour ? null : r2(hourlySums[h].batt),
    pv: h > nowHour ? null : r2(hourlySums[h].pv),
  }));
  const dayBars = (rows) =>
    rows.map((r) => ({ label: r.label, grid: r.importKwh, batt: r.disKwh ?? 0, pv: pvDayKwh(r.label) }));
  byPeriod.week.bars = dayBars(weekRows);
  // Always emit every day of the CURRENT month (2026-09-17 fix, same
  // reasoning as today's hourly bars above): this used to filter out days
  // past today entirely, so the month tile's flip-side chart shrank to
  // however many days had elapsed instead of showing a stable full-month
  // axis with the not-yet-happened remainder visibly blank. Days after
  // today are null (a real gap, not a measured zero); today itself and
  // earlier use their real (possibly 0) values.
  {
    const monthByDate = new Map(monthRowsCur.map((r) => [r.label, r]));
    const [monthY, monthM] = ym.split("-").map(Number);
    const daysInCurMonth = new Date(monthY, monthM, 0).getDate();
    byPeriod.month.bars = Array.from({ length: daysInCurMonth }, (_, i) => {
      const label = `${ym}-${String(i + 1).padStart(2, "0")}`;
      if (label > todayDs) return { label, grid: null, batt: null, pv: null };
      const r = monthByDate.get(label);
      return {
        label,
        grid: r ? r.importKwh : 0,
        batt: r ? (r.disKwh ?? 0) : 0,
        pv: pvDayKwh(label),
      };
    });
  }
  byPeriod.year.bars = yearRows.map((r) => {
    const [y, m] = r.label.split("-").map(Number);
    let batt = 0;
    let pv = 0;
    const d = new Date(dayStartMs);
    const lastDay = m === d.getMonth() + 1 ? d.getDate() : new Date(y, m, 0).getDate();
    for (let day = 1; day <= lastDay; day++) {
      const ds = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      batt += ds === todayDs ? todayCellsKwh : battKwhForDay(ds).disKwh;
      pv += pvDayKwh(ds);
    }
    return { label: r.label, grid: r.importKwh, batt: r2(batt), pv: r2(pv) };
  });

  res.json({
    ok: true,
    data: {
      today: {
        importKwh: Math.round(importKwh * 100) / 100,
        exportKwh: Math.round(exportKwh * 100) / 100,
        avgW,
        peakW: peak,
        coverage,
      },
      profile,
      battery,
      flows,
      costs,
      byPeriod,
      week: weekRows,
      month: monthRowsCur,
      year: yearRows,
    },
  });
});

// Single-period consumption-by-source for the dashboard tiles' time
// navigation (offset ≥ 1 = that many periods back; offset 0 is served by
// /api/stats/overview). All from the local DB. Shape matches a byPeriod
// entry plus label/hasData/hasEarlier so the card can stop at the data edge.
app.get("/api/stats/period", (req, res) => {
  const type = ["day", "week", "month", "year"].includes(req.query.type) ? req.query.type : "day";
  const offset = Math.max(1, Math.min(Number(req.query.offset ?? 1) || 1, 400));
  const sn = poller.snapshot?.meter?.sn ?? getAnyDeviceSn();
  const battSn = latestBattery?.sn ?? getBatterySn(sn);
  const tariff = Number(process.env.TARIFF_EUR_PER_KWH ?? 0);
  const r2 = (v) => Math.round(v * 100) / 100;
  const eur = (kwh) => r2(kwh * tariff);
  const earliest = getEarliestCloudDay(sn);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  // Battery discharge/charge kWh for one date (battery cloud day-trend).
  // The cloud battery series is CELLS-only (verified 2026-09-15) — no PV
  // pass-through inside, so it never double-books the PV channel.
  function battKwh(dateStr) {
    if (!battSn) return 0;
    let dis = 0;
    for (const r of getCloudTrend(battSn, "day", dateStr).rows) {
      if (r.power == null) continue;
      const kwh = (r.power * (20 / 60)) / 1000;
      if (kwh >= 0) dis += kwh;
    }
    return r2(dis);
  }
  // PV direct-to-home kWh for one finished date (local pv_daily rollup —
  // the cloud has no PV channel; 0 before the panels existed).
  function pvKwhDay(dateStr) {
    return getPvDaily(dateStr, dateStr)[0]?.to_home ?? 0;
  }
  // Total PV production (to-home + to-battery) for one finished date.
  function pvProducedDay(dateStr) {
    return getPvDaily(dateStr, dateStr)[0]?.produced ?? 0;
  }
  // Grid import kWh + 24 hourly bars for one finished date (meter/battery/PV
  // cloud day-trends). 2026-09-16 fixes: (1) bars used to be raw 20-min
  // cloud buckets (~72/day) instead of the hourly granularity the "Today"
  // tile uses, so the chart got visibly denser the moment you navigated
  // back a day — now hourlyKwhFromRows buckets all three sources the same
  // way "Today" does. (2) `pv` was hardcoded to 0 — the cloud's
  // "solar_production" day-trend (cloud_pv_history, synced by
  // syncCloudHistory/catchUpBatteryPvHistory) gives PRODUCTION shape, not
  // the to-home/to-battery split, so it's used to shape pv_daily's correct
  // to-home TOTAL proportionally across the day's hours rather than fed in
  // directly (which would double-count against the "batt" cells bar for
  // whatever charged the battery that day).
  function dayGrid(dateStr) {
    const gridH = hourlyKwhFromRows(getCloudDayPower(sn, dateStr, dateStr));
    const battH = battSn ? hourlyKwhFromRows(getCloudDayPower(battSn, dateStr, dateStr)) : new Array(24).fill(0);
    const pvProdH = hourlyKwhFromRows(getCloudPvDayPower(dateStr, dateStr));
    const pvProdTotal = pvProdH.reduce((a, v) => a + v, 0);
    const pvHomeTotal = pvKwhDay(dateStr);
    const pvH =
      pvProdTotal > 0 ? pvProdH.map((v) => (v / pvProdTotal) * pvHomeTotal) : new Array(24).fill(0);
    const dayStartLocal = new Date(`${dateStr}T00:00:00`).getTime();
    const bars = Array.from({ length: 24 }, (_, h) => ({
      label: dayStartLocal + h * 3600000,
      grid: r2(gridH[h]),
      batt: r2(battH[h]),
      pv: r2(pvH[h]),
    }));
    const imp = r2(gridH.reduce((a, v) => a + v, 0));
    return { imp, bars };
  }
  function monthRows(ym) {
    if (!sn) return [];
    return getCloudTrend(sn, "month", ym).rows.map((r) => ({
      label: r.time,
      importKwh: r.import_energy ?? 0,
    }));
  }
  const dayBars = (rows) =>
    rows.map((r) => ({ label: r.label, grid: r.importKwh, batt: battKwh(r.label), pv: pvKwhDay(r.label) }));

  let label;
  let gridKwh = 0;
  let battKwhSum = 0;
  let pvKwhSum = 0;
  let pvProducedKwhSum = 0;
  let bars = [];
  let periodStart = null; // yyyy-MM-dd of the period's first day (for hasEarlier)

  if (type === "day") {
    const d = new Date(dayStart.getTime() - offset * 86400000);
    const dateStr = localDate(d);
    periodStart = dateStr;
    label = offset === 1 ? "Yesterday" : dateStr;
    const g = dayGrid(dateStr);
    gridKwh = g.imp;
    bars = g.bars;
    battKwhSum = battKwh(dateStr);
    pvKwhSum = pvKwhDay(dateStr);
    pvProducedKwhSum = pvProducedDay(dateStr);
  } else if (type === "week") {
    // Calendar week (Monday..Sunday), offset whole weeks back from the
    // current one (2026-09-16 fix: this used to be a rolling 7-day window
    // ending "offset weeks ago," which doesn't match "This week" meaning
    // the actual calendar week — see the matching fix in /api/stats/overview).
    const thisMonday = mondayOf(dayStart);
    const start = new Date(thisMonday.getTime() - offset * 7 * 86400000);
    const end = new Date(start.getTime() + 7 * 86400000);
    periodStart = localDate(start);
    const lastDay = localDate(new Date(end.getTime() - 86400000));
    label = `${periodStart.slice(5)} – ${lastDay.slice(5)}`;
    const rows = [];
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const ds = localDate(d);
      const ym = ds.slice(0, 7);
      const row = monthRows(ym).find((r) => r.label === ds);
      rows.push({ label: ds, importKwh: row?.importKwh ?? 0 });
    }
    gridKwh = r2(rows.reduce((a, r) => a + r.importKwh, 0));
    bars = dayBars(rows);
    battKwhSum = r2(bars.reduce((a, b) => a + b.batt, 0));
    pvKwhSum = r2(bars.reduce((a, b) => a + b.pv, 0));
    pvProducedKwhSum = r2(rows.reduce((a, r) => a + pvProducedDay(r.label), 0));
  } else if (type === "month") {
    const d = new Date(dayStart.getFullYear(), dayStart.getMonth() - offset, 1);
    const ym = localDate(d).slice(0, 7);
    periodStart = `${ym}-01`;
    label = d.toLocaleDateString("en", { month: "long", year: "numeric" });
    const rows = monthRows(ym);
    gridKwh = r2(rows.reduce((a, r) => a + r.importKwh, 0));
    bars = dayBars(rows);
    battKwhSum = r2(bars.reduce((a, b) => a + b.batt, 0));
    pvKwhSum = r2(bars.reduce((a, b) => a + b.pv, 0));
    pvProducedKwhSum = r2(rows.reduce((a, r) => a + pvProducedDay(r.label), 0));
  } else {
    const year = dayStart.getFullYear() - offset;
    periodStart = `${year}-01-01`;
    label = String(year);
    const yearRows = sn
      ? getCloudTrend(sn, "year", String(year)).rows.map((r) => ({
          label: r.time,
          importKwh: r.import_energy ?? 0,
        }))
      : [];
    gridKwh = r2(yearRows.reduce((a, r) => a + r.importKwh, 0));
    let producedYear = 0;
    bars = yearRows.map((r) => {
      const [y, m] = r.label.split("-").map(Number);
      let batt = 0;
      let pv = 0;
      for (let day = 1; day <= new Date(y, m, 0).getDate(); day++) {
        const ds = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        batt += battKwh(ds);
        pv += pvKwhDay(ds);
        producedYear += pvProducedDay(ds);
      }
      return { label: r.label, grid: r.importKwh, batt: r2(batt), pv: r2(pv) };
    });
    pvProducedKwhSum = r2(producedYear);
    battKwhSum = r2(bars.reduce((a, b) => a + b.batt, 0));
    pvKwhSum = r2(bars.reduce((a, b) => a + b.pv, 0));
  }

  const hasData = gridKwh > 0 || battKwhSum > 0 || pvKwhSum > 0;
  res.json({
    ok: true,
    data: {
      label,
      hasData,
      hasEarlier: earliest != null && periodStart != null && periodStart > earliest,
      homeKwh: r2(gridKwh + battKwhSum + pvKwhSum),
      gridKwh,
      battKwh: battKwhSum,
      pvKwh: pvKwhSum,
      pvProducedKwh: pvProducedKwhSum,
      gridEur: eur(gridKwh),
      battEur: eur(battKwhSum),
      pvEur: eur(pvKwhSum),
      savedEur: savedEur(pvProducedKwhSum, tariff),
      bars,
    },
  });
});

// Wrap cloud calls: 503 when credentials are missing, 502 for Anker errors.
function cloudRoute(handler) {
  return async (req, res) => {
    try {
      res.json({ ok: true, data: await handler(req) });
    } catch (err) {
      if (err instanceof AnkerApiError) {
        const status = !anker.configured ? 503 : err.rateLimited ? 429 : 502;
        res.status(status).json({ ok: false, error: err.message });
      } else {
        console.error("[cloud] unexpected error:", err);
        res.status(500).json({ ok: false, error: "internal error" });
      }
    }
  };
}

app.get("/api/cloud/sites", cloudRoute(() => anker.getSiteList()));
app.get(
  "/api/cloud/scene",
  cloudRoute((req) => {
    if (!req.query.site_id) throw new AnkerApiError("missing site_id query parameter");
    return anker.getSceneInfo(req.query.site_id);
  }),
);
app.get("/api/cloud/devices", cloudRoute(() => anker.listDevices()));
app.get("/api/cloud/bind-devices", cloudRoute(() => anker.getBindDevices()));

// Welcome tab: AI briefing (geocode + weather + PVGIS + consumption + battery,
// one structured AI call, 6 h cache). Deps read live in-memory state lazily
// (latestBattery is declared later in this file — the closure only runs at
// request time, after module evaluation finished).
registerWelcomeRoute(app, {
  getLiveBattery: () => latestBattery ?? getLatestBattery(),
  getMeterSn: () => poller.snapshot?.meter?.sn ?? getAnyDeviceSn(),
  getLivePower: () => poller.snapshot?.primary?.totalPower ?? null,
  getPowerPlanState: () => powerPlan.getState(),
});

// ROI tab: payback of the BOM investment from measured savings, DB only.
registerRoiRoute(app, {
  getMeterSn: () => poller.snapshot?.meter?.sn ?? getAnyDeviceSn(),
  getBatterySn: () => latestBattery?.sn ?? getBatterySn(poller.snapshot?.meter?.sn ?? getAnyDeviceSn()),
});

// Battery tab: all battery parameters in one route (see battery-params.js).
// The deps closure reads latestBattery lazily at request time.
registerBatteryParamsRoute(app, {
  anker,
  getLiveBattery: () => latestBattery ?? getLatestBattery(),
});
app.get(
  "/api/cloud/energy",
  cloudRoute((req) => {
    const { site_id, device_sn, device_type, type, start, end } = req.query;
    if (!site_id) throw new AnkerApiError("missing site_id query parameter");
    return anker.getEnergyAnalysis({
      siteId: site_id,
      deviceSn: device_sn ?? "",
      deviceType: device_type ?? "grid",
      type: type ?? "day",
      startTime: start ?? localDate(),
      endTime: end ?? "",
    });
  }),
);

app.get(
  "/api/cloud/device-energy",
  cloudRoute((req) => {
    const { device_sn, device_type, type, start, end } = req.query;
    if (!device_sn) throw new AnkerApiError("missing device_sn query parameter");
    return anker.getDeviceEnergyAnalysis({
      deviceSn: device_sn,
      deviceType: device_type ?? "grid",
      type: type ?? "day",
      startTime: start ?? localDate(),
      endTime: end ?? "",
    });
  }),
);

// Local-history variant: serves from SQLite, refreshing from the cloud only
// when the requested period is missing or older than CLOUD_CACHE_MS.
const CLOUD_CACHE_MS = 15 * 60 * 1000;

app.get(
  "/api/local/device-energy",
  cloudRoute(async (req) => {
    const { device_sn, type = "day", start, end = "" } = req.query;
    if (!device_sn) throw new AnkerApiError("missing device_sn query parameter");
    const startTime = start ?? localDate();

    let cached = getCloudTrend(device_sn, type, startTime);
    if (!cached.rows.length || Date.now() - cached.fetchedAt > CLOUD_CACHE_MS) {
      try {
        const data = await anker.getDeviceEnergyAnalysis({
          deviceSn: device_sn,
          type,
          startTime,
          endTime: end,
        });
        saveCloudTrend(device_sn, type, startTime, data?.data_trend ?? []);
        cached = getCloudTrend(device_sn, type, startTime);
      } catch (err) {
        // Refresh failed (rate limit, account lock) — serve the stale cache
        // if we have one instead of hard-failing the request.
        if (!cached.rows.length) throw err;
        console.warn(`[cloud] device-energy refresh failed, serving stale cache: ${err.message}`);
      }
    }
    return { data_trend: cached.rows };
  }),
);

// Refresh the current day/week/month/year in the background so the UI always
// reads from the local DB. 4 sequential calls every 15 min stays well below
// Anker's rate limits.
async function syncCloudHistory() {
  const sn = poller.snapshot?.meter?.sn;
  if (!sn || !anker.configured) return;
  const now = new Date();
  const iso = localDate;
  // Anker expects the week range to be the calendar week (Monday..Sunday) —
  // arbitrary 7-day spans fail with "-1 Failed to request".
  const monday = new Date(now);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const jobs = [
    { type: "day", startTime: iso(now), endTime: "" },
    { type: "week", startTime: iso(monday), endTime: iso(sunday) },
    { type: "month", startTime: iso(now).slice(0, 7), endTime: "" },
    { type: "year", startTime: iso(now).slice(0, 4), endTime: "" },
  ];
  for (const j of jobs) {
    try {
      const data = await anker.getDeviceEnergyAnalysis({ deviceSn: sn, ...j });
      saveCloudTrend(sn, j.type, j.startTime, data?.data_trend ?? []);
      lastCloudOkAt = Date.now();
    } catch (err) {
      console.warn(`[cloud-sync] ${j.type} failed: ${err.message}`);
      break; // likely rate-limited or login issue — stop this round
    }
  }

  // Battery (Solarbank) day trend via the site-level v1 endpoint (the v2
  // device endpoint rejects device_type=solarbank). Different payload shape:
  // {power: [{time, value}]} → mapped onto the shared cloud_history rows.
  // Sync today + yesterday so week/month tiles have complete battery days.
  if (latestBattery?.sn && latestBattery.siteId) {
    for (const dayOffset of [0, 1]) {
      const d = new Date(now.getTime() - dayOffset * 86400000);
      const day = iso(d);
      try {
        const data = await anker.getEnergyAnalysis({
          siteId: latestBattery.siteId,
          deviceSn: latestBattery.sn,
          deviceType: "solarbank",
          type: "day",
          startTime: day,
          endTime: "",
        });
        const rows = (data?.power ?? []).map((p) => ({
          time: p.time,
          power: p.value,
          import_energy: "",
          export_energy: "",
        }));
        saveCloudTrend(latestBattery.sn, "day", day, rows);
      } catch (err) {
        console.warn(`[cloud-sync] battery day ${day} failed: ${err.message}`);
      }
    }

    // PV production day trend, site-level device_type "solar_production" —
    // ground truth for backfilling local battery_snapshots gaps
    // (integrateBatteryEnergy's gaps, see /api/stats/overview and
    // AGENTS.md 2026-09-16): Anker's cloud records this independently of
    // whether OUR poller was running. Kept in its own table (cloud_pv_history)
    // since it's site-wide, not per-device — see saveCloudPvTrend.
    for (const dayOffset of [0, 1]) {
      const d = new Date(now.getTime() - dayOffset * 86400000);
      const day = iso(d);
      try {
        const data = await anker.getEnergyAnalysis({
          siteId: latestBattery.siteId,
          deviceSn: latestBattery.sn ?? "",
          deviceType: "solar_production",
          type: "day",
          startTime: day,
          endTime: "",
        });
        const rows = (data?.power ?? []).map((p) => ({ time: p.time, power: p.value }));
        saveCloudPvTrend("day", day, rows);
      } catch (err) {
        console.warn(`[cloud-sync] solar production day ${day} failed: ${err.message}`);
      }
    }
  }
}

// On startup: fill gaps in the daily history (days the server was off), then
// refresh the current week/month/year. Throttled to ~10 calls/min to stay
// under Anker's per-endpoint rate limit.
const BACKFILL_DAYS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function catchUpCloudHistory() {
  const sn = poller.snapshot?.meter?.sn;
  if (!sn || !anker.configured) return;

  const stored = getStoredPeriodStarts(sn, "day");
  const missing = [];
  for (let i = BACKFILL_DAYS; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const start = localDate(d);
    // Today is always refreshed — its trend grows during the day.
    if (!stored.has(start) || i === 0) missing.push(start);
  }

  if (missing.length) {
    console.log(`[cloud-sync] backfilling ${missing.length} day(s) of history…`);
    for (const start of missing) {
      try {
        const data = await anker.getDeviceEnergyAnalysis({
          deviceSn: sn,
          type: "day",
          startTime: start,
          endTime: "",
        });
        saveCloudTrend(sn, "day", start, data?.data_trend ?? []);
      } catch (err) {
        console.warn(`[cloud-sync] backfill day ${start} failed: ${err.message}`);
        break; // rate-limited or login issue — leave rest for the next round
      }
      await sleep(6000);
    }
  }

  await syncCloudHistory();
  console.log("[cloud-sync] local history is up to date");
}

// Same idea as catchUpCloudHistory, but for the site-level battery
// ("solarbank") and PV production ("solar_production") day-trends —
// separate function because it needs latestBattery (populated by the
// battery's own REST/MQTT sync, on a different timeline than the meter's
// first snapshot that gates catchUpCloudHistory). Without this, a server
// down for several consecutive days would only ever recover the MOST
// RECENT day automatically (syncCloudHistory's ongoing today+yesterday
// refresh) — older missed days would silently stay uncovered forever, the
// same class of problem AGENTS.md documents for 2026-09-16's gap, just at
// a longer timescale (2026-09-16, user follow-up: "will it check the
// online account and recover as much as it can" for ANY future outage).
async function catchUpBatteryPvHistory() {
  if (!latestBattery?.sn || !latestBattery.siteId) return;

  const storedBatt = getStoredPeriodStarts(latestBattery.sn, "day");
  const storedPv = getStoredPvPeriodStarts("day");
  const missing = [];
  for (let i = BACKFILL_DAYS; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const start = localDate(d);
    if (!storedBatt.has(start) || !storedPv.has(start) || i === 0) missing.push(start);
  }
  if (!missing.length) return;

  console.log(`[cloud-sync] backfilling ${missing.length} day(s) of battery/PV history…`);
  for (const start of missing) {
    try {
      const battData = await anker.getEnergyAnalysis({
        siteId: latestBattery.siteId,
        deviceSn: latestBattery.sn,
        deviceType: "solarbank",
        type: "day",
        startTime: start,
        endTime: "",
      });
      const battRows = (battData?.power ?? []).map((p) => ({
        time: p.time,
        power: p.value,
        import_energy: "",
        export_energy: "",
      }));
      saveCloudTrend(latestBattery.sn, "day", start, battRows);
    } catch (err) {
      console.warn(`[cloud-sync] battery backfill day ${start} failed: ${err.message}`);
      break; // rate-limited or login issue — leave rest for the next round
    }
    await sleep(6000);

    try {
      const pvData = await anker.getEnergyAnalysis({
        siteId: latestBattery.siteId,
        deviceSn: latestBattery.sn ?? "",
        deviceType: "solar_production",
        type: "day",
        startTime: start,
        endTime: "",
      });
      const pvRows = (pvData?.power ?? []).map((p) => ({ time: p.time, power: p.value }));
      saveCloudPvTrend("day", start, pvRows);
    } catch (err) {
      console.warn(`[cloud-sync] PV backfill day ${start} failed: ${err.message}`);
      break;
    }
    await sleep(6000);
  }
  console.log("[cloud-sync] battery/PV history is up to date");
}

// Wait for the first meter snapshot (for the SN), then catch up once and
// keep history fresh every 15 minutes.
const syncStarter = setInterval(() => {
  if (poller.snapshot?.meter?.sn) {
    clearInterval(syncStarter);
    catchUpCloudHistory();
    setInterval(syncCloudHistory, CLOUD_CACHE_MS).unref();
  }
}, 10000);
syncStarter.unref();

// Wait separately for the battery's own SN/site (populated by REST/MQTT
// sync, not the meter poller) before attempting its history catch-up.
const battPvSyncStarter = setInterval(() => {
  if (latestBattery?.sn && latestBattery.siteId) {
    clearInterval(battPvSyncStarter);
    catchUpBatteryPvHistory();
  }
}, 10000);
battPvSyncStarter.unref();

// Single-port mode: serve the built frontend (web/dist) and fall back to
// index.html for non-API GETs (SPA). In dev, Vite on :5173 is used instead.
app.use(express.static(WEB_DIST));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
  res.sendFile(path.join(WEB_DIST, "index.html"), (err) => err && next());
});

const server = app.listen(PORT, () => {
  console.log(`[server] API on http://localhost:${PORT}`);
});server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[server] port ${PORT} is already in use — another instance running? ` +
        `Stop it first (or run: lsof -nP -iTCP:${PORT} -sTCP:LISTEN to find it).`,
    );
    process.exit(1);
  }
  throw err;
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify(poller.getState()));
});
poller.onSnapshot((state) => {
  if (state.snapshot) {
    try {
      saveSnapshot(state.snapshot);
    } catch (err) {
      console.warn("[db] failed to persist snapshot:", err.message);
    }
  }
  const msg = JSON.stringify(state);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
});

// Prune samples older than the retention window once an hour; also roll up
// PV daily energy (raw battery samples age out after 48 h).
pruneOld();
pruneBattery();
pruneCloudGrid();
rollupPvDaily();
setInterval(() => {
  pruneOld();
  pruneBattery();
  pruneCloudGrid();
  rollupPvDaily();
}, 3600 * 1000).unref();

// Battery (Solarbank) live data: MQTT push (~3-5 s, same channel as the Anker
// app) is the primary source once connected; the 30 s REST scen_info sync is
// the baseline/fallback and also discovers the battery SN needed for MQTT.
let latestBattery = null;
let lastCloudOkAt = null; // last successful cloud call (for the cloud badge)
let batteryMqtt = null;

function startBatteryMqtt() {
  if (batteryMqtt || !latestBattery?.sn) return;
  batteryMqtt = new AnkerMqtt(anker, latestBattery.sn);
  batteryMqtt.onData = (d) => {
    // Same shape as the REST sync payload, preserving name/siteId.
    latestBattery = { ...latestBattery, ...d };
    lastCloudOkAt = Date.now();
    try {
      saveBatterySnapshot(latestBattery);
    } catch (err) {
      console.warn("[db] failed to persist battery snapshot:", err.message);
    }
  };
  batteryMqtt.start(); // never rejects — retries internally with backoff
}

async function syncBattery() {
  if (!anker.configured) return;
  try {
    const info = await anker.getBatteryInfo();
    if (info) {
      // REST has no temperature field — carry the last MQTT-sourced value
      // forward instead of blanking it on every 10 s REST sync.
      latestBattery = { ...info, temperatureC: latestBattery?.temperatureC ?? null };
      lastCloudOkAt = Date.now();
      saveBatterySnapshot(latestBattery);
      // Grid channel from the same call — the best available source when
      // Modbus is down; graphs merge it below local snapshots.
      if (info.gridToHomeW != null) {
        try {
          saveCloudGridSnapshot(info);
        } catch (err) {
          console.warn("[db] failed to persist cloud grid sample:", err.message);
        }
      }
      startBatteryMqtt();
    }
  } catch (err) {
    console.warn(`[battery] sync failed: ${err.message}`);
  }
}
// Background-first (2026-09-14): the server always pulls — clients just read
// what's in memory/DB. Unconditional 10 s scen_info cadence (6 calls/min,
// safely inside the ~10-12/min guideline); MQTT push layers on top as the
// fast channel. (The Anker app itself gets its live view over MQTT.)
setTimeout(syncBattery, 10 * 1000);
setInterval(syncBattery, 10 * 1000).unref();

// While Modbus is down, keep today's cloud day-trend fresh (1 call / 2 min —
// far inside the endpoint's rate limit) so the /api/flow + /api/live fallback
// stays recent. The 15-min cycle covers the normal case.
setInterval(async () => {
  if (poller.getState().connected || !anker.configured) return;
  const sn = poller.snapshot?.meter?.sn ?? getAnyDeviceSn();
  if (!sn) return;
  try {
    const data = await anker.getDeviceEnergyAnalysis({
      deviceSn: sn,
      type: "day",
      startTime: localDate(),
      endTime: "",
    });
    saveCloudTrend(sn, "day", localDate(), data?.data_trend ?? []);
  } catch (err) {
    console.warn(`[cloud-sync] meter-down today refresh failed: ${err.message}`);
  }
}, 2 * 60 * 1000).unref();

// Power-plan controller: drives the Solarbank output preset from our own
// algorithm instead of the static Anker-app schedule (see power-plan.js).
// Tick on every battery sync (10 s cadence); the controller itself decides
// whether a rewrite is warranted.
const powerPlan = new PowerPlanController(anker, () => latestBattery ?? getLatestBattery());

app.get("/api/power-plan", (req, res) => {
  res.json(powerPlan.getState());
});
app.post("/api/power-plan/enable", async (req, res) => {
  try {
    if (!anker.configured) throw new Error("cloud not configured");
    await powerPlan.enable();
    res.json(powerPlan.getState());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
app.post("/api/power-plan/disable", async (req, res) => {
  try {
    await powerPlan.disable();
    res.json(powerPlan.getState());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
app.post("/api/power-plan/strategy", (req, res) => {
  const { strategy, trigger, manualDischarge } = req.body ?? {};
  const strategies = ["house_priority", "battery_priority"];
  const triggers = ["auto", "manual"];
  if (strategy !== undefined && !strategies.includes(strategy)) {
    return res.status(400).json({ error: `invalid strategy: ${strategy}` });
  }
  if (trigger !== undefined && !triggers.includes(trigger)) {
    return res.status(400).json({ error: `invalid trigger: ${trigger}` });
  }
  if (manualDischarge !== undefined && typeof manualDischarge !== "boolean") {
    return res.status(400).json({ error: `invalid manualDischarge: ${manualDischarge}` });
  }
  powerPlan.setStrategy({ strategy, trigger, manualDischarge });
  res.json(powerPlan.getState());
});

setInterval(() => {
  const homeLoadW = refreshHomeConsumption();
  powerPlan.tick(latestBattery ? { ...latestBattery, homeLoadW } : latestBattery);
}, 10 * 1000).unref();

poller.start();

let shuttingDown = false;
function gracefulShutdown() {
  // Second signal forces an immediate exit.
  if (shuttingDown) process.exit(1);
  shuttingDown = true;

  poller.stop();
  batteryMqtt?.stop();
  // WebSocket clients would keep server.close() waiting forever — kill them.
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close(() => process.exit(0));
  // Last resort if anything still refuses to close.
  setTimeout(() => process.exit(0), 1000).unref();
}
// Docker and launchd stop services with SIGTERM; Ctrl+C sends SIGINT.
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
