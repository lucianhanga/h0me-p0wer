import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DB_PATH =
  process.env.DB_PATH ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "data.db");
const RETENTION_MS = 48 * 3600 * 1000; // keep 48 h of live-resolution samples

const db = new DatabaseSync(DB_PATH);
// WAL for the 1 s snapshot cadence (2026-09-22 code review): default
// journal mode pays a full fsync per insert; WAL amortizes the 1 s +
// 3-10 s write streams far better. Files live on a local volume (Docker
// named volume / local disk), so WAL's shared-memory caveat doesn't apply.
db.exec("PRAGMA journal_mode = WAL");
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
  // One transaction per trend instead of one per row (2026-09-22 review):
  // 72 upserts per call add up across the 15-min sync + backfills.
  db.exec("BEGIN");
  try {
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
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
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

// First day with cloud history (when the meter was linked) — dashboard time
// navigation stops there.
const selectEarliestDay = db.prepare(`
  SELECT MIN(period_start) AS d FROM cloud_history WHERE device_sn = ? AND period_type = 'day'
`);

export function getEarliestCloudDay(sn) {
  return selectEarliestDay.get(sn ?? "")?.d ?? null;
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
// Columns added later — guarded for existing databases. pv1_w/pv2_w:
// per-string PV. temperature_c: main device temp (2026-09-16, MQTT-only).
for (const col of ["pv1_w REAL", "pv2_w REAL", "temperature_c REAL"]) {
  try {
    db.exec(`ALTER TABLE battery_snapshots ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

const insertBattery = db.prepare(`
  INSERT OR REPLACE INTO battery_snapshots (ts, soc, output_w, charge_w, pv_w, to_home_w, pv1_w, pv2_w, temperature_c)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectLatestBattery = db.prepare(`
  SELECT * FROM battery_snapshots ORDER BY ts DESC LIMIT 1
`);

const selectBatterySince = db.prepare(`
  SELECT * FROM battery_snapshots WHERE ts >= ? ORDER BY ts ASC
`);

const selectBatteryBetween = db.prepare(`
  SELECT * FROM battery_snapshots WHERE ts >= ? AND ts < ? ORDER BY ts ASC
`);

export function saveBatterySnapshot(b) {
  insertBattery.run(
    b.ts,
    b.soc,
    b.outputW,
    b.chargeW,
    b.pvW,
    b.toHomeW,
    b.pv1W ?? 0,
    b.pv2W ?? 0,
    b.temperatureC ?? null,
  );
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
    pv1W: r.pv1_w,
    pv2W: r.pv2_w,
    toHomeW: r.to_home_w,
    temperatureC: r.temperature_c,
  };
}

// untilMs is optional but pass it whenever a day boundary matters — without
// it the query runs up to NOW, which once silently polluted the pv_daily
// rollup with the following days' production (2026-09-15).
export function getBatteryHistory(sinceMs, untilMs = null) {
  return untilMs == null
    ? selectBatterySince.all(sinceMs)
    : selectBatteryBetween.all(sinceMs, untilMs);
}

// Single shared trapezoid pass over battery_snapshots rows — every "today"
// energy number (discharge/charge/PV production/PV split/per-string) used to
// be computed by three separately-duplicated copies of this same loop
// (index.js, welcome-ai.js, and this file), each with its own "skip gaps >
// 30 min" guard — safe individually, but a real ~5h data outage (2026-09-16,
// see AGENTS.md) silently zeroed out that whole window from every one of
// them with no way to tell "today" apart from "today, but a chunk is
// missing." Now there's one calculation: gaps longer than maxGapMs are still
// excluded from the sums (never guessed at via interpolation), but
// `coveredMs` reports how much of the requested window actually had
// continuous data, so callers can surface "partial data" instead of quietly
// presenting an undercounted total as if it were the whole day.
// windowStartMs/windowEndMs are optional — pass them (the caller's day
// start and "now") to also detect a LEADING gap (server was already down
// when the window began, e.g. an overnight crash) or a TRAILING gap (still
// down right now). Without them, only gaps strictly BETWEEN two known
// readings are detected.
export function integrateBatteryEnergy(
  rows,
  { maxGapMs = 30 * 60 * 1000, windowStartMs, windowEndMs } = {},
) {
  let dischargedKwh = 0;
  let chargedKwh = 0;
  let producedKwh = 0;
  let toHomeKwh = 0;
  let toBattKwh = 0;
  let pv1Kwh = 0;
  let pv2Kwh = 0;
  let coveredMs = 0;
  const gaps = []; // [{startMs, endMs}] — excluded windows, for cloud backfill
  if (windowStartMs != null && windowEndMs != null && !rows.length) {
    gaps.push({ startMs: windowStartMs, endMs: windowEndMs });
  }
  if (windowStartMs != null && rows.length && rows[0].ts - windowStartMs > maxGapMs) {
    gaps.push({ startMs: windowStartMs, endMs: rows[0].ts });
  }
  for (let i = 1; i < rows.length; i++) {
    const dtMs = rows[i].ts - rows[i - 1].ts;
    if (dtMs > maxGapMs) {
      gaps.push({ startMs: rows[i - 1].ts, endMs: rows[i].ts });
      continue;
    }
    coveredMs += dtMs;
    const dt = dtMs / 3600000;
    const a = rows[i - 1];
    const b = rows[i];
    dischargedKwh += (((a.output_w ?? 0) + (b.output_w ?? 0)) / 2) * dt / 1000;
    chargedKwh += (((a.charge_w ?? 0) + (b.charge_w ?? 0)) / 2) * dt / 1000;
    producedKwh += (((a.pv_w ?? 0) + (b.pv_w ?? 0)) / 2) * dt / 1000;
    pv1Kwh += (((a.pv1_w ?? 0) + (b.pv1_w ?? 0)) / 2) * dt / 1000;
    pv2Kwh += (((a.pv2_w ?? 0) + (b.pv2_w ?? 0)) / 2) * dt / 1000;
    // PV reaching the house = pv_w − charge_w (the part not charging), only
    // while the inverter outputs (output_w already includes the PV
    // pass-through — see /api/flow for the validated model).
    const th0 = (a.output_w ?? 0) > 0 ? Math.max(0, (a.pv_w ?? 0) - (a.charge_w ?? 0)) : 0;
    const th1 = (b.output_w ?? 0) > 0 ? Math.max(0, (b.pv_w ?? 0) - (b.charge_w ?? 0)) : 0;
    toHomeKwh += ((th0 + th1) / 2) * dt / 1000;
    const tb0 = Math.min(a.pv_w ?? 0, a.charge_w ?? 0);
    const tb1 = Math.min(b.pv_w ?? 0, b.charge_w ?? 0);
    toBattKwh += ((tb0 + tb1) / 2) * dt / 1000;
  }
  if (windowEndMs != null && rows.length) {
    const lastTs = rows[rows.length - 1].ts;
    if (windowEndMs - lastTs > maxGapMs) gaps.push({ startMs: lastTs, endMs: windowEndMs });
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    dischargedKwh: r2(dischargedKwh),
    chargedKwh: r2(chargedKwh),
    producedKwh: r2(producedKwh),
    toHomeKwh: r2(toHomeKwh),
    toBattKwh: r2(toBattKwh),
    pv1Kwh: r2(pv1Kwh),
    pv2Kwh: r2(pv2Kwh),
    coveredMs,
    gaps,
  };
}

// Per-string PV energy for a local day (kWh) — see integrateBatteryEnergy.
export function getPvStringKwhForDay(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`).getTime();
  const rows = selectBatterySince.all(start).filter((r) => r.ts < start + 86400000);
  const { pv1Kwh, pv2Kwh } = integrateBatteryEnergy(rows);
  return { pv1Kwh, pv2Kwh };
}

export function pruneBattery() {
  db.prepare(`DELETE FROM battery_snapshots WHERE ts < ?`).run(Date.now() - RETENTION_MS);
}

// --- Cloud-live grid samples (scen_info grid_info every 10 s) --------------
// Persisted by the battery sync so the graph keeps grid data at ~10 s
// resolution even when the meter's Modbus is down (user request 2026-09-15:
// populate the DB from the most appropriate available source).

db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_grid_snapshots (
    ts INTEGER PRIMARY KEY,
    grid_w REAL NOT NULL,
    pv_to_grid_w REAL NOT NULL DEFAULT 0,
    home_load_w REAL NOT NULL DEFAULT 0
  )
`);

const insertCloudGrid = db.prepare(
  `INSERT OR REPLACE INTO cloud_grid_snapshots (ts, grid_w, pv_to_grid_w, home_load_w) VALUES (?, ?, ?, ?)`,
);
const selectCloudGridRows = db.prepare(
  `SELECT ts, grid_w, pv_to_grid_w, home_load_w FROM cloud_grid_snapshots WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`,
);

export function saveCloudGridSnapshot(s) {
  insertCloudGrid.run(s.ts, s.gridToHomeW, s.pvToGridW ?? 0, s.homeLoadW ?? 0);
}

export function getCloudGridRows(fromMs, toMs) {
  return selectCloudGridRows.all(fromMs, toMs);
}

export function pruneCloudGrid() {
  db.prepare(`DELETE FROM cloud_grid_snapshots WHERE ts < ?`).run(Date.now() - RETENTION_MS);
}

// --- PV daily rollup (production / to-home / to-battery per date) ----------
// Computed lazily from battery_snapshots (48 h retention) and kept forever —
// this is what makes week/month/year PV possible without a cloud PV channel.

db.exec(`
  CREATE TABLE IF NOT EXISTS pv_daily (
    date TEXT PRIMARY KEY,
    produced REAL NOT NULL,
    to_home REAL NOT NULL,
    to_batt REAL NOT NULL
  )
`);

const upsertPvDaily = db.prepare(
  `INSERT OR REPLACE INTO pv_daily (date, produced, to_home, to_batt) VALUES (?, ?, ?, ?)`,
);
const selectPvDaily = db.prepare(
  `SELECT * FROM pv_daily WHERE date >= ? AND date <= ? ORDER BY date ASC`,
);
const selectPvDailyDates = db.prepare(`SELECT date FROM pv_daily`);

export function savePvDaily(date, produced, toHome, toBatt) {
  upsertPvDaily.run(date, produced, toHome, toBatt);
}

export function getPvDaily(fromDate, toDate) {
  return selectPvDaily.all(fromDate, toDate);
}

export function getPvDailyDates() {
  return new Set(selectPvDailyDates.all().map((r) => r.date));
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

// --- Cloud PV production day-trend (site-level "solar_production" energy
// analysis, device_type is site-wide so there's no per-device SN to key on)
// — a ground-truth backfill source for gaps in local battery_snapshots
// telemetry. Anker's own cloud records PV production independently of
// whether OUR poller was running, so a local outage (2026-09-16, see
// AGENTS.md) doesn't have to mean permanently undercounted totals. Kept in
// its own table rather than reusing cloud_history: that table's device_sn
// column is used elsewhere (getBatterySn) to mean "the one non-meter SN
// seen" — adding a synthetic PV key there would break that assumption.
db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_pv_history (
    period_type TEXT NOT NULL,
    period_start TEXT NOT NULL,
    label TEXT NOT NULL,
    power REAL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (period_type, period_start, label)
  )
`);

const upsertCloudPvRow = db.prepare(`
  INSERT OR REPLACE INTO cloud_pv_history (period_type, period_start, label, power, fetched_at)
  VALUES (?, ?, ?, ?, ?)
`);

// Which day period_starts are already stored (startup catch-up gap-finder,
// same pattern as getStoredPeriodStarts).
const selectPvPeriodStarts = db.prepare(`
  SELECT DISTINCT period_start FROM cloud_pv_history WHERE period_type = ?
`);

export function getStoredPvPeriodStarts(type = "day") {
  return new Set(selectPvPeriodStarts.all(type).map((r) => r.period_start));
}

export function saveCloudPvTrend(type, start, dataTrend) {
  const now = Date.now();
  db.exec("BEGIN"); // one transaction per trend — see saveCloudTrend
  try {
    for (const t of dataTrend) {
      upsertCloudPvRow.run(type, start, t.time, num(t.power), now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const selectCloudPvDayRows = db.prepare(`
  SELECT period_start, label, power FROM cloud_pv_history
  WHERE period_type = 'day' AND period_start >= ? AND period_start <= ?
`);

export function getCloudPvDayPower(fromDate, toDate) {
  return selectCloudPvDayRows.all(fromDate, toDate).map((r) => ({
    ts: new Date(`${r.period_start}T${r.label}`).getTime(),
    power: r.power,
  }));
}

// Sum cloud-reported power (20-min buckets, instantaneous-average
// convention — see getCloudDayPower) that falls inside any of the given
// local-data gaps (integrateBatteryEnergy's `gaps`). Recovers exactly the
// missing portion without double-counting time the local trapezoid already
// covered more precisely.
export function sumCloudEnergyInGaps(cloudRows, gaps) {
  if (!gaps.length) return 0;
  let kwh = 0;
  for (const r of cloudRows) {
    if (r.power == null) continue;
    if (!gaps.some((g) => r.ts >= g.startMs && r.ts < g.endMs)) continue;
    kwh += (r.power * (20 / 60)) / 1000;
  }
  return Math.round(kwh * 100) / 100;
}

// --- Welcome tab: key-value cache (geocode, PVGIS, AI result) --------------

db.exec(`
  CREATE TABLE IF NOT EXISTS welcome_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )
`);

const kvGetStmt = db.prepare(`SELECT value, fetched_at FROM welcome_store WHERE key = ?`);
const kvSetStmt = db.prepare(
  `INSERT OR REPLACE INTO welcome_store (key, value, fetched_at) VALUES (?, ?, ?)`,
);

export function kvGet(key) {
  const r = kvGetStmt.get(key);
  return r ? { value: JSON.parse(r.value), fetchedAt: r.fetched_at } : null;
}

export function kvSet(key, value) {
  kvSetStmt.run(key, JSON.stringify(value), Date.now());
}

// First battery sample at/after a moment (start-of-day SOC at sunrise).
const selectFirstBatteryAfter = db.prepare(
  `SELECT ts, soc FROM battery_snapshots WHERE ts >= ? AND soc IS NOT NULL ORDER BY ts ASC LIMIT 1`,
);

export function getFirstBatteryAfter(fromMs) {
  return selectFirstBatteryAfter.get(fromMs) ?? null;
}
