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
import { registerDayBriefRoute } from "./daybrief.js";
import { registerRoiRoute } from "./roi.js";
import { registerBatteryParamsRoute, deriveBatteryFlow, getBatteryLimits, systemCapacityKwh } from "./battery-params.js";
import { registerStatsRoute } from "./stats.js";
import { pvKwhForDay } from "./welcome-ai.js";
import { parseWelcomeConfig, geocode, fetchHourlyTemperatures } from "./welcome-sources.js";
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
  getMeterSns,
  getBatterySns,
  saveBatterySnapshot,
  getLatestBattery,
  getBatteryHistory,
  getPvStringKwhForDay,
  saveCloudPvTrend,
  getStoredPvPeriodStarts,
  saveCloudHomeTrend,
  getStoredHomePeriodStarts,
  computeConsumptionProfile,
  wipeCloudHomeHistory,
  pruneBattery,
  savePvDaily,
  saveGridDaily,
  getSnapshotRows,
  saveCloudGridSnapshot,
  getCloudGridRows,
  pruneCloudGrid,
  getPvDaily,
  getCloudPvDayPower,
  getLastNonzeroPvDayBefore,
  getCloudPvDaySum,
  kvGet,
  kvSet,
  saveModuleSnapshot,
  getModuleHistory,
  logActivity,
  getActivity,
  getHistoryVersion,
} from "./db.js";
import { dayBattery, dayGridImportKwh, dayPv } from "./energy-day.js";

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
  // All battery SNs ever seen (db.js now excludes meter SNs by shape, so no
  // meter arg needed — 2026-09-27 meter swap).
  return [...new Set([latestBattery?.sn, ...getBatterySns()].filter(Boolean))];
}

