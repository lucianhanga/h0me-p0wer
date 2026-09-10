import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DB_PATH =
  process.env.DB_PATH ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "data.db");
const RETENTION_MS = 48 * 3600 * 1000; // keep 48 h of live-resolution samples

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    ts INTEGER PRIMARY KEY,
    grid_total REAL, grid_l1 REAL, grid_l2 REAL, grid_l3 REAL,
    solar_total REAL, solar_l1 REAL, solar_l2 REAL, solar_l3 REAL
  )
`);

const insert = db.prepare(`
  INSERT OR REPLACE INTO snapshots
  (ts, grid_total, grid_l1, grid_l2, grid_l3, solar_total, solar_l1, solar_l2, solar_l3)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectSince = db.prepare(`
  SELECT * FROM snapshots WHERE ts >= ? ORDER BY ts ASC
`);

const prune = db.prepare(`DELETE FROM snapshots WHERE ts < ?`);

// Guard against register garbage (sentinel/overflow reads): anything beyond
// ±1 MW is not a plausible household power value.
const sane = (v) => (typeof v === "number" && Math.abs(v) > 1e6 ? null : v);

export function saveSnapshot(s) {
  insert.run(
    new Date(s.timestamp).getTime(),
    sane(s.primary.totalPower),
    sane(s.primary.phases[0].power),
    sane(s.primary.phases[1].power),
    sane(s.primary.phases[2].power),
    sane(s.secondary.totalPower),
    sane(s.secondary.phases[0].power),
    sane(s.secondary.phases[1].power),
    sane(s.secondary.phases[2].power),
  );
}

export function pruneOld() {
  prune.run(Date.now() - RETENTION_MS);
}

// Rows back in the same shape the frontend chart consumes.
export function getHistory(sinceMs) {
  return selectSince.all(sinceMs).map((r) => ({
    timestamp: new Date(r.ts).toISOString(),
    primary: {
      totalPower: r.grid_total,
      phases: [{ power: r.grid_l1 }, { power: r.grid_l2 }, { power: r.grid_l3 }],
    },
    secondary: {
      totalPower: r.solar_total,
      phases: [{ power: r.solar_l1 }, { power: r.solar_l2 }, { power: r.solar_l3 }],
    },
  }));
}

// --- Cloud history cache (device energy_analysis, keyed by period) ---------
// Rows from data_trend are stored per (device_sn, period_type, period_start),
// so the UI reads history from the local DB and the cloud is only queried to
// refresh stale/missing periods.

db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_history (
    device_sn TEXT NOT NULL,
    period_type TEXT NOT NULL,
    period_start TEXT NOT NULL,
    label TEXT NOT NULL,
    power REAL,
    import_energy REAL,
    export_energy REAL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (device_sn, period_type, period_start, label)
  )
`);

const upsertCloudRow = db.prepare(`
  INSERT OR REPLACE INTO cloud_history
  (device_sn, period_type, period_start, label, power, import_energy, export_energy, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectCloudRows = db.prepare(`
  SELECT label, power, import_energy, export_energy, fetched_at
  FROM cloud_history
  WHERE device_sn = ? AND period_type = ? AND period_start = ?
  ORDER BY label ASC
`);

const num = (v) => (v === "" || v == null ? null : Number(v));

export function saveCloudTrend(sn, type, start, dataTrend) {
  const now = Date.now();
  for (const t of dataTrend) {
    upsertCloudRow.run(
      sn,
      type,
      start,
      t.time,
      num(t.power),
      num(t.import_energy),
      num(t.export_energy),
      now,
    );
  }
}

export function getCloudTrend(sn, type, start) {
  const rows = selectCloudRows.all(sn, type, start);
  return {
    rows: rows.map((r) => ({
      time: r.label,
      power: r.power,
      import_energy: r.import_energy,
      export_energy: r.export_energy,
    })),
    fetchedAt: rows.length ? Math.max(...rows.map((r) => r.fetched_at)) : 0,
  };
}

// Which period_start values are already stored for a device+type (used by the
// startup catch-up to find gaps).
const selectPeriodStarts = db.prepare(`
  SELECT DISTINCT period_start FROM cloud_history
  WHERE device_sn = ? AND period_type = ?
`);

export function getStoredPeriodStarts(sn, type) {
  return new Set(selectPeriodStarts.all(sn, type).map((r) => r.period_start));
}

// Raw 5 s samples in a range (for energy integration in stats endpoints).
export function getSnapshotRows(fromMs, toMs) {
  return selectSnapshotRows.all(fromMs, toMs);
}

// Any METER SN seen in cloud history (fallback when the meter is offline).
// The meter is the device that has month/year period rows; the battery only
// has day rows.
const selectAnySn = db.prepare(`
  SELECT DISTINCT device_sn AS sn FROM cloud_history WHERE period_type = 'month' LIMIT 1
`);

export function getAnyDeviceSn() {
  return selectAnySn.get()?.sn ?? null;
}

// Battery SN = the cloud_history device SN that is not the meter.
const selectBatterySn = db.prepare(`
  SELECT DISTINCT device_sn AS sn FROM cloud_history WHERE device_sn != ? LIMIT 1
`);

export function getBatterySn(meterSn) {
  return selectBatterySn.get(meterSn ?? "")?.sn ?? null;
}

// --- Battery (Solarbank) live snapshots ------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS battery_snapshots (
    ts INTEGER PRIMARY KEY,
    soc REAL,
    output_w REAL,
    charge_w REAL,
    pv_w REAL,
    to_home_w REAL
  )
