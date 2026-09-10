import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

// .env lives at the project root, one level up from this file — resolve it
// explicitly so the server works no matter where it is started from.
dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
});
import { WebSocketServer } from "ws";
import { MeterPoller } from "./modbus.js";
import { AnkerClient, AnkerApiError } from "./anker-cloud.js";
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
  saveBatterySnapshot,
  getLatestBattery,
  getBatteryHistory,
  pruneBattery,
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

const poller = new MeterPoller(METER_IP, METER_PORT);
const anker = new AnkerClient(
  process.env.ANKER_EMAIL,
  process.env.ANKER_PASSWORD,
  process.env.ANKER_COUNTRY ?? "DE",
);

const app = express();
app.use(express.json());

app.get("/api/live", (req, res) => {
  res.json(poller.getState());
});

// Latest battery (Solarbank) status: memory first, DB fallback.
app.get("/api/battery/live", (req, res) => {
  res.json({ ok: true, data: latestBattery ?? getLatestBattery() });
});

// Computed power flows between grid / battery / PV / home.
// Approximation rules (documented in AGENTS.md):
// - grid import/export comes straight from the meter (signed total).
// - PV split: bat_charge_power counts all charging regardless of source, so
//   pvToBattery = min(pvW, chargeW) and pvToHome = pvW - pvToBattery.
// - home consumption = grid import + battery discharge + PV direct.
app.get("/api/flow", (req, res) => {
  const grid = poller.snapshot?.primary?.totalPower ?? null;
  const b = latestBattery ?? getLatestBattery();
  const pvW = b?.pvW ?? 0;
  const chargeW = b?.chargeW ?? 0;
  const pvToBattery = Math.min(pvW, chargeW);
  const pvToHome = Math.max(0, pvW - pvToBattery);
  res.json({
    ok: true,
    data: {
      ts: Date.now(),
      grid: {
        import: grid != null ? Math.max(grid, 0) : null,
        export: grid != null ? Math.max(-grid, 0) : null,
      },
      battery: b
        ? { soc: b.soc, discharge: b.outputW, charge: chargeW, name: b.name ?? "Solarbank" }
        : null,
      pv: { production: pvW, toBattery: pvToBattery, toHome: pvToHome },
      home: {
        consumption:
          grid != null ? Math.max(grid, 0) + (b?.outputW ?? 0) + pvToHome : null,
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
  // Round the bucket up to a whole 5 s step; never finer than the raw 5 s.
  // `view` (ms) is the VISIBLE window: buckets are sized for it even when the
  // fetched range is padded wider, so a 1 h view gets raw 5 s resolution.
  const viewMs = Math.max(Number(req.query.view ?? 0) || to - from, 1000);
  const autoBucketMs = Math.max(5000, Math.ceil(viewMs / points / 5000) * 5000);
  const requestedBucketMs = Number(req.query.bucket ?? 0);
  const bucketMs =
    requestedBucketMs > 0
      ? Math.max(5000, requestedBucketMs, Math.ceil((to - from) / 4000 / 5000) * 5000)
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

  // Source 1b: battery (Solarbank) snapshots every 30 s — signed power:
  // discharge positive, charge negative; plus PV input watts.
  for (const r of getBatteryHistory(from, to)) {
    const bt = Math.floor(r.ts / bucketMs) * bucketMs;
    add(bt, "batt", (r.output_w ?? 0) - (r.charge_w ?? 0));
    add(bt, "pv", r.pv_w ?? 0);
  }

  // Source 2: cloud 20-min trend as ANCHOR points in buckets without local
  // data (local wins). Still-open 20-min intervals are skipped — their
  // partial averages produce phantom dips.
  const sn = poller.snapshot?.meter?.sn;
  const CLOUD_INTERVAL_MS = 20 * 60 * 1000;
  if (sn) {
    const fromDate = localDate(new Date(from - 86400000));
    const toDate = localDate(new Date(to));
    const cloudBuckets = new Map(); // bt -> {s, c}
    for (const r of getCloudDayPower(sn, fromDate, toDate)) {
      if (r.power == null || r.ts < from || r.ts > to) continue;
      if (r.ts + CLOUD_INTERVAL_MS > Date.now()) continue; // interval not closed
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
        if (r.power == null || r.ts < from || r.ts > to) continue;
        if (r.ts + CLOUD_INTERVAL_MS > Date.now()) continue; // open interval
        const bt = Math.floor(r.ts / bucketMs) * bucketMs;
        if (!acc.get(bt)?.batt) add(bt, "batt", r.power);
      }
    }
  }

  // Final pass: bridge consecutive data-bearing buckets (local or cloud
  // anchors) with linear interpolation, so the line is always continuous.
  // This never fabricates long spans: wherever cloud history exists, real
  // anchor values are at most 20 min apart — interpolation only ever crosses
  // the distance between two real measurements.
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
  const anchorShares = anchors.map(sharesAt);
  const nearestShares = (i) => {
    for (let d = 0; d < anchors.length; d++) {
      if (anchorShares[i - d]) return anchorShares[i - d];
      if (anchorShares[i + d]) return anchorShares[i + d];
    }
    return null;
  };

  for (let i = 1; i < anchors.length; i++) {
    const bt0 = anchors[i - 1];
    const bt1 = anchors[i];
    const c0 = acc.get(bt0).grid;
    const c1 = acc.get(bt1).grid;
    if (!c0 || !c1) continue;
    const v0 = c0.s / c0.c;
    const v1 = c1.s / c1.c;
    const b0 = acc.get(bt0).batt;
    const b1 = acc.get(bt1).batt;
    const p0 = acc.get(bt0).pv;
    const p1 = acc.get(bt1).pv;
    const sh0 = anchorShares[i - 1] ?? nearestShares(i - 1);
    const sh1 = anchorShares[i] ?? nearestShares(i);
    for (let t = bt0 + bucketMs; t < bt1; t += bucketMs) {
      // Skip buckets that already have grid data — but a bucket holding ONLY
      // battery/PV data must still get its grid value filled.
      if (t < from || t > to || acc.get(t)?.grid) continue;
      const frac = (t - bt0) / (bt1 - bt0);
      const grid = v0 + (v1 - v0) * frac;
      add(t, "grid", grid);
      const existing = acc.get(t) ?? {};
      if (!existing.batt && b0 && b1)
        add(t, "batt", b0.s / b0.c + (b1.s / b1.c - b0.s / b0.c) * frac);
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
      if (!b.batt && b0 && b1)
        add(t, "batt", b0.s / b0.c + (b1.s / b1.c - b0.s / b0.c) * frac);
      if (!b.pv && p0 && p1) add(t, "pv", p0.s / p0.c + (p1.s / p1.c - p0.s / p0.c) * frac);
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
  for (let i = 0; i < sorted.length; i++) {
    const [bt, cell] = sorted[i];
    profile.push({ t: bt, power: Math.round(cell.s / cell.c) });
    const next = sorted[i + 1];
    if (next) {
      const [nbt] = next;
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
  const battAnchors = new Map(); // bt -> {s, c}
  const putBatt = (bt, v) => {
    const cell = (battAnchors.get(bt) ?? battAnchors.set(bt, { s: 0, c: 0 }).get(bt));
    cell.s += v;
    cell.c++;
  };
  for (const r of getBatteryHistory(dayStartMs, now)) {
    if (r.output_w == null) continue;
    putBatt(Math.floor(r.ts / BUCKET) * BUCKET, (r.output_w ?? 0) - (r.charge_w ?? 0));
  }
  if (battSn) {
    const todayStr = localDate(new Date(dayStartMs));
    for (const r of getCloudDayPower(battSn, todayStr, todayStr)) {
      if (r.power == null || r.ts < dayStartMs || r.ts > now) continue;
      if (r.ts + 20 * 60 * 1000 > now) continue;
      const bt = Math.floor(r.ts / BUCKET) * BUCKET;
      if (!battAnchors.has(bt)) putBatt(bt, r.power);
    }
  }
  const battSorted = [...battAnchors.entries()].sort(([a], [b]) => a - b);
  const battByT = new Map();
  for (let i = 0; i < battSorted.length; i++) {
    const [bt, cell] = battSorted[i];
    battByT.set(bt, Math.round(cell.s / cell.c));
    const next = battSorted[i + 1];
    if (next) {
      const [nbt] = next;
      const nv = next[1].s / next[1].c;
      for (let t = bt + BUCKET; t < nbt; t += BUCKET) {
        const frac = (t - bt) / (nbt - bt);
        battByT.set(t, Math.round(cell.s / cell.c + (nv - cell.s / cell.c) * frac));
      }
    }
  }
  for (const p of profile) p.batt = battByT.get(p.t) ?? null;

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
  const weekRows = monthRows.filter((r) => {
    const t = new Date(`${r.label}T12:00:00`).getTime();
    return t > now - 7 * 86400000 && t <= now;
  });

  // --- Year: monthly kWh from cloud_history year rows.
  const yearRows = sn
    ? getCloudTrend(sn, "year", String(new Date().getFullYear())).rows.map((r) => ({
        label: r.time,
        importKwh: r.import_energy ?? 0,
        exportKwh: r.export_energy ?? 0,
      }))
    : [];

  // --- Battery (Solarbank) today: SOC + integrated discharge/charge kWh
  // from the 30-s live snapshots (trapezoid, gaps > 30 min skipped).
  const battRows = getBatteryHistory(dayStartMs, now);
  let dischargedKwh = 0;
  let chargedKwh = 0;
  let pvKwh = 0;
  let pvToHomeKwh = 0;
  for (let i = 1; i < battRows.length; i++) {
    const dt = (battRows[i].ts - battRows[i - 1].ts) / 3600000;
    if (dt > 0.5) continue;
    dischargedKwh += (((battRows[i - 1].output_w + battRows[i].output_w) / 2) * dt) / 1000;
    chargedKwh += (((battRows[i - 1].charge_w + battRows[i].charge_w) / 2) * dt) / 1000;
    pvKwh += (((battRows[i - 1].pv_w + battRows[i].pv_w) / 2) * dt) / 1000;
    const pvHome0 = Math.max(0, battRows[i - 1].pv_w - battRows[i - 1].charge_w);
    const pvHome1 = Math.max(0, battRows[i].pv_w - battRows[i].charge_w);
    pvToHomeKwh += (((pvHome0 + pvHome1) / 2) * dt) / 1000;
  }
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
    homeKwh: Math.round((importKwh + dischargedKwh + pvToHomeKwh) * 100) / 100,
  };

  // Costs from kWh × tariff. Battery discharge = avoided grid import, so its
  // "savings" are discharged kWh × price (only counts once PV exists; for
  // grid-charged batteries this overstates savings — noted in AGENTS.md).
  const tariff = Number(process.env.TARIFF_EUR_PER_KWH ?? 0);
  const eur = (kwh) => Math.round(kwh * tariff * 100) / 100;
  const weekImport = weekRows.reduce((a, r) => a + r.importKwh, 0);
  const monthImport = monthRows
    .filter((r) => r.label.startsWith(ym))
    .reduce((a, r) => a + r.importKwh, 0);
  const yearImport = yearRows.reduce((a, r) => a + r.importKwh, 0);
  const costs = {
    tariffEurPerKwh: tariff,
    today: eur(importKwh),
    week: eur(weekImport),
    month: eur(monthImport),
    year: eur(yearImport),
    batterySavingsToday: eur(dischargedKwh),
  };

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
      week: weekRows,
      month: monthRows.filter((r) => r.label.startsWith(ym)),
      year: yearRows,
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

// Prune samples older than the retention window once an hour.
pruneOld();
pruneBattery();
setInterval(() => {
  pruneOld();
  pruneBattery();
}, 3600 * 1000).unref();

// Battery (Solarbank) live sync: scen_info every 30 s (1 call after the
// first — well under the ~10 req/min rate limit, even with the Anker mobile
// app polling from the same IP).
let latestBattery = null;
async function syncBattery() {
  if (!anker.configured) return;
  try {
    const info = await anker.getBatteryInfo();
    if (info) {
      latestBattery = info;
      saveBatterySnapshot(info);
    }
  } catch (err) {
    console.warn(`[battery] sync failed: ${err.message}`);
  }
}
setTimeout(syncBattery, 60 * 1000);
setInterval(syncBattery, 30 * 1000).unref();

poller.start();

let shuttingDown = false;
function gracefulShutdown() {
  // Second signal forces an immediate exit.
  if (shuttingDown) process.exit(1);
  shuttingDown = true;

  poller.stop();
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
