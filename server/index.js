// MUST be the first import — see env.js for why (ES module import
// hoisting means this has to run before power-plan.js/anker-cloud.js/etc.
// are evaluated, not just before this file's OWN body runs).
import "./env.js";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { MeterPoller } from "./modbus.js";
import { AnkerClient, AnkerApiError } from "./anker-cloud.js";
import { AnkerMqtt } from "./mqtt.js";
import { registerWelcomeRoute } from "./welcome.js";
import { registerRoiRoute } from "./roi.js";
import { registerBatteryParamsRoute, deriveBatteryFlow, getBatteryLimits, resolveConstants } from "./battery-params.js";
import { registerStatsRoute } from "./stats.js";
import { pvKwhForDay } from "./welcome-ai.js";
import { PowerPlanController } from "./power-plan.js";
import {
  saveSnapshot,
  pruneOld,
  getHistory,
  saveCloudTrend,
  getCloudTrend,
  getStoredPeriodStarts,
  getSnapshotBuckets,
  getCloudDayPower,
  getAnyDeviceSn,
  getBatterySns,
  saveBatterySnapshot,
  getLatestBattery,
  getBatteryHistory,
  getPvStringKwhForDay,
  saveCloudPvTrend,
  getStoredPvPeriodStarts,
  pruneBattery,
  savePvDaily,
  saveGridDaily,
  getSnapshotRows,
  saveCloudGridSnapshot,
  getCloudGridRows,
  pruneCloudGrid,
  getPvDaily,
  getCloudPvDayPower,
} from "./db.js";

const PORT = Number(process.env.PORT ?? 3001);
// Root package.json version — piggybacked on every WS live push so a stale
// open browser tab (old JS bundle from before a deploy) reloads itself
// instead of silently running the old code forever (2026-09-22, user
// report: "the UI still updates at 5 s" — the server was already pushing
// at 2 s; their tab simply predated the deploy).
// NEVER let this cosmetic lookup take the server down: the Docker runtime
// stage only copies server/ + web/dist, so ../package.json may not exist
// (2026-09-22 incident: v1.5.42 crashed on boot in Docker for exactly this
// reason — production down; the Dockerfile now also copies it, but this
// fallback must hold regardless).
let APP_VERSION = "unknown";
try {
  APP_VERSION = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
} catch {
  console.warn("[init] root package.json not found — WS pushes will report v=unknown");
}
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
  // POLL_INTERVAL_MS: poll cadence (default 1000 — the AE1X0's registers
  // update at ~1 s, so this is the fastest cadence that yields new values;
  // 2026-09-22: lowered 5000 → 2000 → 1000 as the live UI moved to WS push,
  // user asked for sub-second "like the Anker app". Set 500 to experiment —
  // below ~1 s you mostly re-read the same register value. 3 batch reads
  // per cycle, trivial for LAN Modbus TCP even at 1 s). MODBUS_TRANSIENT=true:
  // connect-read-disconnect per cycle so two instances can share the meter.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 1000),
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
// Identity anchor for site resolution (2026-09-24): with two sites on the
// account, the app belongs to the site containing OUR meter — never a
// positional guess (site_list[0] now returns the SB4's site).
anker.getMeterSn = () => poller.snapshot?.meter?.sn ?? getAnyDeviceSn();

// All battery SNs ever seen (live one first): history aggregation spans the
// 2026-09-26 Plus→Pro swap — pre-swap days live under the old SN, so stats
// and ROI must query both.
function batterySns() {
  const meterSn = poller.snapshot?.meter?.sn ?? getAnyDeviceSn();
  return [...new Set([latestBattery?.sn, ...getBatterySns(meterSn)].filter(Boolean))];
}

const app = express();
app.use(express.json());