// All meter SNs ever seen (2026-09-27 meter swap, meter-1 → meter-2):
// history aggregates across both (like the battery swap) — they never
// measured the house simultaneously.
function meterSns() {
  return [...new Set([poller.snapshot?.meter?.sn, ...getMeterSns()].filter(Boolean))];
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
      // The deployed app version (2026-10-01, user request: "know what
      // version it is when you make the call") — check THIS before
      // diagnosing a production screenshot; the same value the WS pushes
      // carry for the stale-tab self-reload.
      version: APP_VERSION,
      meterDirect: poller.getState().connected, // Modbus TCP healthy
      cloud: { enabled: anker.configured, lastOkAt: lastCloudOkAt },
      battery: { lastTs: batt?.ts ?? null },
      // MQTT telemetry channel diagnostics (2026-09-22: the broker can accept
      // the session while routing ZERO messages — Anker-side stall, seen
      // 2026-09-11 and again 2026-09-22; isFresh() distinguishes
      // connected-but-silent from actually-streaming).
      batteryMqtt: primaryMqtt()
        ? {
            connected: primaryMqtt().connected,
            fresh: primaryMqtt().isFresh(),
            lastDataAt: primaryMqtt().lastDataAt,
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
  if (b?.gridToHomeW != null && lastRestSyncAt != null && Date.now() - lastRestSyncAt < 60000) {
    return {
      power: b.gridToHomeW - (b.pvToGridW ?? 0), // import minus PV feed-in
      ts: new Date(lastRestSyncAt).toISOString(),
      source: "cloud-live",
    };
  }
  const c = getCloudGridLive();
  if (c) return { power: c.power, ts: c.ts, source: "cloud" };
  return { power: null, ts: null, source: "meter" };
}

// Single source of truth for "how much is the house drawing right now" —
// used by BOTH /api/flow (Live tab) and the power-plan controller/Strategy
// tab. History: 2026-09-17 unified two drifting formulas (power-plan read
// homeLoadW, /api/flow computed meter+outputW) into one despiked function;
// 2026-09-27 flipped the preference to the battery system's OWN
// home_load_power channel (user: "the Anker app shows ~500, ours ~300 and
// oscillates") — the Anker app's own Home Load, from ONE feed with ONE
// timestamp, conditioned device-side, and in the dock era verified live to
// satisfy the physical identity exactly (home_load_power == grid_to_home +
// total_output_power − pv_to_grid on every sample). The meter + outputW
// sum (fast local meter, lagged cloud outputW) oscillated by exactly the
// transition delta at every inverter-output change (the 2026-09-17
// cross-feed artifact class); it stays ONLY as the fallback when the
// battery feed is down, and never when grid itself came FROM the battery
// (cloud-live) — two battery-derived numbers would double up the same lag.
const homeLoadHistory = [];
function despikeHomeLoad(raw) {
  if (raw == null) return raw;
  // Sample on CHANGE only (2026-09-27): this used to push a sample on every
  // WS push, so after each REST refresh the median-of-3 was still dominated
  // by duplicates of the PREVIOUS value for ~2 push cycles — a pure-lag
  // artifact that made Home trail the Anker app by up to ~20 s. A short
  // history is padded with its oldest sample so a lone transient misreport
  // (the 2026-09-17 incident class) is still rejected by the median.
  if (homeLoadHistory[homeLoadHistory.length - 1] !== raw) {
    homeLoadHistory.push(raw);
    if (homeLoadHistory.length > 3) homeLoadHistory.shift();
  }
  const padded =
    homeLoadHistory.length >= 3
      ? homeLoadHistory
      : Array(3 - homeLoadHistory.length).fill(homeLoadHistory[0]).concat(homeLoadHistory);
  const sorted = [...padded].sort((a, b) => a - b);
  return sorted[1];
}
let latestHomeConsumptionW = null;
// The effective discharge floor (account floor + controller margin) as last
// computed by computeFlowPayload — shared with the params route's coverage
// figure via the getFloorPct dep so every "time until empty" in the app
// uses the SAME floor (2026-09-29, user report of contradicting values).
let latestFloorEffPct = null;
function refreshHomeConsumption() {
  const gl = getGridLive();
  // homeLoadW can transiently misreport (2026-09-17 incident) — the
  // change-sampled median-of-3 despike above covers that; the meter path
  // stays for graphs/stats/watchdog, and is the fallback when the battery
  // feed is down or homeLoadW is missing.
  const raw =
    latestBattery?.homeLoadW != null && lastRestSyncAt != null && Date.now() - lastRestSyncAt < 60000
      ? latestBattery.homeLoadW // fresh app channel only — a stale one is worse than the meter fallback (2026-09-29 review)
      : gl.source !== "cloud-live" && gl.power != null && latestBattery?.outputW != null
        ? Math.max(gl.power, 0) + latestBattery.outputW
        : null;
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

// Average daily house consumption (kWh) over the last 7 finished days —
// basis for the battery node's "time to empty" in the flow diagram
// (2026-09-29, user request: "approximated based on a consume of average
// for the last 7 days"). Same validated per-day balance as the Dashboard:
// home = grid import + cells discharge + PV direct-to-home. Memoized 1 h.
let homeAvg7dCache = { at: 0, value: null };
function avgDailyHomeKwh7d() {
  if (homeAvg7dCache.value != null && Date.now() - homeAvg7dCache.at < 3600000)
    return homeAvg7dCache.value;
  // Negative-cache briefly too (2026-09-29 review): with < 3 days of history
  // the result is null and every 1-3 Hz flow push re-ran 21 DB queries.
  if (homeAvg7dCache.value == null && Date.now() - homeAvg7dCache.at < 300000 && homeAvg7dCache.at > 0)
    return null;
  const days = [];
  for (let i = 1; i <= 7; i++) {
    const d = localDate(new Date(Date.now() - i * 86400000));
    days.push(dayGridImportKwh(meterSns(), d) + dayBattery(batterySns(), d).dischargedKwh + dayPv(d).toHome);
  }
  const withData = days.filter((v) => v > 0);
  if (withData.length < 3) {
    homeAvg7dCache = { at: Date.now(), value: null }; // negative-cached (5 min, above)
    return null; // not enough history — honest null
  }
  const avg = withData.reduce((a, v) => a + v, 0) / withData.length;
  homeAvg7dCache = { at: Date.now(), value: Math.round(avg * 100) / 100 };
  return homeAvg7dCache.value;
}

// The /api/flow payload, extracted so BOTH the REST route and the WebSocket
// live-push (broadcastLive below) share the exact same computation.
// refreshHomeConsumption() is called here (not just on the 10 s tick) so
// the CONTROLLER's despiked home value stays as fresh as the trigger
// sample — the DISPLAY no longer uses it (see the diagram block below).
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
  // the extra amount"). getBatteryLimits() reads the same 1 h-cached
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
  const ppState = powerPlan.getState();
  const dischargeTolerancePct = ppState.dischargeTolerancePct ?? 0;
  // The floor for the COVERAGE display figures (diagram node's timeToEmptyH
  // + the params route's coverH via getFloorPct): the DEVICE's own account
  // cutoff, WITHOUT the controller's +3 margin (2026-10-02, user report:
  // the coverage values vanished at 11% SOC — the margin (13%) zeroed them
  // while the battery still held usable energy above its real 10% floor,
  // and a missing line reads as broken). The margin stays where it belongs:
  // the controller's own preset writes (power-plan) and the tile's
  // current-rate "empty in" ETA (battery.floorPct below — the 2026-09-18
  // user request, "including the extra amount"). It is not a property of
  // how much energy the battery can still deliver.
  const floorEffPct = dischargeFloorPct;
  latestFloorEffPct = floorEffPct;
  refreshHomeConsumption(); // keep the controller's despiked value fresh
  // The flow DIAGRAM displays the same channels the Anker app does
  // (2026-09-29, user request — analysis showed our despiked Home lagged
  // the app by up to ~30 s and derived arcs flickered from mixing fields
  // of different freshness): one payload, one timestamp, and the arcs
  // close EXACTLY to the Home node (grid_to_home + to_home_load ==
  // home_load_power, validated twice).
  // appCh = the app's own channels are LIVE (fresh REST sync ≤ 60 s —
  // 2026-09-29 review: previously just "homeLoadW exists", so a cloud
  // outage mid-session froze the diagram/tiles on the last cloud values
  // instead of falling back to the meter). Anything missing/stale falls
  // back to the derived/meter values.
  const appCh =
    b?.homeLoadW != null && lastRestSyncAt != null && Date.now() - lastRestSyncAt < 60000;
  const capKwh = b ? systemCapacityKwh(b) : null;
  const storedKwh = b?.soc != null && capKwh != null ? (b.soc / 100) * capKwh : null;
  const avgKwhDay = avgDailyHomeKwh7d();
  const diagram = {
    homeW: appCh ? b.homeLoadW : latestHomeConsumptionW,
    pvW,
    gridToHomeW: appCh && b.gridToHomeW != null ? b.gridToHomeW : grid != null ? Math.max(grid, 0) : null,
    pvToGridW:
      appCh && b.pvToGridW != null
        ? Math.max(0, b.pvToGridW) // the channel can read small negatives (−7 seen live) — clamp at the source
        : grid != null
          ? Math.max(-grid, 0)
          : null,
    // The arcs ALWAYS close to Home (2026-10-01, user report: "the values
    // don't add up" — PV→Home 159 + Grid ~0 ≠ Home 229): compute pvToHome
    // from the PV-split identity bounded by the house's draw, then let the
    // BATTERY take the balancing remainder — which is exactly the battery's
    // physical role in self-consumption, and how the Anker app's flow reads
    // (it never shows a mismatch). pvToHome can never exceed Home; the
    // battery arc carries whatever PV+grid don't cover, so
    // grid + pvToHome + battToHome == homeW by construction.
    // (bat_discharge_power stays unused — reads 0 while discharging,
    // 2026-09-29.)
    battToHomeW: appCh
      ? Math.max(
          0,
          (b.homeLoadW ?? 0) -
            (b.gridToHomeW ?? 0) -
            Math.max(
              0,
              Math.min(pvW, pvW - chargeW - (b.pvToGridW ?? 0), (b.homeLoadW ?? 0) - (b.gridToHomeW ?? 0)),
            ),
        )
      : cellsW,
    pvToBattW: pvToBattery,
    // Grid-sourced charging (chargeW beyond what PV covers) — the
    // Home→Battery arc (2026-10-03, user report: "PV 89 W but charging
    // 129 W"). The device grid-charges to recover from the floor
    // overnight; the meter sees it (import = home + this), Anker's
    // grid_to_home channel does not — the battery side is the truth.
    homeToBattW: gridChargeW,
    pvToHomeW: appCh
      ? Math.max(
          0,
          Math.min(pvW, pvW - chargeW - (b.pvToGridW ?? 0), (b.homeLoadW ?? 0) - (b.gridToHomeW ?? 0)),
        )
      : pvToHome,
    batterySoc: b?.soc ?? null,
    // Time until the battery reaches its floor at the 7-day average
    // consumption rate — one basis for the node and the params route's
    // coverH (2026-09-29). Clamps to 0 at/below the floor instead of
    // hiding (2026-10-02): a missing line reads as broken, "≈ 0" is the
    // honest answer. null only for genuine unknowns (no data).
    timeToEmptyH: (() => {
      if (storedKwh == null || !avgKwhDay || b?.soc == null) return null;
      const aboveFloorKwh = Math.max(0, ((b.soc - floorEffPct) / 100) * (capKwh ?? 0));
      return Math.round((aboveFloorKwh / (avgKwhDay / 24)) * 10) / 10;
    })(),
    ts: b?.ts ?? null,
  };
  return {
    ts: Date.now(),
    obtainedAt: new Date().toISOString(), // when the server obtained these values
    diagram,
    grid:
      // Tile values follow the SAME app channels as the diagram
      // (2026-09-29, user report: the Grid tile read 992 W "meter direct"
      // while the diagram's arc read 10 W from the cloud channel — the
      // meter and the cloud genuinely differ during device transitions,
      // and the Anker app is always consistent because it shows one
      // payload). The meter stays for DB/graphs/stats/watchdog; the tiles
      // fall back to it only when the battery feed is down.
      appCh
        ? {
            import: b.gridToHomeW != null ? Math.max(b.gridToHomeW, 0) : null,
            export: b.pvToGridW != null ? Math.max(b.pvToGridW, 0) : null,
            ts: b.ts ?? null,
            source: "cloud-live",
          }
        : {
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
          // Cells to the house — the SAME balancing value the diagram's
          // battery→home arc carries (2026-10-01: tile == arc, always).
          cells: diagram.battToHomeW,
          // Charging sourced from the grid (chargeW beyond what PV covers)
          // — the Home→Battery arc, normally 0.
          gridCharge: gridChargeW,
          name: b.name ?? "Solarbank",
          pv1W: b.pv1W ?? 0,
          pv2W: b.pv2W ?? 0,
          // Per-unit PV strings for the Live tab's expanded Solar PV section
          // (2026-09-28, user request): every MPPT channel of every unit,
          // each flagged connected/disconnected (sticky "seen producing"
          // marker). Watts come from MQTT — scen_info's pv_power block is
          // frozen (2026-10-02, see livePvUnits).
          pvUnits: livePvUnits(b),
          // Per-unit live values at push cadence (2026-10-02, user request:
          // the simple view's battery stacks must update as fast as the
          // extended view). Clients rendering units individually merge
          // these by sn instead of waiting for the params poll. cellsW is
          // derived per unit with the same shared deriveBatteryFlow.
          members: (b.members ?? [])
            .filter((m) => m?.sn)
            .map((m) => ({
              sn: m.sn,
              soc: m.soc ?? null,
              chargeW: m.chargeW ?? 0,
              cellsW: deriveBatteryFlow(m).cellsW,
              gridChargeW: deriveBatteryFlow(m).gridChargeW,
              outputW: m.outputW ?? 0,
              temperatureC: m.temperatureC ?? null,
              mainSoc: m.mainSoc ?? null,
              expansions: m.expansions ?? null,
              ts: m.ts ?? null,
            })),
          ts: b.ts ?? null,
          source: "online", // battery data is always cloud (REST/MQTT)
          // Charge/discharge ETA inputs — see the note above the route.
          // floorPct is the EFFECTIVE floor (account discharge floor +
          // the controller's safety margin), not the bare account value —
          // "including the extra amount" per the user's request. Capacity
          // is the whole SYSTEM's (2026-09-27 dock era: sum over all units
          // + packs — SB4 5.0 + Pro 6.6 = 11.6 kWh; resolving from the
          // aggregate's primary pn + summed pack count read 6.6).
          capacityKwh: systemCapacityKwh(b),
          maxPct: chargeCeilingPct,
          floorPct: dischargeFloorPct + dischargeTolerancePct,
        }
      : null,
    pv: {
      production: pvW,
      // Installed peak (PV_PEAK_KWP) — the Live flow's PV node shows the
      // current production as a percentage of it (2026-10-03, user
      // request: "how much of maximum capacity is produced").
      peakW: Math.round(Number(process.env.PV_PEAK_KWP ?? 1) * 1000),
      toBattery: pvToBattery,
      // Same app-channel value as the diagram's PV→Home arc (2026-09-29).
      toHome: diagram.pvToHomeW,
      // Per-string energy today (kWh), integrated locally from the 10 s
      // per-string power samples — the cloud has no per-string kWh.
      pv1KwhToday: getPvStringKwhToday().pv1Kwh,
      pv2KwhToday: getPvStringKwhToday().pv2Kwh,
      ts: b?.ts ?? null,
      source: b ? "online" : null,
    },
    home: {
      // The app's own home_load_power, raw (2026-09-29 — the tile must
      // equal the diagram's Home node; the despiked value stays with the
      // controller). Meter-derived fallback only when the feed is down.
      consumption: appCh ? b.homeLoadW : latestHomeConsumptionW,
      // Usual consumption for this weekday+hour from the 56-day profile
      // (2026-10-03, user request — see refreshConsumptionProfile). null
      // until enough history exists (< 5 usable days).
      usualW: (() => {
        const p = kvGet("consumption_profile_v1")?.value;
        if (!p || (p.daysUsed ?? 0) < 5) return null;
        const now = new Date();
        // Weekday+hour cell first; the all-days hour average is the fallback
        // for cells a young history hasn't produced yet (e.g. this weekday's
        // remaining evening hours on day one).
        return p.cells?.[now.getDay()]?.[now.getHours()] ?? p.cellsAny?.[now.getHours()] ?? null;
      })(),
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
// The timeseries handler is wrapped for the outside-temp merge (its only
// async step — everything else inside stays synchronous).
app.get("/api/timeseries", (req, res) => {
  timeseriesInner(req, res).catch((err) => {
    console.warn(`[timeseries] failed: ${err.message}`);
    res.status(500).json({ ok: false, error: String(err.message ?? err) });
  });
});
async function timeseriesInner(req, res) {
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

  // Source 1d: per-module battery data (MQTT 0405/040a — SOC + temperature
  // per physical module, 2026-09-27) for the Graph tab's module charts. No
  // cloud fallback exists for these (040a is realtime-only): they exist from
  // the MQTT subtopic fix onward, 48h retention.
  const seenModules = new Set();
  for (const r of getModuleHistory(from - CLOUD_INTERVAL_MS, to)) {
    const bt = Math.floor(r.ts / bucketMs) * bucketMs;
    if (r.soc != null) add(bt, `soc__${r.module}`, r.soc);
    if (r.temperature_c != null) add(bt, `temp__${r.module}`, r.temperature_c);
    seenModules.add(r.module);
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
  // getAnyDeviceSn() fallback (2026-09-26): every other call site in this
  // file already uses it — without it, the entire cloud-anchor section
  // (grid AND battery) silently dies whenever Modbus is unreachable, which
  // is exactly when cloud anchors matter most (dev instances never see them
  // at all while production holds the meter's single connection).
  const sns = meterSns();
  if (sns.length) {
    // Meter swap continuity (2026-09-27): merge all meter SNs' cloud rows
    // per timestamp, preferring nonzero — same pattern as the battery
    // anchors below.
    const byTs = new Map();
    for (const msn of sns) {
      for (const r of getCloudDayPower(msn, fromDate, toDate)) {
        if (r.power == null || r.ts < anchorFrom || r.ts > to) continue;
        if (r.ts + CLOUD_INTERVAL_MS > Date.now()) continue; // interval not closed
        const cur = byTs.get(r.ts);
        if (!cur || (cur.power === 0 && r.power !== 0)) byTs.set(r.ts, r);
      }
    }
    const cloudRows = [...byTs.values()].sort((a, b) => a.ts - b.ts);
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
    // ALL battery SNs (2026-09-26 swap): the new SN holds all-zero backfill
    // artifacts for pre-swap days while the old SN holds the real discharge
    // data — the route used to read only the live SN, so the Graph tab lost
    // pre-swap battery history entirely. Prefer-nonzero merge: the two
    // physical batteries never ran simultaneously, so nonzero never
    // conflicts; zeros only fill genuinely empty buckets.
    for (const sn of batterySns()) {
      for (const r of getCloudDayPower(sn, fromDate, toDate)) {
        if (r.power == null || r.ts < anchorFrom || r.ts > to) continue;
        if (r.ts + CLOUD_INTERVAL_MS > Date.now()) continue; // open interval
        const bt = Math.floor(r.ts / bucketMs) * bucketMs;
        const existing = acc.get(bt)?.batt;
        if (!existing || (existing.s === 0 && r.power !== 0)) {
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
      ...Object.fromEntries(
        // Per-module series (2026-09-27): soc__<sn> / temp__<sn> per physical
        // module — dynamic, so every battery + expansion gets its own line.
        Object.entries(b ?? {})
          .filter(([k]) => k.startsWith("soc__") || k.startsWith("temp__"))
          .map(([k, cell]) => [k, round(cell)]),
      ),
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

  // Per-module metadata for the Graph tab's module charts (2026-09-27):
  // every solarbank + every expansion pack, keyed by their physical SNs —
  // matching the soc__<sn>/temp__<sn> fields emitted per bucket above.
  // 2026-09-28 fix (user report: "there should be all 4... why did you
  // remove them"): this list used to come from the LIVE members map alone —
  // but expansions are MQTT-only state, so after any restart with a stalled
  // broker the extension series silently vanished from the charts even
  // though their history sat in module_snapshots. Now built as the UNION of
  // live state (names, order) and the module keys actually present in this
  // window's data — a series renders whenever its data exists.
  const LEGACY_MODULE_KEYS = new Set(["main", "exp1"]); // pre-SN-keyed rows
  const liveModules = [...latestBatteries.values()].flatMap((m) => [
    { sn: m.sn, name: m.name ?? m.sn },
    ...(m.expansions ?? []).map((e, i) => ({
      sn: e.sn ?? `${m.sn}-exp${i + 1}`,
      name: `${m.name ?? m.sn} ext ${i + 1}`,
    })),
  ]);
  const moduleBySn = new Map(liveModules.map((m) => [m.sn, m]));
  const nameFor = (key) => {
    const exp = key.match(/^(.+)-exp(\d+)$/);
    if (exp && moduleBySn.has(exp[1]))
      return `${moduleBySn.get(exp[1]).name} ext ${exp[2]}`;
    return key;
  };
  const modules = [
    ...liveModules,
    ...[...seenModules]
      // -exp with no index: malformed key from an intermediate version
      // (2 stray points, ages out with the 48h retention) — never render it.
      .filter((k) => !moduleBySn.has(k) && !LEGACY_MODULE_KEYS.has(k) && !/-exp$/.test(k))
      .sort()
      .map((k) => ({ sn: k, name: nameFor(k) })),
  ];

  // Outside temperature overlay for the battery-temperature chart: nearest
  // hourly Open-Meteo sample per bucket (hourly source resolution — finer
  // buckets just repeat the hour's value; the chart interpolates visually).
  const outside = await getOutsideTempSeries();
  if (outside?.length) {
    const byHour = new Map(outside.map((r) => [Math.floor(r.tsMs / 3600000), r.tempC]));
    for (const r of data) {
      const v = byHour.get(Math.floor(r.t / 3600000));
      if (v != null) r.outsideTempC = v;
    }
  }

  res.json({ ok: true, bucketMs, data, modules, historyV: getHistoryVersion() });
}

// Outside temperature (Open-Meteo hourly, geocoded from HOME_ADDRESS in
// .env) — overlaid on the Graph tab's battery-temperature chart
// (2026-09-28, user request). Deliberately the same provider/geocoder the
// Welcome tab already uses, NOT HTML scraping of a weather site: same
// address from the config, but a stable API instead of markup that breaks
// on every redesign. KV-cached for 60 min so chart zoom/pan refetches
// (which re-call /api/timeseries constantly) never hammer Open-Meteo.
async function getOutsideTempSeries() {
  const config = parseWelcomeConfig();
  if (!config) return null; // no HOME_ADDRESS — feature silently off
  const key = "outsideTempHourlyV1";
  const hit = kvGet(key);
  if (hit && Date.now() - hit.fetchedAt < 60 * 60 * 1000) return hit.value;
  try {
    const geo = await geocode(config.address);
    const j = await fetchHourlyTemperatures(geo.lat, geo.lon, 31);
    const times = j?.hourly?.time ?? [];
    const temps = j?.hourly?.temperature_2m ?? [];
    const value = times
      .map((t, i) => ({ tsMs: new Date(t).getTime(), tempC: temps[i] }))
      .filter((r) => Number.isFinite(r.tsMs) && r.tempC != null);
    kvSet(key, value);
    return value;
  } catch (err) {
    console.warn(`[weather] outside temperature fetch failed: ${err.message}`);
    return hit?.value ?? null; // a stale series beats none
  }
}

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
  getMeterSns: () => meterSns(),
  getLivePower: () => poller.snapshot?.primary?.totalPower ?? null,
  getPowerPlanState: () => powerPlan.getState(),
  // The Ask context carries everything the simple view shows (2026-10-03,
  // user request) — the flow payload's diagram + per-unit members.
  getFlowPayload: () => computeFlowPayload(),
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

// AI day briefing for the simple view's first section (2026-10-03, user
// request — see server/daybrief.js). Same deps as welcome + the system
// capacity for the end-of-day SOC estimate.
registerDayBriefRoute(app, {
  getLiveBattery: () => latestBattery ?? getLatestBattery(),
  getMeterSn: () => poller.snapshot?.meter?.sn ?? getAnyDeviceSn(),
  getMeterSns: () => meterSns(),
  getLivePower: () => poller.snapshot?.primary?.totalPower ?? null,
  getPowerPlanState: () => powerPlan.getState(),
  getCapacityKwh: () => (latestBattery ? systemCapacityKwh(latestBattery) : null),
  statsOverviewUrl: `http://127.0.0.1:${PORT}/api/stats/overview`,
});

// ROI tab: payback of the BOM investment from measured savings, DB only.
registerRoiRoute(app, {
  getMeterSn: () => poller.snapshot?.meter?.sn ?? getAnyDeviceSn(),
  getMeterSns: () => meterSns(),
  // ALL battery SNs (live one first) — history spans the 2026-09-26
  // Plus→Pro swap; pre-swap days live under the old SN.
  getBatterySns: () => batterySns(),
  // The baseline prompt describes the REAL battery stack (capacity matters
  // for the self-consumption ratio) — built from the live aggregate.
  getLiveBattery: () => latestBattery ?? getLatestBattery(),
});

// Dashboard/top-days: same deps shape as registerRoiRoute just above, plus
// getLiveBattery for the one spot (/api/stats/overview) that needs the full
// battery object, not just its SN — same closure welcome.js/
// battery-params.js already use for that.
registerStatsRoute(app, {
  getMeterSn: () => poller.snapshot?.meter?.sn ?? getAnyDeviceSn(),
  getMeterSns: () => meterSns(),
  getBatterySns: () => batterySns(),
  getLiveBattery: () => latestBattery ?? getLatestBattery(),
});

// Battery tab: all battery parameters in one route (see battery-params.js).
// The deps closure reads latestBattery lazily at request time.
registerBatteryParamsRoute(app, {
  anker,
  getLiveBattery: () => latestBattery ?? getLatestBattery(),
  getMembers: () => [...latestBatteries.values()],
  getAvgHomeKwh7d: avgDailyHomeKwh7d,
  getFloorPct: () => latestFloorEffPct,
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
  // EVERY unit (2026-09-29 review): this used to sync only the PRIMARY SN —
  // the SB4's discharge never landed in cloud_history, undercounting every
  // finished-day battery figure (Dashboard "From battery", top-days, ROI,
  // and the 7-day-average behind coverH/timeToEmptyH).
  if (latestBattery?.sn && latestBattery.siteId) {
    for (const sn of batterySns()) {
      for (const dayOffset of [0, 1]) {
        const d = new Date(now.getTime() - dayOffset * 86400000);
        const day = iso(d);
        try {
          const data = await anker.getEnergyAnalysis({
            siteId: latestBattery.siteId,
            deviceSn: sn,
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
          saveCloudTrend(sn, "day", day, rows);
        } catch (err) {
          console.warn(`[cloud-sync] battery day ${day} (${sn.slice(-4)}) failed: ${err.message}`);
        }
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

    // Home-consumption day trend, site-level device_type "home_usage" —
    // the source for the "usual consumption" profile on the flow diagram's
    // Home node (2026-10-03, user request). Own table (cloud_home_history),
    // same zero-clobber/label guards as the PV trend.
    for (const dayOffset of [0, 1]) {
      const d = new Date(now.getTime() - dayOffset * 86400000);
      const day = iso(d);
      try {
        const data = await anker.getEnergyAnalysis({
          siteId: latestBattery.siteId,
          // device_sn MUST be empty for home_usage (verified 2026-10-03):
          // with a solarbank SN the endpoint returns all-zero trends.
          deviceSn: "",
          deviceType: "home_usage",
          type: "day",
          startTime: day,
          endTime: "",
        });
        const rows = (data?.power ?? []).map((p) => ({ time: p.time, power: p.value }));
        saveCloudHomeTrend("day", day, rows);
      } catch (err) {
        console.warn(`[cloud-sync] home usage day ${day} failed: ${err.message}`);
      }
    }
    // Keep the usual-consumption profile in step with freshly stored trends
    // (2026-10-03 — startup+hourly alone left usualW null for up to an hour
    // after the data actually landed).
    refreshConsumptionProfile();
  }
}

// On startup: fill gaps in the daily history (days the server was off), then
// refresh the current week/month/year. Throttled to ~10 calls/min to stay
// under Anker's per-endpoint rate limit.
const BACKFILL_DAYS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function catchUpCloudHistory() {
  if (!anker.configured) return;
  // Meter swap continuity (2026-09-27): backfill EVERY known meter SN — a
  // freshly-swapped meter starts with no history of its own.
  const sns = meterSns();
  if (!sns.length) return;
  let completed = true;

  for (const sn of sns) {
    const stored = getStoredPeriodStarts(sn, "day");
    const missing = [];
    for (let i = BACKFILL_DAYS; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const start = localDate(d);
      // Today is always refreshed — its trend grows during the day.
      if (!stored.has(start) || i === 0) missing.push(start);
    }

    if (!missing.length) continue;
    console.log(`[cloud-sync] backfilling ${missing.length} day(s) of history for meter ${sn}…`);
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
    if (!completed) break; // stop at the first rate-limited meter, not per-day
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

  const sns = batterySns();
  const storedPv = getStoredPvPeriodStarts("day");
  // 2026-09-26 bug (real data destroyed): the missing-day test used to be
  // "!storedBatt OR !storedPv" — after the Plus→Pro swap the NEW battery SN
  // had NO history, so ALL 31 days counted as missing, and the SITE-LEVEL
  // solar_production fetch for each of those days returned zeros from the
  // freshly-recreated site and upserted them over the real PV history.
  // Compute the two missing sets independently now: a fresh battery SN may
  // trigger 31 battery fetches (harmless — they write under its own SN),
  // but never a site-level PV refetch it has nothing to do with.
  // 2026-09-29 review: per-SN missing sets (was primary-SN-only) — the
  // SB4's day-trend was never synced at all in the dock era.
  const missingBattBySn = new Map();
  const missingPv = [];
  const storedBySn = new Map(sns.map((sn) => [sn, getStoredPeriodStarts(sn, "day")]));
  for (let i = BACKFILL_DAYS; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const start = localDate(d);
    for (const sn of sns) {
      if (i === 0 || !storedBySn.get(sn).has(start)) {
        missingBattBySn.set(sn, [...(missingBattBySn.get(sn) ?? []), start]);
      }
    }
    if (!storedPv.has(start)) missingPv.push(start);
  }
  const totalBatt = [...missingBattBySn.values()].reduce((a, v) => a + v.length, 0);
  if (!totalBatt && !missingPv.length) return;

  console.log(`[cloud-sync] backfilling battery (${totalBatt} day-fetches over ${missingBattBySn.size} unit(s)) + PV (${missingPv.length} day(s)) history…`);
  let completed = true;
  for (const [sn, days] of missingBattBySn) {
    for (const start of days) {
      try {
        const battData = await anker.getEnergyAnalysis({
          siteId: latestBattery.siteId,
          deviceSn: sn,
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
        saveCloudTrend(sn, "day", start, battRows);
      } catch (err) {
        console.warn(`[cloud-sync] battery backfill day ${start} (${sn.slice(-4)}) failed: ${err.message}`);
        completed = false;
        break; // rate-limited or login issue — retry later (below)
      }
      await sleep(6000);
    }
    if (!completed) break;
  }

  if (completed) {
    for (const start of missingPv) {
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
  }

  // Home-usage backfill (2026-10-03 — feeds the "usual consumption"
  // profile): its own missing-day set, same independent-missing rule as PV
  // (2026-09-26 lesson — never let an unrelated fresh SN trigger a
  // site-level refetch).
  if (completed) {
    const storedHome = getStoredHomePeriodStarts("day");
    const missingHome = [];
    // NEWEST-first (2026-10-03 incident): the recreated site returns all-zero
    // trends for every pre-creation day, so oldest-first burned every
    // rate-limited run's budget on known-zero holes and never reached the
    // real recent days the consumption profile is built from.
    for (let i = 0; i <= BACKFILL_DAYS; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const start = localDate(d);
      if (!storedHome.has(start)) missingHome.push(start);
    }
    if (missingHome.length) {
      console.log(`[cloud-sync] backfilling home usage (${missingHome.length} day(s))…`);
    }
    for (const start of missingHome) {
      try {
        const homeData = await anker.getEnergyAnalysis({
          siteId: latestBattery.siteId,
          // device_sn MUST be empty for home_usage (verified 2026-10-03).
          deviceSn: "",
          deviceType: "home_usage",
          type: "day",
          startTime: start,
          endTime: "",
        });
        const homeRows = (homeData?.power ?? []).map((p) => ({ time: p.time, power: p.value }));
        saveCloudHomeTrend("day", start, homeRows);
      } catch (err) {
        console.warn(`[cloud-sync] home-usage backfill day ${start} failed: ${err.message}`);
        completed = false;
        break;
      }
      await sleep(6000);
    }
  }
  // Same re-arm as the meter backfill (2026-09-22 code review — the
  // "next round" the break comment promised never existed until restart).
  if (!completed) {
    console.log("[cloud-sync] battery/PV backfill incomplete — retrying in 1 h");
    refreshConsumptionProfile();
    setTimeout(() => catchUpBatteryPvHistory(), 3600 * 1000).unref();
    return;
  }
  console.log("[cloud-sync] battery/PV history is up to date");
  refreshConsumptionProfile();
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

// Activity log (2026-09-27, user request — "some activity log where you log
// these major decisions... and notify"): ONE helper for every emit site —
// persists the structured entry and instantly pushes it to all WS clients
// (the header bell's badge lights up without waiting for a poll).
function activity(kind, params = {}) {
  logActivity(kind, params);
  if (!wss.clients.size) return;
  try {
    const [entry] = getActivity(1);
    if (entry) broadcastLiveSync(JSON.stringify({ type: "activity", entry }));
  } catch (err) {
    console.warn("[ws] activity broadcast failed:", err.message);
  }
}

app.get("/api/activity", (req, res) => {
  res.json({ ok: true, data: getActivity(req.query.limit ?? 50) });
});
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

// One-time repair (kv flag pv_shape_repair_v2): after the
// h-solar site was recreated in the Plus→Pro battery swap, the PV backfill
// upserted all-zero solar_production trends over 12 days of real
// cloud_pv_history (2026-09-14..25) — the flipped Dashboard tiles lost
// their green PV segments (the totals survived via pv_daily). The intraday
// shapes are unrecoverable from the cloud (the old site is deleted and the
// new one returns zeros for pre-creation days), so each affected day is
// rebuilt from pv_daily's REAL produced total (local trapezoid — the most
// accurate figure) distributed over the most recent real day-shape we
// still have. Totals stay exact; only the shape is approximate.
// v2 (2026-09-27): v1 set its flag UNCONDITIONALLY — a startup with no
// reference shape (or zero repaired days) latched the repair off forever,
// which is exactly what happened on production (v1.5.79+ deployed, days
// still zero). The flag now only latches when days were actually repaired
// (or verifiably nothing needs repairing), and every branch logs so the
// server log says what happened on any given boot.
// Physical per-interval power cap for repaired PV days (2026-09-30, user
// report: the v2 repair amplified borrowed shapes past the hardware —
// 2031 W on a 1 kWp day). energy = Σpower/3000 holds via
// cap-and-redistribute: cap each interval at the system's max for that
// date, push the excess into the day's other producing intervals.
// Pre-expansion days (the balcony 2×500 W era, inverter-capped 800 W) get
// 1050 W; later days get the configured PV_PEAK_KWP × 1050 W/kWp... i.e.
// ×1000 ×1.05. The expansion (6 more panels) arrived 2026-09-26+.
const PV_EXPANSION_DATE = "2026-09-26";
function pvRepairCapW(dateStr) {
  const kwp = dateStr < PV_EXPANSION_DATE ? 1.0 : Number(process.env.PV_PEAK_KWP ?? 1.0);
  return Math.round(kwp * 1000 * 1.05);
}
function capAndRedistribute(vals, capW) {
  const out = [...vals];
  for (let pass = 0; pass < 10; pass++) {
    let excess = 0;
    const under = [];
    for (let i = 0; i < out.length; i++) {
      if (out[i] > capW) {
        excess += out[i] - capW;
        out[i] = capW;
      } else if (out[i] > 0) {
        under.push(i);
      }
    }
    if (excess < 1 || !under.length) break;
    const share = excess / under.length;
    for (const i of under) out[i] += share;
  }
  return out.map((v) => Math.round(v * 10) / 10);
}
function repairPvDay(dateStr, shape, shapeSum, producedKwh) {
  const scale = (producedKwh * 3000) / shapeSum;
  const powers = capAndRedistribute(shape.map((s) => s.power * scale), pvRepairCapW(dateStr));
  saveCloudPvTrend(
    "day",
    dateStr,
    shape.map((s, i) => ({
      time: new Date(s.ts).toTimeString().slice(0, 8),
      power: powers[i],
    })),
  );
}

function repairZeroedPvHistory() {
  if (kvGet("pv_shape_repair_v2")) return;
  const todayStr = localDate();
  // Reference shape: latest COMPLETE real day. Today itself qualifies only
  // once it's dark (hour ≥ 20 — September PV is long over by then), so a
  // deploy tonight repairs now while a midday deploy waits for the next
  // restart instead of borrowing a half-drawn curve.
  let shapeDay = getLastNonzeroPvDayBefore(todayStr);
  if (!shapeDay && new Date().getHours() >= 20 && getCloudPvDaySum("day", todayStr) > 0) {
    shapeDay = todayStr;
  }
  if (!shapeDay) {
    console.log("[cloud-sync] PV-history repair: no reference shape in cloud_pv_history yet — will retry on next restart");
    return;
  }
  const shape = getCloudPvDayPower(shapeDay, shapeDay).filter((r) => r.power != null);
  const shapeSum = shape.reduce((a, r) => a + r.power, 0);
  if (!shape.length || shapeSum <= 0) {
    console.log(`[cloud-sync] PV-history repair: shape day ${shapeDay} is empty — will retry on next restart`);
    return;
  }
  let repaired = 0;
  let remaining = 0;
  for (const d of getPvDaily("2020-01-01", todayStr)) {
    if (d.date >= todayStr || !(d.produced > 0)) continue;
    if (getCloudPvDaySum("day", d.date) > 0) continue; // day is intact
    remaining++;
    repairPvDay(d.date, shape, shapeSum, d.produced);
    repaired++;
  }
  if (repaired > 0 || remaining === 0) {
    kvSet("pv_shape_repair_v2", { repaired, shapeDay, at: Date.now() });
  }
  if (repaired) {
    activity("pv_history_repaired", { n: repaired, shapeDay });
    console.log(
      `[cloud-sync] repaired ${repaired} zeroed PV-history day(s) from pv_daily totals ` +
        `(shape borrowed from ${shapeDay} — totals exact, shape approximate)`,
    );
  } else if (remaining === 0) {
    console.log("[cloud-sync] PV-history repair: nothing to repair — all days intact");
  } else {
    console.log(
      `[cloud-sync] PV-history repair: 0 repaired (shape ${shapeDay}, ${remaining} zeroed candidate day(s)) — will retry on next restart`,
    );
  }
}

// v3 (2026-09-30, user report: "there was not such high momentary
// production in the past" — 30d PV spikes to ~2100 W): v2 amplified the
// borrowed shape past the hardware's physical max on days whose produced
// total exceeded the shape day's. Re-repair any day whose stored peak
// exceeds the physical cap with cap-and-redistribute (totals stay exact).
// Also fixes the downstream artifact: the Battery chart's impossible
// −1500..−2000 W "charging" needles were cellsNetOf = battOut − pvHome
// computed against the inflated PV.
function repairInflatedPvDays() {
  if (kvGet("pv_shape_repair_v3")) return;
  const todayStr = localDate();
  const shapeDay = getLastNonzeroPvDayBefore(todayStr);
  if (!shapeDay) return; // nothing to base shapes on — retry next restart
  const shape = getCloudPvDayPower(shapeDay, shapeDay).filter((r) => r.power != null);
  const shapeSum = shape.reduce((a, r) => a + r.power, 0);
  if (!shape.length || shapeSum <= 0) return;
  let repaired = 0;
  for (const d of getPvDaily("2020-01-01", todayStr)) {
    if (d.date >= todayStr || !(d.produced > 0)) continue;
    const rows = getCloudPvDayPower(d.date, d.date);
    if (!rows.length) continue;
    const peak = Math.max(...rows.map((r) => r.power ?? 0));
    if (peak <= pvRepairCapW(d.date)) continue; // plausible day — leave it
    repairPvDay(d.date, shape, shapeSum, d.produced);
    repaired++;
  }
  kvSet("pv_shape_repair_v3", { repaired, at: Date.now() });
  if (repaired) {
    activity("pv_history_repaired", { n: repaired, shapeDay });
    console.log(`[cloud-sync] re-repaired ${repaired} inflated PV-history day(s) (capped at each day's physical max)`);
  } else {
    console.log("[cloud-sync] PV-history v3 check: no inflated days");
  }
}

// Prune samples older than the retention window once an hour; also roll up
// PV and grid daily energy (raw samples age out after 48 h).
pruneOld();
pruneBattery();
pruneCloudGrid();
rollupPvDaily();
rollupGridDaily();
repairZeroedPvHistory();
repairInflatedPvDays();
setInterval(() => {
  pruneOld();
  pruneBattery();
  pruneCloudGrid();
  rollupPvDaily();
  rollupGridDaily();
}, 3600 * 1000).unref();

// Usual-consumption profile for the flow diagram's Home node (2026-10-03,
// user request — "remake the historic values calculations in the backend
// regularly"): average W per (weekday, hour) over the last 56 days of the
// home_usage cloud history, recomputed hourly into kv.
// One-time cleanup (kv flag): the first sync passed the solarbank SN as
// device_sn, which makes home_usage return all-ZERO trends (verified
// 2026-10-03 — the endpoint needs device_sn="") — 31 days of useless zero
// rows were stored. Delete them so the backfill refetches with the fixed
// call (stored zero days would otherwise count as "not missing").
if (!kvGet("home_history_zero_fix_v1")) {
  try {
    wipeCloudHomeHistory();
    kvSet("home_history_zero_fix_v1", { at: Date.now() });
    console.log("[cloud-sync] wiped the all-zero home_usage rows (device_sn bug) — refetching");
  } catch (err) {
    console.warn(`[cloud-sync] home-history cleanup failed: ${err.message}`);
  }
}
function refreshConsumptionProfile() {
  try {
    kvSet("consumption_profile_v1", computeConsumptionProfile(56));
  } catch (err) {
    console.warn(`[profile] recompute failed: ${err.message}`);
  }
}
refreshConsumptionProfile();
setInterval(refreshConsumptionProfile, 3600 * 1000).unref();

// Battery (Solarbank) live data: MQTT push (~3-5 s, same channel as the Anker
// app) is the primary source once connected; the 30 s REST scen_info sync is
// the baseline/fallback and also discovers the battery SN needed for MQTT.
let latestBattery = null; // the AGGREGATE of all solarbanks on the site
let lastCloudOkAt = null; // last successful cloud call (for the cloud badge)
// Last successful REST scen_info sync specifically (2026-09-29 review):
// latestBattery.ts ALSO refreshes on every MQTT merge, so it can't gate
// the REST-sourced channels (grid/home) — a dead REST feed with live MQTT
// would otherwise freeze the grid arcs/tile on stale cloud values forever
// instead of falling back to the meter.
let lastRestSyncAt = null;
// DOCK ERA (2026-09-27): the site carries multiple solarbanks (SB4 on dock
// socket A + SB2 Pro on socket B). latestBatteries holds each unit's own
// live state (REST sync + its own MQTT channel); latestBattery is the
// recomputed aggregate that the flow/power-plan/UI consume unchanged.
const latestBatteries = new Map(); // SN -> per-unit live object
const batteryMqtts = new Map(); // SN -> AnkerMqtt (one client per unit)

// MQTT-only fields (temperature, mainSoc, expansions) survive REST syncs —
// REST has no equivalent and must not blank them (same rule as before,
// now per unit).
// A PV channel counts as "connected" once we've EVER seen it produce
// (> 5 W) — scen_info has no per-channel connection flag (checked the raw
// payload 2026-09-28), and at night every channel reads 0 W, so the marker
// is sticky in kv (`pvSeen:<unitSn>:<n>`). A newly wired string lights up
// with its first sunny hour.
const PV_CONNECTED_MIN_W = 5;
// Sticky "seen producing" marker + connected flag for one channel. watts may
// be null (no live per-string data) — a null never marks a string seen.
function pvSeenConnected(sn, n, watts) {
  const key = `pvSeen:${sn}:${n}`;
  if (watts != null && watts > PV_CONNECTED_MIN_W && kvGet(key) == null) kvSet(key, Date.now());
  return (watts != null && watts > PV_CONNECTED_MIN_W) || kvGet(key) != null;
}
function decoratePvChannels(m) {
  if (!m.pvChannels?.length) return m;
  return {
    ...m,
    pvChannels: m.pvChannels.map((c) => ({ ...c, connected: pvSeenConnected(m.sn, c.n, c.watts) })),
  };
}

// Live per-string watts for /api/flow's pvUnits (2026-10-02, user report:
// PV total 220 W vs per-string sum 21 W). scen_info's pv_power block is
// FROZEN (verified: identical values for 20+ min while photovoltaic_power
// moved) — it is NOT a live channel. MQTT is the only truthful per-string
// source (A17C1 0405 ca-cd, AE103 c6-c9). When the unit's MQTT isn't fresh,
// watts read null (honest gap) — never the frozen REST number.
function livePvUnits(b) {
  return (b.members ?? [])
    .filter((m) => m.pvChannels?.length)
    .map((m) => {
      const liveM = latestBatteries.get(m.sn);
      const fresh = batteryMqtts.get(m.sn)?.isFresh?.() ?? false;
      return {
        sn: m.sn,
        name: m.name,
        channels: m.pvChannels.map((c) => {
          const w = fresh ? (liveM?.[`pv${c.n}W`] ?? null) : null;
          return { ...c, watts: w, connected: pvSeenConnected(m.sn, c.n, w ?? c.watts) };
        }),
      };
    });
}

function upsertMember(m) {
  const prev = latestBatteries.get(m.sn);
  latestBatteries.set(m.sn, {
    ...(prev ?? {}),
    ...m,
    temperatureC: m.temperatureC ?? prev?.temperatureC ?? null,
    mainSoc: m.mainSoc ?? prev?.mainSoc ?? null,
    expansions: m.expansions ?? prev?.expansions ?? null,
  });
}

// Rebuild the aggregate's fast fields after an MQTT merge — sums satisfy
// the same flow invariants per unit (pvW = chargeW + pvThrough holds for
// sums of units where it holds per unit). SOC is NOT recomputed here
// (2026-09-29, user report: the system SOC flip-flopped 17↔18% every few
// seconds): weightedSoc() and REST's total_battery_power straddle a
// rounding boundary at different moments and alternated on every MQTT/REST
// update. The aggregate SOC comes from ONE source — Anker's own
// site-level total_battery_power (what the app displays), refreshed by the
// REST sync; it moves far too slowly to need MQTT cadence.
function recomputeAggregate() {
  if (!latestBattery || !latestBatteries.size) return;
  const members = [...latestBatteries.values()];
  const sum = (k) => members.reduce((a, m) => a + (m[k] ?? 0), 0);
  const primary = members.find((m) => m.sn === latestBattery.sn) ?? members[0];
  latestBattery = {
    ...latestBattery,
    ts: Date.now(),
    members,
    outputW: sum("outputW"),
    chargeW: sum("chargeW"),
    pvW: sum("pvW"),
    temperatureC: primary.temperatureC ?? null,
    mainSoc: primary.mainSoc ?? null,
    expansions: primary.expansions ?? null,
    // Single-unit site: the unit's MQTT c4 (home_demand ≈ home_load_power,
    // verified on the standalone Pro) refreshes the aggregate's homeLoadW at
    // MQTT cadence, pre-dock behavior. NEVER do this with ≥2 units: behind a
    // dock c4 tracks the unit's OWN output instead (verified live
    // 2026-09-27: c4=183 while the house drew 443), so the whole-house
    // figure stays REST-only (scen_info home_load_power, 3 s fast path).
    ...(members.length === 1 && members[0].homeLoadW != null
      ? { homeLoadW: members[0].homeLoadW }
      : {}),
  };
  trackGridCharge();
}

// Grid-charge activity tracker (2026-10-03, user request — with the
// explicit "don't make it too granular" constraint): gridChargeW flickers
// around 0 from sensor noise and PV wobble, so naive start/stop detection
// would spam the log several times a minute. Guards: a 20 W noise floor,
// a 60 s continuous-above hold to ENTER and a 120 s continuous-below hold
// to EXIT — one pair per genuine episode, none for flicker.
const GRID_CHARGE_LOG_MIN_W = 20;
const GRID_CHARGE_ENTER_MS = 60 * 1000;
const GRID_CHARGE_EXIT_MS = 120 * 1000;
const gridChargeLog = { active: false, aboveSince: null, belowSince: null };
function trackGridCharge() {
  if (!latestBattery) return;
  const { gridChargeW } = deriveBatteryFlow(latestBattery);
  const now = Date.now();
  if (gridChargeW >= GRID_CHARGE_LOG_MIN_W) {
    gridChargeLog.belowSince = null;
    if (!gridChargeLog.active) {
      gridChargeLog.aboveSince ??= now;
      if (now - gridChargeLog.aboveSince >= GRID_CHARGE_ENTER_MS) {
        gridChargeLog.active = true;
        activity("gridCharge", { state: "start", w: Math.round(gridChargeW) });
      }
    }
  } else {
    gridChargeLog.aboveSince = null;
    if (gridChargeLog.active) {
      gridChargeLog.belowSince ??= now;
      if (now - gridChargeLog.belowSince >= GRID_CHARGE_EXIT_MS) {
        gridChargeLog.active = false;
        activity("gridCharge", { state: "stop" });
      }
    }
  }
}

// MQTT telemetry maps are verified per model. The Solarbank 2 family
// (A17C0-C3) shares one map; the AE103 (Solarbank 4) uses its own
// (FIELDS_0405_AE103 + decodeExpansionDataAE103, from the community
// _AE103_0405/_AE103_040a) — decoding AE103 with the SB2 map produced
// garbage (soc=0 while REST read 17%, seen 2026-09-27).
const MQTT_KNOWN_PN = new Set(["A17C0", "A17C1", "A17C2", "A17C3", "AE103"]);

function startBatteryMqtts() {
  if (!latestBatteries.size) return;
  for (const m of latestBatteries.values()) {
    if (!MQTT_KNOWN_PN.has(m.pn)) {
      if (!startBatteryMqtts.skipped?.has(m.sn)) {
        (startBatteryMqtts.skipped ??= new Set()).add(m.sn);
        console.log(`[mqtt] ${m.name} (${m.pn}) — no verified telemetry map; REST-only`);
      }
      continue;
    }
    let client = batteryMqtts.get(m.sn);
    // A unit's pn changing under a running process (hardware swap) → rebind.
    if (client && client.pn !== (m.pn ?? "A17C3")) {
      client.stop();
      batteryMqtts.delete(m.sn);
      client = null;
    }
    if (client) continue;
    if (batteryMqtts.size > 0) activity("battery_swapped", { from: [...batteryMqtts.keys()].join(","), to: m.sn, name: m.name });
    client = new AnkerMqtt(anker, m.sn, m.pn ?? "A17C3");
    client.onData = (d) => {
      upsertMember({ sn: m.sn, pn: m.pn, name: m.name, ...d });
      recomputeAggregate();
      lastCloudOkAt = Date.now();
      try {
        saveBatterySnapshot(latestBattery);
        // Per-module history (Graph tab): keyed by the PHYSICAL module's SN
        // (unit SN for each solarbank, pack SN for expansions — 2026-09-27).
        // The module value must be the MAIN PACK's SOC: for the SB2 family
        // that's 0405 a3 (mainSoc); for the AE103, 0405 a3 is the UNIT TOTAL
        // and the main pack's SOC only exists in 040a — the `?? d.soc`
        // fallback would write the unit total under the module key, mixing
        // semantics with the 040a writes (2026-09-28: SB4 read a bogus 18%
        // = mix of main-pack 8% and unit-total 27%).
        const moduleSoc = d.mainSoc ?? (m.pn === "AE103" ? null : d.soc ?? null);
        if (moduleSoc != null || d.temperatureC != null) {
          saveModuleSnapshot(d.ts, m.sn, moduleSoc, d.temperatureC ?? null);
        }
      } catch (err) {
        console.warn("[db] failed to persist battery snapshot:", err.message);
      }
      broadcastLive({ batteryTriggered: true }); // MQTT cadence ~3-5 s, throttled inside
    };
    // 040a expansion messages: per-pack SOC/SOH/temperature for the attached
    // expansion batteries (BP5000 etc.) — merged into the unit and the
    // aggregate, carried forward across REST syncs (see upsertMember).
    client.onExpansion = (d) => {
      // Normalize pack identity: the AE103 (Solarbank 4) 040a composite has
      // no separate pack SN (only the 16-char controllerSn) — give sn-less
      // packs a stable synthetic key so module_snapshots, the /api/timeseries
      // modules meta (which filters on sn) and the UI all key them the same.
      const packs = d.packs.map((p, i) => (p.sn ? p : { ...p, sn: `${m.sn}-exp${i + 1}` }));
      upsertMember({ sn: m.sn, mainSoc: d.mainSoc ?? undefined, expansions: packs });
      recomputeAggregate();
      lastCloudOkAt = Date.now();
      try {
        if (d.mainSoc != null) saveModuleSnapshot(d.ts, m.sn, d.mainSoc, latestBattery.temperatureC ?? null);
        packs.forEach((p) => saveModuleSnapshot(d.ts, p.sn, p.soc ?? null, p.temperatureC ?? null));
      } catch (err) {
        console.warn("[db] failed to persist module snapshot:", err.message);
      }
      if (packs.length > 0 && !client.expansionLogged) {
        client.expansionLogged = true;
        activity("expansion_detected", { n: packs.length, sn: packs[0]?.sn ?? null });
      }
      broadcastLive({ batteryTriggered: true });
    };
    client.start(); // never rejects — retries internally with backoff
    batteryMqtts.set(m.sn, client);
  }
  // Units that disappeared from the site (swap/removal): stop their clients.
  for (const [sn, client] of batteryMqtts) {
    if (!latestBatteries.has(sn)) {
      client.stop();
      batteryMqtts.delete(sn);
    }
  }
}

// Health reporting + the fresh/stalled watcher use the PRIMARY unit's client.
function primaryMqtt() {
  return batteryMqtts.get(latestBattery?.sn) ?? batteryMqtts.values().next().value ?? null;
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
      // Per-unit state first (dock era: multiple solarbanks per site) —
      // upsertMember preserves each unit's MQTT-only fields across REST.
      for (const m of info.members ?? []) {
        // Cross-source consistency (2026-09-29, user report: the Battery
        // tile oscillated −xxx↔+xxx / 0↔xxx with no physical change): REST
        // overwrote each unit's power/SOC fields every sync while MQTT was
        // fresh — and the two sources' values are seconds apart. Fields
        // that are internally consistent per source (pvW/chargeW/outputW/
        // dischargeW) then mixed across sources, producing bogus
        // simultaneous charge+discharge per unit (deriveBatteryFlow on the
        // mix) and mode flips in the aggregate. While a unit's MQTT is
        // fresh, REST must not overwrite that unit's power/SOC fields.
        const mEff = { ...m };
        if (batteryMqtts.get(m.sn)?.isFresh?.()) {
          for (const k of ["soc", "pvW", "chargeW", "outputW", "dischargeW"]) delete mEff[k];
        }
        upsertMember(decoratePvChannels(mEff));
        // Per-module SOC history for units WITHOUT an MQTT map only
        // (2026-09-28 fix): the module key is the unit's SN, and MQTT 040a
        // writes the MAIN PACK's SOC under it — writing REST's unit-TOTAL
        // soc under the same key mixes two semantics (SB4: main pack 8%
        // vs unit total 27% averaged into a meaningless 18.6%). A gap
        // during an MQTT stall is more honest than a mixed value.
        if (!MQTT_KNOWN_PN.has(m.pn)) {
          try {
            saveModuleSnapshot(info.ts, m.sn, m.soc ?? null, m.temperatureC ?? null);
          } catch {
            /* non-fatal */
          }
        }
      }
      // REST has no temperature field — carry the last MQTT-sourced value
      // forward instead of blanking it on every 10 s REST sync. Same for
      // mainSoc/expansions (MQTT 0405/040a only, no REST equivalent).
      latestBattery = {
        ...info,
        // The decorated (pv-connected flags) + MQTT-preserved per-unit
        // objects, not the raw REST members.
        members: [...latestBatteries.values()],
        temperatureC: latestBattery?.temperatureC ?? null,
        mainSoc: latestBattery?.mainSoc ?? null,
        expansions: latestBattery?.expansions ?? null,
      };
      // Rebuild the aggregate's power sums from the (MQTT-preserved)
      // members instead of trusting info's REST sums — with per-unit field
      // preservation above, the members hold one consistent source per
      // unit, so the aggregate stops jittering between REST-sum and
      // MQTT-sum of the same physical quantity. soc is untouched by
      // recomputeAggregate (single writer: total_battery_power, 2026-09-29).
      recomputeAggregate();
      lastCloudOkAt = Date.now();
      lastRestSyncAt = Date.now();
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
      startBatteryMqtts();
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



// Activity: infrastructure transitions worth seeing (meter direct up/down,
// MQTT fresh/stalled). Transient dev mode flaps by design — meter events
// are skipped there.
let lastMeterConnected = null;
let lastMqttFresh = null;
setInterval(() => {
  const mc = poller.getState().connected;
  if (lastMeterConnected != null && mc !== lastMeterConnected && process.env.MODBUS_TRANSIENT !== "true") {
    activity("meter", { state: mc ? "up" : "down" });
  }
  lastMeterConnected = mc;
  const mf = primaryMqtt()?.isFresh() ?? false;
  if (lastMqttFresh != null && mf !== lastMqttFresh) {
    activity("mqtt", { state: mf ? "fresh" : "stalled" });
  }
  lastMqttFresh = mf;
}, 15 * 1000).unref();

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
  // DOCK ERA exception (2026-09-27, user report: Live-tab Home stale/wrong
  // vs the Anker app): a healthy MQTT stream only covers the UNIT it's
  // attached to. The aggregate's homeLoadW (scen_info home_load_power —
  // the whole-house figure) has NO MQTT equivalent anymore: the Pro's c4
  // (home_demand ≈ home_load_power on a standalone unit) now tracks the
  // unit's OWN output behind the dock (verified live: c4=183 while the
  // house drew 443). With ≥2 units on the site, REST is the only source of
  // home_load_power, so the Anker-app-parity 3 s cadence must run whenever
  // a UI watches, regardless of MQTT freshness.
  if (primaryMqtt()?.isFresh?.() && latestBatteries.size <= 1) return;
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
const powerPlan = new PowerPlanController(anker, () => latestBattery ?? getLatestBattery(), activity);

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
// PIN brute-force lockout (2026-10-01, user request): after 3 wrong PIN
// attempts, the client IP is BLACKLISTED (persisted in kv, survives
// restarts) until the owner unblocks it via POST /api/security/unblock
// (which itself requires the correct PIN). The client IP prefers the
// Cloudflare header — through the tunnel, remoteAddress would otherwise be
// the tunnel's, and every visitor would count as one shared client.
const PIN_MAX_ATTEMPTS = 3;
const pinAttempts = new Map(); // ip -> failed count (session-scoped)
function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ??
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown"
  );
}
function pinBlacklist() {
  return kvGet("pin_blacklist")?.value ?? [];
}
function pinBlock(ip) {
  kvSet("pin_blacklist", [...new Set([...pinBlacklist(), ip])]);
  activity("pin_ip_locked", { ip });
}
function pinUnblock(ip) {
  kvSet("pin_blacklist", [...pinBlacklist()].filter((x) => x !== ip));
  pinAttempts.delete(ip);
}

app.post("/api/power-plan/strategy", (req, res) => {
  // Strategy changes are PIN-protected (2026-09-27, user request): the PIN
  // lives in .env (STRATEGY_PIN), default 0000 when unset. Read at REQUEST
  // time, not module top level — remember the dotenv-import-hoisting
  // incident (env.js must evaluate first; reading late is immune by design).
  const ip = clientIp(req);
  if (pinBlacklist().includes(ip)) {
    return res.status(403).json({ ok: false, error: "locked", locked: true });
  }
  const { pin, strategy, trigger, manualDischarge } = req.body ?? {};
  if (pin !== (process.env.STRATEGY_PIN ?? "0000")) {
    const fails = (pinAttempts.get(ip) ?? 0) + 1;
    pinAttempts.set(ip, fails);
    if (fails >= PIN_MAX_ATTEMPTS) {
      pinBlock(ip);
      return res.status(403).json({ ok: false, error: "locked", locked: true });
    }
    return res
      .status(403)
      .json({ ok: false, error: "invalid PIN", attemptsLeft: PIN_MAX_ATTEMPTS - fails });
  }
  pinAttempts.delete(ip); // correct PIN resets the failure counter
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

// Unblock a PIN-locked IP (2026-10-01, user request: "until I remove it
// from the blacklist") — requires the correct PIN, so only the owner can
// unblock. Body: {ip, pin}. Returns the current blacklist for visibility.
app.post("/api/security/unblock", (req, res) => {
  const ip = clientIp(req);
  const { ip: targetIp, pin } = req.body ?? {};
  if (pin !== (process.env.STRATEGY_PIN ?? "0000")) {
    const fails = (pinAttempts.get(ip) ?? 0) + 1;
    pinAttempts.set(ip, fails);
    if (fails >= PIN_MAX_ATTEMPTS) pinBlock(ip);
    return res.status(403).json({ ok: false, error: "invalid PIN" });
  }
  pinAttempts.delete(ip);
  if (!targetIp) return res.status(400).json({ ok: false, error: "missing ip" });
  pinUnblock(String(targetIp));
  activity("pin_ip_unlocked", { ip: String(targetIp) });
  res.json({ ok: true, data: { blacklist: pinBlacklist() } });
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
  for (const client of batteryMqtts.values()) client.stop();
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