`);

const insertBattery = db.prepare(`
  INSERT OR REPLACE INTO battery_snapshots (ts, soc, output_w, charge_w, pv_w, to_home_w)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const selectLatestBattery = db.prepare(`
  SELECT * FROM battery_snapshots ORDER BY ts DESC LIMIT 1
`);

const selectBatterySince = db.prepare(`
  SELECT * FROM battery_snapshots WHERE ts >= ? ORDER BY ts ASC
`);

export function saveBatterySnapshot(b) {
  insertBattery.run(b.ts, b.soc, b.outputW, b.chargeW, b.pvW, b.toHomeW);
}

export function getLatestBattery() {
  const r = selectLatestBattery.get();
  // Anything older than 5 min is not "live" — don't present it as such.
  if (!r || Date.now() - r.ts > 5 * 60 * 1000) return null;
  // Same camelCase shape as the live sync payload.
  return {
    ts: r.ts,
    soc: r.soc,
    outputW: r.output_w,
    chargeW: r.charge_w,
    pvW: r.pv_w,
    toHomeW: r.to_home_w,
  };
}

export function getBatteryHistory(sinceMs) {
  return selectBatterySince.all(sinceMs);
}

export function pruneBattery() {
  db.prepare(`DELETE FROM battery_snapshots WHERE ts < ?`).run(Date.now() - RETENTION_MS);
}

// --- Unified time series (for the stock-chart style visualization) ---------

// 5-second Modbus samples averaged into buckets of bucketMs.
// Bucketing is done in JS, not SQL: node:sqlite binds numbers as REAL, so
// SQL `/` is float division and (ts/b)*b does not align to bucket edges.
const selectSnapshotRows = db.prepare(`
  SELECT ts, grid_total, grid_l1, grid_l2, grid_l3, solar_total
  FROM snapshots
  WHERE ts >= ? AND ts <= ?
  ORDER BY ts ASC
`);

export function getSnapshotBuckets(fromMs, toMs, bucketMs) {
  const buckets = new Map(); // bt -> {grid:{s,c,min,max}, ...}
  for (const r of selectSnapshotRows.all(fromMs, toMs)) {
    const bt = Math.floor(r.ts / bucketMs) * bucketMs;
    let b = buckets.get(bt);
    if (!b) {
      b = {};
      buckets.set(bt, b);
    }
    for (const [key, value] of [
      ["grid", r.grid_total],
      ["l1", r.grid_l1],
      ["l2", r.grid_l2],
      ["l3", r.grid_l3],
      ["solar", r.solar_total],
    ]) {
      if (value == null) continue;
      const cell = (b[key] ??= { s: 0, c: 0, min: Infinity, max: -Infinity });
      cell.s += value;
      cell.c++;
      if (value < cell.min) cell.min = value;
      if (value > cell.max) cell.max = value;
    }
  }
  return [...buckets.entries()].map(([bt, b]) => ({
    bt,
    grid: b.grid ? b.grid.s / b.grid.c : null,
    gridMin: b.grid ? b.grid.min : null,
    gridMax: b.grid ? b.grid.max : null,
    l1: b.l1 ? b.l1.s / b.l1.c : null,
    l2: b.l2 ? b.l2.s / b.l2.c : null,
    l3: b.l3 ? b.l3.s / b.l3.c : null,
    solar: b.solar ? b.solar.s / b.solar.c : null,
  }));
}

// Cloud 20-min power trend (grid total only), as absolute timestamps.
// Day-trend labels are meter-local "HH:MM:SS" on a "yyyy-MM-dd" period start.
const selectCloudDayRows = db.prepare(`
  SELECT period_start, label, power FROM cloud_history
  WHERE device_sn = ? AND period_type = 'day'
    AND period_start >= ? AND period_start <= ?
`);

export function getCloudDayPower(sn, fromDate, toDate) {
  return selectCloudDayRows.all(sn, fromDate, toDate).map((r) => ({
    ts: new Date(`${r.period_start}T${r.label}`).getTime(),
    power: r.power,
  }));
}