// Display smoothing for the grid reading (2026-09-22, user report: "the
// grid doesn't reflect the Anker app at all"). The raw 1 s meter samples
// jitter ±20-25 W around zero and flip sign constantly — phase-shifted
// flicker: the single-phase inverter feeds L1 (~-100 W export there) while
// the loads sit on L3 (~+60 W import), so the net total swings wildly even
// when physically steady. Verified: local register vs the cloud channel
// disagreed on SIGN constantly at near-zero flow; the Anker app presents a
// smoothed value, we showed raw 1 s jitter. A short rolling mean on the
// DISPLAY path only (/api/live, /api/flow, WS pushes) matches Anker's
// presentation. RAW samples stay untouched: the DB (graphs, stats,
// gridTracking) keeps the true 1 s series, and getGridLive() — the power
// plan's export watchdog input — stays raw because fast correction needs
// the true instantaneous value.
const GRID_DISPLAY_SMOOTH_MS = 5000;
const recentGrid = []; // {ts, total, l1, l2, l3} ring buffer, ~1 s cadence
function noteGridSample(snapshot) {
  const p = snapshot?.primary;
  if (!p || p.totalPower == null) return;
  recentGrid.push({
    ts: Date.now(),
    total: p.totalPower,
    l1: p.phases?.[0]?.power ?? null,
    l2: p.phases?.[1]?.power ?? null,
    l3: p.phases?.[2]?.power ?? null,
  });
  const cutoff = Date.now() - GRID_DISPLAY_SMOOTH_MS;
  while (recentGrid.length && recentGrid[0].ts < cutoff) recentGrid.shift();
}
function getSmoothedGrid() {
  if (!recentGrid.length) return null;
  const mean = (key) => {
    const vals = recentGrid.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length) : null;
  };
  return { power: mean("total"), phases: [{ power: mean("l1") }, { power: mean("l2") }, { power: mean("l3") }] };
}

// Meter state for /api/live AND the WS live push — Modbus down: attach the
// shared grid fallback so both show the SAME cloud value as /api/flow
// (source: cloud-live → live scen_info, cloud → newest closed 20-min
// interval). Meter-sourced values are display-smoothed (see above).
function getLiveState() {
  const state = poller.getState();
  if (state.snapshot) {
    const sm = getSmoothedGrid();
    if (sm) {
      state.snapshot = {
        ...state.snapshot,
        primary: {
          ...state.snapshot.primary,
          totalPower: sm.power,
          // Spread the original phase objects (2026-09-22 code review: the
          // smoothed phases carry only `power` — replacing the array whole
          // stripped each phase's current/voltage and the Live tab's
          // Details rendered "undefined A · undefined V").
          phases: sm.phases.map((sp, i) => ({
            ...state.snapshot.primary.phases?.[i],
            power: sp.power,
          })),
        },
      };
    }
  }
  if (!state.snapshot) {
    const gl = getGridLive();
    if (gl.power != null) state.cloud = gl;
  }
  return state;
}

app.get("/api/live", (req, res) => {
  res.json({ ok: true, data: getLiveState() });
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
      // MQTT telemetry channel diagnostics (2026-09-22: the broker can accept
      // the session while routing ZERO messages — Anker-side stall, seen
      // 2026-09-11 and again 2026-09-22; isFresh() distinguishes
      // connected-but-silent from actually-streaming).
      batteryMqtt: batteryMqtt
        ? {
            connected: batteryMqtt.connected,
            fresh: batteryMqtt.isFresh(),
            lastDataAt: batteryMqtt.lastDataAt,
          }
        : null,
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

// Same rollup for grid import/export energy (meter trapezoid over the raw
// signed 1 s samples — see the grid_daily table comment in db.js for why
// the cloud's export_energy can't be trusted for small residual exports).
// Same yesterday-only policy as rollupPvDaily.
function rollupGridDaily() {
  const today = localDate();
  const dateStr = localDate(new Date(Date.now() - 86400000));
  if (dateStr >= today) return;
  const dayStart = new Date(`${dateStr}T00:00:00`).getTime();
  const rows = getSnapshotRows(dayStart, dayStart + 86400000);
  const MAX_GAP_MS = 30 * 60 * 1000;
  let imp = 0;
  let exp = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (a.grid_total == null || b.grid_total == null) continue;
    const dt = b.ts - a.ts;
    if (dt > MAX_GAP_MS) continue; // real outage — never guess across it
    const avg = (a.grid_total + b.grid_total) / 2;
    const wh = (avg * dt) / 3600000;
    if (avg >= 0) imp += wh;
    else exp += -wh;
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  saveGridDaily(dateStr, r2(imp / 1000), r2(exp / 1000));
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

// The /api/flow payload, extracted so BOTH the REST route and the WebSocket
// live-push (broadcastLive below) share the exact same computation.
// refreshHomeConsumption() is called here (not just on the 10 s tick) so
// WS-pushed updates carry a Home value as fresh as the meter sample that
// triggered them — the despike median-of-3 simply sees more samples.
async function computeFlowPayload() {
  const glRaw = getGridLive();
  // Display-smoothed for the meter source (see GRID_DISPLAY_SMOOTH_MS);
  // cloud sources are already smoothed device-side. getGridLive() itself
  // stays raw for the power plan.
  const gl =
    glRaw.source === "meter" && glRaw.power != null
      ? { ...glRaw, power: getSmoothedGrid()?.power ?? glRaw.power }
      : glRaw;
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
  // Limits for the Live tab's charge/discharge ETA (2026-09-18, user
  // request: "estimate how much time will be full/empty at the current
  // rate... take in account the observed limits, at discharged including
  // the extra amount"). getBatteryLimits() reads the same 6 h-cached
  // account config the Battery tab and power-plan controller already use
  // — normally resolves from cache instantly, so awaiting it here doesn't
  // meaningfully slow this 5 s-polled endpoint. dischargeTolerancePct
  // comes from the SAME power-plan controller instance (not re-derived) —
  // the "extra amount" the controller pads the account floor by before it
  // actually stops discharging (see power-plan.js/BatteryTab.jsx).
  const { dischargeFloorPct, chargeCeilingPct } = await getBatteryLimits(
    anker,
    () => latestBattery ?? getLatestBattery(),
  );
  const dischargeTolerancePct = powerPlan.getState().dischargeTolerancePct ?? 0;
  refreshHomeConsumption(); // keep Home as fresh as the trigger sample
  return {
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
          // Charge/discharge ETA inputs — see the note above the route.
          // floorPct is the EFFECTIVE floor (account discharge floor +
          // the controller's safety margin), not the bare account value —
          // "including the extra amount" per the user's request. Capacity
          // resolves per device (pn) + expansion packs (2026-09-26: Pro +
          // BP5000 = 6.6 kWh).
          capacityKwh: resolveConstants(b.pn, b.expansionPacks).capacityKwh,
          maxPct: chargeCeilingPct,
          floorPct: dischargeFloorPct + dischargeTolerancePct,
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
  };
}

app.get("/api/flow", async (req, res) => {
  // try/catch REQUIRED on every async Express 4 handler (2026-09-22 code
  // review): Express 4 doesn't forward rejected handler promises to its
  // error middleware — a rejection here (e.g. a DB error inside
  // computeFlowPayload) would be an UNHANDLED rejection and crash the
  // process. cloudRoute() already wraps; this handler was the outlier.
  try {
    res.json({ ok: true, data: await computeFlowPayload() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message ?? err) });
  }
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
  const fromDate = localDate(new Date(from - 86400000));
  const toDate = localDate(new Date(to));
  // Anchors reach one cloud interval past the window edges so interpolation
  // can bridge gaps that straddle the boundary (the edge buckets otherwise
  // stay null — a data outage ending just inside the window has no in-window
  // left anchor). Edge anchors are never emitted (output starts at `from`).
  const anchorFrom = from - CLOUD_INTERVAL_MS;
  const sn = poller.snapshot?.meter?.sn;
  if (sn) {
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

  // Source 2b: cloud PV production day-trend (site-level "solar_production",
  // no device SN — see cloud_pv_history in db.js), the SAME real 20-min
  // curve the Anker app itself draws its production history from.
  // `catchUpBatteryPvHistory` already backfills this on startup for the
  // last `BACKFILL_DAYS` (30) days, so it reaches well past the 48h
  // `battery_snapshots` retention — this is what lets 7d/30d zoom show an
  // actual production shape instead of a flat estimate for older days
  // (2026-09-20 user report + follow-up: "in the Anker app I can see...
  // accurate enough to draw some good visualization graphics").
  for (const r of getCloudPvDayPower(fromDate, toDate)) {
    if (r.power == null || r.ts < anchorFrom || r.ts > to) continue;
    if (r.ts + CLOUD_INTERVAL_MS > Date.now()) continue; // open interval
    const bt = Math.floor(r.ts / bucketMs) * bucketMs;
    if (!acc.get(bt)?.pv) add(bt, "pv", r.power);
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

  // Post-pass: beyond the 48h raw-sample retention (RETENTION_MS in db.js),
  // no per-bucket PV signal exists anywhere (unlike Grid, PV has no cloud
  // history fallback) — but pv_daily (populated once/day, kept forever; the
  // same rollup the Dashboard/ROI/top-days already trust) still knows each
  // day's total. Fill still-null buckets with that day's average watts so
  // 7d/30d views show the real historical trend instead of a blank gap
  // (2026-09-20 user report: Power Production showed nothing before the
  // last ~2 days at 30d zoom, even though the Dashboard has that data).
  const missingPvDates = new Set();
  for (const r of data) if (r.pv == null) missingPvDates.add(localDate(new Date(r.t)));
  if (missingPvDates.size) {
    const dates = [...missingPvDates].sort();
    const pvAvgByDate = new Map(
      getPvDaily(dates[0], dates[dates.length - 1]).map((row) => [
        row.date,
        (row.produced * 1000) / 24,
      ]),
    );
    for (const r of data) {
      if (r.pv == null) {
        const avg = pvAvgByDate.get(localDate(new Date(r.t)));
        if (avg != null) r.pv = Math.round(avg * 100) / 100;
      }
    }
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
  // Single source of truth for week/month production-so-far (2026-09-18,
  // user request: the "Right now" card's week/month kWh didn't match what
  // Dashboard showed — they were independently AI/PVGIS-projected instead
  // of reusing Dashboard's own real, already-computed byPeriod numbers).
  // An internal loopback fetch, not a re-derivation — guarantees the
  // Welcome tab can never drift from Dashboard's numbers, and avoids
  // duplicating /api/stats/overview's large, gap-handling-heavy
  // computation a second time.
  statsOverviewUrl: `http://127.0.0.1:${PORT}/api/stats/overview`,
});

// ROI tab: payback of the BOM investment from measured savings, DB only.
registerRoiRoute(app, {
  getMeterSn: () => poller.snapshot?.meter?.sn ?? getAnyDeviceSn(),
  // ALL battery SNs (live one first) — history spans the 2026-09-26
  // Plus→Pro swap; pre-swap days live under the old SN.
  getBatterySns: () => batterySns(),
});

// Dashboard/top-days: same deps shape as registerRoiRoute just above, plus
// getLiveBattery for the one spot (/api/stats/overview) that needs the full
// battery object, not just its SN — same closure welcome.js/
// battery-params.js already use for that.
registerStatsRoute(app, {
  getMeterSn: () => poller.snapshot?.meter?.sn ?? getAnyDeviceSn(),
  getBatterySns: () => batterySns(),
  getLiveBattery: () => latestBattery ?? getLatestBattery(),
});

// Battery tab: all battery parameters in one route (see battery-params.js).
// The deps closure reads latestBattery lazily at request time.
registerBatteryParamsRoute(app, {
  anker,
  getLiveBattery: () => latestBattery ?? getLatestBattery(),
  getSecondBattery: () => latestBattery2,
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
  let completed = true;

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
        completed = false;
        break; // rate-limited or login issue — retry later (below)
      }
      await sleep(6000);
    }
  }

  // Re-arm on incomplete backfill (2026-09-22 code review): the loop used
  // to break with "leave rest for the next round" — but no next round
  // existed until the next restart, so a rate-limit trip left older days
  // permanently missing.
  if (!completed) {
    console.log("[cloud-sync] backfill incomplete — retrying in 1 h");
    setTimeout(() => catchUpCloudHistory(), 3600 * 1000).unref();
    return;
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
  let completed = true;
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
      completed = false;
      break; // rate-limited or login issue — retry later (below)
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
      completed = false;
      break;
    }
    await sleep(6000);
  }
  // Same re-arm as the meter backfill (2026-09-22 code review — the
  // "next round" the break comment promised never existed until restart).
  if (!completed) {
    console.log("[cloud-sync] battery/PV backfill incomplete — retrying in 1 h");
    setTimeout(() => catchUpBatteryPvHistory(), 3600 * 1000).unref();
    return;
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

// Live push over WebSocket (2026-09-22, user request: "the current status
// should be as fast as the Anker app"). The Anker app's live view is
// MQTT-push at ~3-5 s; our Live tab used to POLL /api/live + /api/flow every
// 5 s, adding up to 5 s of pure UI latency on top of every reading. Now the
// server pushes the moment new data exists: on every meter snapshot (5 s
// Modbus) and on every battery update (MQTT 3-5 s / scen_info 10 s),
// battery-triggered pushes throttled to >= 2 s so a chatty MQTT burst can't
// spam clients. Message shape: {type:"live", meter: <poller state, same as
// /api/live's data>, flow: <same as /api/flow's data>}. No other consumer
// existed before this — the WS previously broadcast raw meter state to zero
// listeners — so the format change breaks nothing.
async function buildLiveMessage() {
  return JSON.stringify({
    type: "live",
    v: APP_VERSION, // lets stale open tabs self-reload — see APP_VERSION above
    meter: getLiveState(), // same shape/fallback as /api/live's data
    flow: await computeFlowPayload(), // same as /api/flow's data
  });
}
function broadcastLiveSync(msg) {
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}
let lastBatteryPushAt = 0;
async function broadcastLive({ batteryTriggered = false } = {}) {
  if (!wss.clients.size) return;
  if (batteryTriggered) {
    const now = Date.now();
    if (now - lastBatteryPushAt < 2000) return;
    lastBatteryPushAt = now;
  }
  try {
    broadcastLiveSync(await buildLiveMessage());
  } catch (err) {
    console.warn("[ws] live broadcast failed:", err.message);
  }
}

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  buildLiveMessage()
    .then((msg) => ws.send(msg))
    .catch(() => {});
});
poller.onSnapshot((state) => {
  if (state.snapshot) {
    noteGridSample(state.snapshot); // display smoothing buffer (raw untouched in DB)
    try {
      saveSnapshot(state.snapshot);
    } catch (err) {
      console.warn("[db] failed to persist snapshot:", err.message);
    }
  }
  broadcastLive();
});

// Prune samples older than the retention window once an hour; also roll up
// PV and grid daily energy (raw samples age out after 48 h).
pruneOld();
pruneBattery();
pruneCloudGrid();
rollupPvDaily();
rollupGridDaily();
setInterval(() => {
  pruneOld();
  pruneBattery();
  pruneCloudGrid();
  rollupPvDaily();
  rollupGridDaily();
}, 3600 * 1000).unref();

// Battery (Solarbank) live data: MQTT push (~3-5 s, same channel as the Anker
// app) is the primary source once connected; the 30 s REST scen_info sync is
// the baseline/fallback and also discovers the battery SN needed for MQTT.
let latestBattery = null;
let lastCloudOkAt = null; // last successful cloud call (for the cloud badge)
let batteryMqtt = null;

function startBatteryMqtt() {
  if (!latestBattery?.sn) return;
  // Battery hardware swap (happened 2026-09-26, Plus → Pro): the SN — and
  // possibly the pn — changed under a running process. Rebind instead of
  // watchdog-looping against the old device forever.
  if (batteryMqtt && batteryMqtt.sn !== latestBattery.sn) {
    console.log(`[mqtt] battery changed ${batteryMqtt.sn} -> ${latestBattery.sn}, rebinding`);
    batteryMqtt.stop();
    batteryMqtt = null;
  }
  if (batteryMqtt) return;
  batteryMqtt = new AnkerMqtt(anker, latestBattery.sn, latestBattery.pn ?? "A17C3");
  batteryMqtt.onData = (d) => {
    // Same shape as the REST sync payload, preserving name/siteId.
    latestBattery = { ...latestBattery, ...d };
    lastCloudOkAt = Date.now();
    try {
      saveBatterySnapshot(latestBattery);
    } catch (err) {
      console.warn("[db] failed to persist battery snapshot:", err.message);
    }
    broadcastLive({ batteryTriggered: true }); // MQTT cadence ~3-5 s, throttled inside
  };
  batteryMqtt.start(); // never rejects — retries internally with backoff
}

let syncBatteryInFlight = false;
async function syncBattery() {
  if (!anker.configured) return;
  // In-flight guard (2026-09-22 code review): syncBatteryThrottled stamps
  // its timestamp BEFORE awaiting, so one hung/slow scen_info call used to
  // let both the 10 s baseline and the 1 s fast-path loop stack MORE
  // overlapping calls onto the same rate-limited endpoint — exactly when
  // Anker is already slow. Never stack.
  if (syncBatteryInFlight) return;
  syncBatteryInFlight = true;
  try {
    await syncBatteryInner();
  } finally {
    syncBatteryInFlight = false;
  }
}

async function syncBatteryInner() {
  try {
    const info = await anker.getBatteryInfo();
    if (info) {
      // REST has no temperature field — carry the last MQTT-sourced value
      // forward instead of blanking it on every 10 s REST sync.
      latestBattery = { ...info, temperatureC: latestBattery?.temperatureC ?? null };
      lastCloudOkAt = Date.now();
      saveBatterySnapshot(latestBattery);
      broadcastLive({ batteryTriggered: true }); // REST cadence 10 s, throttled inside
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
// fast channel.
let lastBatterySyncAt = 0;
async function syncBatteryThrottled(minGapMs) {
  if (Date.now() - lastBatterySyncAt < minGapMs) return;
  lastBatterySyncAt = Date.now();
  await syncBattery();
}
setTimeout(syncBattery, 10 * 1000);
setInterval(() => syncBatteryThrottled(10 * 1000), 10 * 1000).unref();

// Second-battery live monitoring — READ-ONLY (2026-09-24): the account
// gained a Solarbank 4 (AE103) on a SEPARATE site ("h-power", with its own
// meter + a Power Dock). It's not part of the house system, so: no control,
// no MQTT (the AE103 field map is unverified), no DB persistence (the
// battery_snapshots PK is `ts` — two batteries would collide). Just a 30 s
// scen_info against the non-primary site, kept in memory for
// /api/battery/params' `batteries[1]`.
let latestBattery2 = null;
let secondarySiteId = null;
let syncSecondBatteryInFlight = false;
async function syncSecondBattery() {
  if (!anker.configured || syncSecondBatteryInFlight) return;
  syncSecondBatteryInFlight = true;
  try {
    if (!secondarySiteId) {
      const primaryId = await anker.resolveSiteId();
      if (!primaryId) return;
      const sites = await anker.getSiteList();
      const other = (sites?.site_list ?? []).find(
        (s) =>
          s.site_id !== primaryId &&
          (s.site_device_list ?? []).some((d) => d.device_type === 3),
      );
      if (!other) return; // single-site account — nothing else to monitor
      secondarySiteId = other.site_id;
      console.log(
        `[battery] second site "${other.site_name}" (${secondarySiteId}) — monitoring its solarbank read-only`,
      );
    }
    const scene = await anker.getSceneInfo(secondarySiteId);
    const sbInfo = scene?.solarbank_info;
    const sb = sbInfo?.solarbank_list?.[0];
    if (!sb) return;
    const num = (v) => (v === "" || v == null ? 0 : Number(v));
    latestBattery2 = {
      ts: Date.now(),
      sn: sb.device_sn,
      name: sb.device_name,
      soc: num(sb.battery_power),
      outputW: num(sb.output_power),
      chargeW: num(sb.bat_charge_power),
      pvW: num(sb.photovoltaic_power),
      pv1W: num(sbInfo?.solar_power_1),
      pv2W: num(sbInfo?.solar_power_2),
      chargingStatus: sb.charging_status ?? null,
    };
    lastCloudOkAt = Date.now();
  } catch (err) {
    console.warn(`[battery2] sync failed: ${err.message}`);
  } finally {
    syncSecondBatteryInFlight = false;
  }
}
setTimeout(syncSecondBattery, 20 * 1000); // after the primary battery sync
setInterval(syncSecondBattery, 30 * 1000).unref();

// Fast path while a frontend is watching (2026-09-22, user report: "the
// Anker app is much faster, our UI is delayed a few seconds, intermediate
// steps are missing"). Investigation that day: Anker's MQTT telemetry
// channel was stalled broker-side AGAIN (the 2026-09-11 pattern — connack/
// suback fine, zero messages routed; confirmed from a dev instance: 120 s
// watchdog reconnect loop with no data while the user's Anker app updated
// happily), so MQTT was delivering NOTHING and our UI ran on the 10 s REST
// cadence. The Anker app gets its live view by POLLING get_scen_info every
// few seconds while its live screen is open — the realtime trigger (0057)
// has no interval field (community CMD_REALTIME_TRIGGER: on/off + timeout
// only), so MQTT can never be made faster than ~3-5 s anyway, and it
// silently degrades to nothing during these broker stalls. Matched here:
// 3 s scen_info cadence whenever at least one WS client is connected (the
// UI is being watched), deduped against the 10 s baseline loop. Above the
// ~10-12/min guideline (~20/min) — same on-demand precedent as the
// modbus-down 3 s sync (failures just log), and exactly the traffic
// pattern the Anker app itself produces.
setInterval(() => {
  if (!wss.clients.size) return;
  // Skip when MQTT is already streaming (2026-09-22 code review): the fast
  // path exists to cover MQTT's ~3-5 s cadence and its silent broker
  // stalls — polling scen_info at ~20/min ON TOP of healthy MQTT is zero
  // informational gain for double the rate-limit exposure. The 10 s
  // baseline keeps running either way (SN discovery + cloud-grid channel).
  if (batteryMqtt?.isFresh?.()) return;
  syncBatteryThrottled(2500);
}, 1000).unref();

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

// Envelope matches the rest of the API ({ok, data}/{ok, error}, same as
// cloudRoute() below) — these four used to return the bare state object on
// success and {error} with no `ok` field on failure, the last holdout of
// that inconsistency (architecture-review roadmap item #4).
app.get("/api/power-plan", (req, res) => {
  res.json({ ok: true, data: powerPlan.getState() });
});
app.post("/api/power-plan/enable", async (req, res) => {
  try {
    if (!anker.configured) throw new Error("cloud not configured");
    await powerPlan.enable();
    res.json({ ok: true, data: powerPlan.getState() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});
app.post("/api/power-plan/disable", async (req, res) => {
  try {
    await powerPlan.disable();
    res.json({ ok: true, data: powerPlan.getState() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});
app.post("/api/power-plan/strategy", (req, res) => {
  const { strategy, trigger, manualDischarge } = req.body ?? {};
  const strategies = ["house_priority", "battery_priority", "anker_app"];
  const triggers = ["auto", "manual"];
  if (strategy !== undefined && !strategies.includes(strategy)) {
    return res.status(400).json({ ok: false, error: `invalid strategy: ${strategy}` });
  }
  if (trigger !== undefined && !triggers.includes(trigger)) {
    return res.status(400).json({ ok: false, error: `invalid trigger: ${trigger}` });
  }
  if (manualDischarge !== undefined && typeof manualDischarge !== "boolean") {
    return res.status(400).json({ ok: false, error: `invalid manualDischarge: ${manualDischarge}` });
  }
  powerPlan.setStrategy({ strategy, trigger, manualDischarge });
  res.json({ ok: true, data: powerPlan.getState() });
});

setInterval(() => {
  const homeLoadW = refreshHomeConsumption();
  // Signed grid + its source for tick()'s export watchdog — only the meter
  // sees true export (see EXPORT_CORRECT_MIN_W's comment in power-plan.js).
  const gl = getGridLive();
  powerPlan.tick(
    latestBattery
      ? { ...latestBattery, homeLoadW, gridW: gl.power, gridSource: gl.source }
      : latestBattery,
  );
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
