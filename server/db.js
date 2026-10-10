import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { displayDeviceName } from "./device-name.js";

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

const selectCloudDayAbs = db.prepare(`
  SELECT COALESCE(SUM(ABS(power)) + SUM(ABS(import_energy)) + SUM(ABS(export_energy)), 0) AS s
  FROM cloud_history WHERE device_sn = ? AND period_type = ? AND period_start = ?
`);

export function saveCloudTrend(sn, type, start, dataTrend) {
  const now = Date.now();
  // Zero-clobber guard (2026-09-26): same class as the PV one below — the
  // recreated h-solar site returned all-zero trends for every pre-creation
  // day after the Plus→Pro swap, and the backfill upserted 31 days of zeros
  // under the NEW battery's SN (harmless there — its own PK — but a meter
  // or site change could clobber real rows the same way). Never let an
  // all-zero incoming trend overwrite a stored day that has real data.
  // ABS sums: meter power is signed, so plain SUM could cancel to zero.
  const incomingAbs = dataTrend.reduce(
    (a, t) =>
      a + Math.abs(num(t.power) ?? 0) + Math.abs(num(t.import_energy) ?? 0) + Math.abs(num(t.export_energy) ?? 0),
    0,
  );
  if (incomingAbs === 0) {
    const storedAbs = selectCloudDayAbs.get(sn, type, start)?.s ?? 0;
    if (storedAbs > 0) {
      console.warn(`[db] refused to overwrite nonzero cloud history for ${sn}/${start} with an all-zero trend`);
      return;
    }
  }
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

// METER SNs in cloud history (2026-09-27 meter swap, meter-1 → meter-2):
// meters are the devices that have month/year period rows; batteries only
// ever have day rows. getMeterSns() = all of them; getAnyDeviceSn() = the
// freshest (fallback when the meter is offline).
const selectMeterSns = db.prepare(`
  SELECT DISTINCT device_sn AS sn FROM cloud_history WHERE period_type IN ('month', 'year') ORDER BY sn
`);

export function getMeterSns() {
  return selectMeterSns.all().map((r) => r.sn);
}

const selectAnySn = db.prepare(`
  SELECT device_sn AS sn FROM cloud_history WHERE period_type = 'month'
  GROUP BY device_sn ORDER BY MAX(period_start) DESC, MAX(fetched_at) DESC LIMIT 1
`);

export function getAnyDeviceSn() {
  return selectAnySn.get()?.sn ?? null;
}

// Merged cloud trend across SNs (meter swap continuity, 2026-09-27):
// month/year energy rows sum per label across meters (they never measure
// simultaneously — physical swap — so sums are correct); day power rows
// prefer the fresher nonzero value per label. Replaces per-SN reads for
// every "history of the house's grid" use.
export function getCloudTrendMulti(sns, type, start) {
  const byLabel = new Map();
  let fetchedAt = 0;
  for (const sn of (Array.isArray(sns) ? sns : [sns]).filter(Boolean)) {
    const { rows, fetchedAt: f } = getCloudTrend(sn, type, start);
    fetchedAt = Math.max(fetchedAt, f);
    for (const r of rows) {
      const cur = byLabel.get(r.time);
      if (!cur) {
        byLabel.set(r.time, { ...r });
        continue;
      }
      if (r.import_energy != null || r.export_energy != null) {
        cur.import_energy = (cur.import_energy ?? 0) + (r.import_energy ?? 0);
        cur.export_energy = (cur.export_energy ?? 0) + (r.export_energy ?? 0);
      }
      if (r.power != null && (cur.power == null || cur.power === 0)) cur.power = r.power;
    }
  }
  return { rows: [...byLabel.values()], fetchedAt };
}

// First day with cloud history (when the meter was linked) — dashboard time
// navigation stops there.
const selectEarliestDay = db.prepare(`
  SELECT MIN(period_start) AS d FROM cloud_history WHERE device_sn = ? AND period_type = 'day'
`);

export function getEarliestCloudDay(sn) {
  return selectEarliestDay.get(sn ?? "")?.d ?? null;
}

// Battery SNs = all cloud_history device SNs that aren't the meter. Since
// the 2026-09-26 hardware swap (Solarbank 2 E1600 Plus → E1600 Pro) there
// are TWO: history stays under the OLD SN forever while new rows land under
// the new one. getBatterySn() = the CURRENT battery (freshest rows), for
// live/config purposes; getBatterySns() = all of them, for history
// aggregation across the swap (old and new never overlap in time — it was a
// physical swap — so summing both per day is physically correct).
const selectBatterySn = db.prepare(`
  SELECT device_sn AS sn FROM cloud_history
  WHERE device_sn NOT IN (SELECT DISTINCT device_sn FROM cloud_history WHERE period_type IN ('month', 'year'))
  GROUP BY device_sn ORDER BY MAX(period_start) DESC, MAX(fetched_at) DESC LIMIT 1
`);

export function getBatterySn() {
  return selectBatterySn.get()?.sn ?? null;
}

const selectBatterySns = db.prepare(`
  SELECT DISTINCT device_sn AS sn FROM cloud_history
  WHERE device_sn NOT IN (SELECT DISTINCT device_sn FROM cloud_history WHERE period_type IN ('month', 'year'))
  ORDER BY sn
`);

export function getBatterySns() {
  return selectBatterySns.all().map((r) => r.sn);
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

// Per-module SOC/temperature history has NO cloud equivalent (MQTT 0405/
// 040a is realtime-only) — pruning it at the 48 h live-sample retention
// destroyed the only copy and capped the Graph tab's module charts at 2
// days (user report 2026-10-10: "30-day view shows just 2 days"). Own
// retention: 93 days (3× the largest graph span), with a 60 s write
// throttle — MQTT telemetry arrives every 3-5 s, which untamed is ~25 M
// rows/year; at 1/min it's ~0.5 M/quarter and SOC/temp move far slower
// than that anyway.
const MODULE_RETENTION_MS = 93 * 86400000;
const MODULE_MIN_WRITE_GAP_MS = 60 * 1000;

export function pruneBattery() {
  db.prepare(`DELETE FROM battery_snapshots WHERE ts < ?`).run(Date.now() - RETENTION_MS);
  db.prepare(`DELETE FROM module_snapshots WHERE ts < ?`).run(Date.now() - MODULE_RETENTION_MS);
}

// --- Per-module battery data (MQTT 0405 main unit / 040a expansions) ------
// SOC + temperature per PHYSICAL module (main unit + each expansion pack) —
// the only place this exists (no REST/cloud-history equivalent); feeds the
// Graph tab's module charts (2026-09-27). 93-day retention + 60 s write
// throttle (see pruneBattery above — the 48 h live-sample retention used to
// cap these charts at 2 days, 2026-10-10).
db.exec(`
  CREATE TABLE IF NOT EXISTS module_snapshots (
    ts INTEGER NOT NULL,
    module TEXT NOT NULL,
    soc REAL,
    temperature_c REAL,
    PRIMARY KEY (ts, module)
  )
`);

const upsertModuleRow = db.prepare(`
  INSERT OR REPLACE INTO module_snapshots (ts, module, soc, temperature_c)
  VALUES (?, ?, ?, ?)
`);

// In-memory per-module throttle (session-scoped — a restart always writes
// immediately, which is exactly what a restart should do).
const lastModuleWriteAt = new Map();

// module: "main" | "exp1" | "exp2" | … (matching the 040a pack order).
export function saveModuleSnapshot(ts, module, soc, temperatureC) {
  const isNullOnly = soc == null && temperatureC == null;
  const last = lastModuleWriteAt.get(module) ?? 0;
  // Null-only rows never arm the throttle — they'd starve the real value
  // arriving seconds later (REST path writes unit-total soc for unmapped
  // PNs; MQTT writes the real per-module values). Out-of-order (older) ts
  // always writes — backfills/tests, never the live path.
  if (!isNullOnly && ts - last >= 0 && ts - last < MODULE_MIN_WRITE_GAP_MS) return;
  if (!isNullOnly) lastModuleWriteAt.set(module, ts);
  upsertModuleRow.run(ts, module, soc ?? null, temperatureC ?? null);
}

const selectModuleRows = db.prepare(`
  SELECT ts, module, soc, temperature_c FROM module_snapshots
  WHERE ts >= ? AND ts <= ? ORDER BY ts ASC
`);

export function getModuleHistory(fromMs, toMs) {
  return selectModuleRows.all(fromMs, toMs);
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

// --- Daily grid energy rollup (meter-accurate import + export per day) ---
// Added 2026-09-23 (user request: the residual grid export must be visible
// long-term). Raw snapshots live only 48 h and the cloud's export_energy
// under-reports exactly the small residual exports this table is about
// (its period_export read 0.00 kWh on a day the meter measured 0.02) — so
// a meter trapezoid, recomputed for YESTERDAY only (always fully inside
// the retention window — same reasoning as rollupPvDaily in index.js),
// persisted here forever.
db.exec(`
  CREATE TABLE IF NOT EXISTS grid_daily (
    date TEXT PRIMARY KEY,
    import_kwh REAL NOT NULL,
    export_kwh REAL NOT NULL
  )
`);
const upsertGridDaily = db.prepare(
  `INSERT OR REPLACE INTO grid_daily (date, import_kwh, export_kwh) VALUES (?, ?, ?)`,
);
const selectGridDaily = db.prepare(
  `SELECT * FROM grid_daily WHERE date >= ? AND date <= ? ORDER BY date ASC`,
);

export function saveGridDaily(date, importKwh, exportKwh) {
  upsertGridDaily.run(date, importKwh, exportKwh);
}

export function getGridDaily(fromDate, toDate) {
  return selectGridDaily.all(fromDate, toDate);
}

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
  // Single-sample spike trimming (2026-09-23, user report): since the 1 s
  // meter poll, one isolated 1 s sample of compressor inrush (measured
  // real: 2951 W for exactly one sample, 257/406 W neighbors) inflated its
  // bucket's max into a tall "needle" on the 1h/6h charts, and even the
  // bucket MEAN noticeably (e.g. 260 → 510 W for one 5 s bucket). The
  // Anker app's own chain smooths these away. So: bucket value = trimmed
  // mean (drop the single highest and lowest sample once ≥ 5 samples —
  // multi-sample pulses like a 15 s kettle burst are preserved, only
  // isolated 1 s extremes are dropped), and the envelope uses the
  // SECOND-most-extreme sample (a spike must persist ≥ 2 samples to shape
  // the visible band). Energy math elsewhere uses raw rows, untouched.
  const buckets = new Map(); // bt -> {grid:{vals:[]}, ...}
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
      const cell = (b[key] ??= { vals: [] });
      cell.vals.push(value);
    }
  }
  const trimmed = (vals) => {
    if (!vals.length) return { mean: null, min: null, max: null };
    if (vals.length < 5) {
      const s = vals.reduce((a, v) => a + v, 0);
      return { mean: s / vals.length, min: Math.min(...vals), max: Math.max(...vals) };
    }
    const sorted = [...vals].sort((a, b) => a - b);
    const inner = sorted.slice(1, -1);
    return {
      mean: inner.reduce((a, v) => a + v, 0) / inner.length,
      min: sorted[1], // second-lowest
      max: sorted[sorted.length - 2], // second-highest
    };
  };
  return [...buckets.entries()].map(([bt, b]) => {
    const g = b.grid ? trimmed(b.grid.vals) : {};
    return {
      bt,
      grid: g.mean ?? null,
      gridMin: g.min ?? null,
      gridMax: g.max ?? null,
      l1: b.l1 ? trimmed(b.l1.vals).mean : null,
      l2: b.l2 ? trimmed(b.l2.vals).mean : null,
      l3: b.l3 ? trimmed(b.l3.vals).mean : null,
      solar: b.solar ? trimmed(b.solar.vals).mean : null,
    };
  });
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

// --- Activity log (user-visible decision/event journal, 2026-09-27) -----
// Structured (kind + params, NEVER pre-rendered text) so the frontend can
// translate every entry into the selected UI language and read it aloud.
// Append-only, capped — read by /api/activity and pushed live over WS.
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    kind TEXT NOT NULL,
    params TEXT
  )
`);

const insertActivity = db.prepare(`
  INSERT INTO activity_log (ts, level, kind, params) VALUES (?, ?, ?, ?)
`);
const selectActivity = db.prepare(`
  SELECT id, ts, level, kind, params FROM activity_log ORDER BY id DESC LIMIT ?
`);
const deleteOldActivity = db.prepare(`
  DELETE FROM activity_log WHERE id < (SELECT COALESCE(MAX(id), 0) - ? FROM activity_log)
`);

export const ACTIVITY_KEEP = 200;

export function logActivity(kind, { level = "info", ...params } = {}) {
  try {
    insertActivity.run(Date.now(), level, kind, Object.keys(params).length ? JSON.stringify(params) : null);
    deleteOldActivity.run(ACTIVITY_KEEP);
  } catch (err) {
    console.warn("[activity] log failed:", err.message);
  }
}

export function getActivity(limit = 50) {
  return selectActivity
    .all(Math.min(Math.max(Number(limit) || 50, 1), ACTIVITY_KEEP))
    .map((r) => ({ ...r, params: r.params ? JSON.parse(r.params) : null }));
}

// Bumped whenever a repair rewrites history (the PV shape repairs) — the
// browser-side history cache keys on this so a repair invalidates every
// cached window (2026-10-01, user request: cache historical values in the
// browser, but only values that don't change anymore — repairs DO change
// them, once, and this marker is how the browser finds out).
export function getHistoryVersion() {
  const v2 = kvGet("pv_shape_repair_v2")?.value?.at ?? 0;
  const v3 = kvGet("pv_shape_repair_v3")?.value?.at ?? 0;
  return Math.max(v2, v3);
}

// --- Cloud PV production day-trend (site-level "solar_production" energy
// analysis, device_type is site-wide so there's no per-device SN to key on)
// — a ground-truth backfill source for gaps in local battery_snapshots
// telemetry. Anker's own cloud records PV production independently of
// whether OUR poller was running, so a local outage (2026-09-16, see
// AGENTS.md) doesn't have to mean permanently undercounted totals. Kept in
// its own table rather than reusing cloud_history: that table's device_sn
// column is used elsewhere (getBatterySn/getBatterySns) to mean "the
// non-meter SNs seen" — adding a synthetic PV key there would break that
// assumption.
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

const selectCloudPvDaySum = db.prepare(`
  SELECT COALESCE(SUM(power), 0) AS s FROM cloud_pv_history WHERE period_type = ? AND period_start = ?
`);

// Latest day BEFORE the given one that holds real (nonzero) PV production —
// the reference shape for reconstructing zeroed days (see repair below).
const selectLastNonzeroPvDay = db.prepare(`
  SELECT period_start AS d FROM cloud_pv_history
  WHERE period_type = 'day' AND period_start < ?
  GROUP BY period_start HAVING SUM(power) > 0
  ORDER BY period_start DESC LIMIT 1
`);

export function getLastNonzeroPvDayBefore(dateStr) {
  return selectLastNonzeroPvDay.get(dateStr)?.d ?? null;
}

export function getCloudPvDaySum(type, start) {
  return selectCloudPvDaySum.get(type, start)?.s ?? 0;
}

// Cleanup (idempotent, runs every boot — cheap no-op after the first):
// delete "HH:MM"-labelled ZERO rows that shadow a nonzero sibling at the
// same 20-min interval (the recreated site's label format vs. the repair's
// — see getCloudPvDayPower's dedupe). Night/idle zero rows have no nonzero
// sibling and stay.
db.exec(`
  DELETE FROM cloud_pv_history WHERE length(label) = 5 AND power = 0 AND EXISTS (
    SELECT 1 FROM cloud_pv_history b
    WHERE b.period_type = cloud_pv_history.period_type
      AND b.period_start = cloud_pv_history.period_start
      AND substr(b.label, 1, 5) = substr(cloud_pv_history.label, 1, 5)
      AND b.label != cloud_pv_history.label
      AND b.power > 0
  )
`);

export function saveCloudPvTrend(type, start, dataTrend) {
  const now = Date.now();
  // Zero-clobber guard (2026-09-26): the h-solar SITE was recreated during
  // the Plus→Pro battery swap, and the recreated site returns all-ZERO
  // solar_production trends for every pre-creation day — one backfill
  // upserted those zeros over 12 days of real PV history (09-14..25), and
  // the same hit production. Never let an all-zero incoming trend overwrite
  // a day that already has real data. Legit all-zero days (pre-install,
  // fully overcast) have no nonzero stored rows, so they're unaffected.
  const incomingSum = dataTrend.reduce((a, t) => a + (num(t.power) ?? 0), 0);
  if (incomingSum === 0 && getCloudPvDaySum(type, start) > 0) {
    console.warn(`[db] refused to overwrite nonzero PV history for ${start} with an all-zero trend`);
    return;
  }
  db.exec("BEGIN"); // one transaction per trend — see saveCloudTrend
  try {
    for (const t of dataTrend) {
      // Normalize labels to "HH:MM:SS" (2026-09-27): the recreated site
      // returns "HH:MM" while older syncs + the repair wrote "HH:MM:SS" —
      // mixed formats create duplicate rows per interval (see
      // getCloudPvDayPower's dedupe). Normalizing on write makes upserts
      // REPLACE instead of duplicating.
      const label = String(t.time).length === 5 ? `${t.time}:00` : String(t.time);
      upsertCloudPvRow.run(type, start, label, num(t.power), now);
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

// --- Home-consumption day-trends (device_type "home_usage") ---------------
// Same shape as cloud_pv_history: 20-min power averages per day, kept
// forever. This is the source for the "usual consumption" profile the
// flow diagram's Home node shows (2026-10-03, user request) — Anker's
// cloud records it independently of whether OUR poller was running.
db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_home_history (
    period_type TEXT NOT NULL,
    period_start TEXT NOT NULL,
    label TEXT NOT NULL,
    power REAL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (period_type, period_start, label)
  )
`);

const upsertCloudHomeRow = db.prepare(`
  INSERT OR REPLACE INTO cloud_home_history (period_type, period_start, label, power, fetched_at)
  VALUES (?, ?, ?, ?, ?)
`);

const selectHomePeriodStarts = db.prepare(`
  SELECT DISTINCT period_start FROM cloud_home_history WHERE period_type = ?
`);

export function getStoredHomePeriodStarts(type = "day") {
  return new Set(selectHomePeriodStarts.all(type).map((r) => r.period_start));
}

// One-time cleanup for the 2026-10-03 device_sn bug (first home_usage sync
// passed the solarbank SN, which makes the endpoint return all-zero
// trends) — wipe so the backfill refetches with the fixed call.
export function wipeCloudHomeHistory() {
  db.exec("DELETE FROM cloud_home_history");
}

const selectCloudHomeDaySum = db.prepare(`
  SELECT COALESCE(SUM(power), 0) AS s FROM cloud_home_history WHERE period_type = ? AND period_start = ?
`);

export function saveCloudHomeTrend(type, start, dataTrend) {
  const now = Date.now();
  // Same zero-clobber guard as saveCloudPvTrend (the 2026-09-26 recreated-
  // site incident class). A real home never draws exactly 0 W for a whole
  // day, so the guard is safe.
  const incomingSum = dataTrend.reduce((a, t) => a + (num(t.power) ?? 0), 0);
  if (incomingSum === 0 && selectCloudHomeDaySum.get(type, start)?.s > 0) {
    console.warn(`[db] refused to overwrite nonzero home history for ${start} with an all-zero trend`);
    return;
  }
  db.exec("BEGIN");
  try {
    for (const t of dataTrend) {
      // Normalize labels to "HH:MM:SS" (same mixed-format lesson as
      // saveCloudPvTrend, 2026-09-27).
      const label = String(t.time).length === 5 ? `${t.time}:00` : String(t.time);
      upsertCloudHomeRow.run(type, start, label, num(t.power), now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Usual-consumption profile: average W per (weekday, hour) over the last
// `days` days of home-usage history, skipping poorly-covered days. Used by
// /api/flow's home.usualW (2026-10-03, user request — recomputed hourly).
const selectHomeRowsSince = db.prepare(`
  SELECT period_start, label, power FROM cloud_home_history
  WHERE period_type = 'day' AND period_start >= ?
`);

export function computeConsumptionProfile(days = 56) {
  const since = new Date(Date.now() - days * 86400000);
  const sinceStr = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`;
  const byDay = new Map(); // period_start -> Map(hour -> [w, w, w])
  for (const r of selectHomeRowsSince.all(sinceStr)) {
    // Skip null AND exact-zero rows (2026-10-03): today's trend pads the
    // open and future 20-min intervals with 0 (verified: 574 W at 20:40,
    // then 0 from 21:00 on while the house drew ~450 W) — a real home never
    // averages exactly 0 W over a closed 20-min interval, so a zero is a
    // data hole, not a measurement. Storing them poisoned the current
    // hour's cell (Saturday 21:00 read "usual 0 W").
    if (!r.power) continue;
    const hour = Number(String(r.label).slice(0, 2));
    if (!byDay.has(r.period_start)) byDay.set(r.period_start, new Map());
    const hours = byDay.get(r.period_start);
    if (!hours.has(hour)) hours.set(hour, []);
    hours.get(hour).push(r.power);
  }
  // Weekday per date, averaged per (weekday, hour). Two day-level filters:
  // partial days (< 20 covered hours skew the profile), and ALL-ZERO days —
  // a real home never draws exactly 0 W for 24 h, so an all-zero day is a
  // data hole (the recreated site returns zeros for every pre-creation day,
  // 2026-10-03: 25 of 31 days were zeros and dragged every cell ~6x low).
  const cells = {}; // dow -> hour -> {sum, n}
  const cellsAny = {}; // hour -> {sum, n} — fallback when the weekday cell
  // has no data yet (e.g. today's remaining evening hours with a young
  // history where the current weekday has only ever produced past hours).
  let daysUsed = 0;
  for (const [dateStr, hours] of byDay) {
    if (hours.size < 20) continue;
    let daySum = 0;
    for (const ws of hours.values()) daySum += ws.reduce((a, v) => a + v, 0);
    if (daySum === 0) continue;
    daysUsed += 1;
    const dow = new Date(`${dateStr}T12:00:00`).getDay();
    if (!cells[dow]) cells[dow] = {};
    for (const [hour, ws] of hours) {
      const avg = ws.reduce((a, v) => a + v, 0) / ws.length;
      if (!cells[dow][hour]) cells[dow][hour] = { sum: 0, n: 0 };
      cells[dow][hour].sum += avg;
      cells[dow][hour].n += 1;
      if (!cellsAny[hour]) cellsAny[hour] = { sum: 0, n: 0 };
      cellsAny[hour].sum += avg;
      cellsAny[hour].n += 1;
    }
  }
  const profile = {};
  for (const [dow, hours] of Object.entries(cells)) {
    profile[dow] = {};
    for (const [hour, { sum, n }] of Object.entries(hours)) {
      profile[dow][hour] = Math.round(sum / n);
    }
  }
  const profileAny = {};
  for (const [hour, { sum, n }] of Object.entries(cellsAny)) {
    profileAny[hour] = Math.round(sum / n);
  }
  return { at: Date.now(), daysUsed, cells: profile, cellsAny: profileAny };
}

const selectCloudHomeDayRows = db.prepare(`
  SELECT period_start, label, power FROM cloud_home_history
  WHERE period_type = 'day' AND period_start >= ? AND period_start <= ?
`);

export function getCloudHomeDayPower(fromDate, toDate) {
  // Same per-interval dedupe as getCloudPvDayPower (label-format lesson).
  const byInterval = new Map();
  for (const r of selectCloudHomeDayRows.all(fromDate, toDate)) {
    const key = `${r.period_start}T${String(r.label).slice(0, 5)}`;
    const cur = byInterval.get(key);
    if (cur == null || (r.power ?? 0) > (cur.power ?? 0)) byInterval.set(key, r);
  }
  return [...byInterval.values()].map((r) => ({
    ts: new Date(`${r.period_start}T${r.label}`).getTime(),
    power: r.power,
  }));
}

export function getCloudPvDayPower(fromDate, toDate) {
  // Dedupe per 20-min interval, preferring NONZERO (2026-09-27): the
  // recreated h-solar site returns solar_production labels as "HH:MM" while
  // earlier syncs + the PV-history repair wrote "HH:MM:SS" — so affected
  // days hold BOTH rows per interval (145 rows/day), and the plain query's
  // first row per bucket (the zero one) shadowed the real repaired values
  // on production. Keep the max-power row per normalized interval.
  const byInterval = new Map();
  for (const r of selectCloudPvDayRows.all(fromDate, toDate)) {
    const key = `${r.period_start}T${String(r.label).slice(0, 5)}`;
    const cur = byInterval.get(key);
    if (cur == null || (r.power ?? 0) > (cur.power ?? 0)) byInterval.set(key, r);
  }
  return [...byInterval.values()].map((r) => ({
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

// Stable per-plug color assignment (2026-10-10, user request — with 9 plugs
// the 8-color palette wrapped AND the old name-sorted position recolored
// every plug whenever a new name sorted earlier). SNs are kept in first-seen
// order; a plug's palette index never shifts again, and slots past the used
// prefix stay "reserved" for future plugs (palette ordered by bit-reversed
// hue — see PLUG_COLORS in web/src/plugs/PlugsTab.jsx).
const PLUG_COLOR_ORDER_KEY = "plug_color_order";

export function ensurePlugColors(sns) {
  if (!sns?.length) return;
  const order = kvGet(PLUG_COLOR_ORDER_KEY)?.value ?? [];
  const known = new Set(order);
  const added = sns.filter((sn) => !known.has(sn));
  if (added.length) kvSet(PLUG_COLOR_ORDER_KEY, [...order, ...added]);
}

export function getPlugColorIdx() {
  const order = kvGet(PLUG_COLOR_ORDER_KEY)?.value ?? [];
  return new Map(order.map((sn, i) => [sn, i]));
}

// First battery sample at/after a moment (start-of-day SOC at sunrise).
const selectFirstBatteryAfter = db.prepare(
  `SELECT ts, soc FROM battery_snapshots WHERE ts >= ? AND soc IS NOT NULL ORDER BY ts ASC LIMIT 1`,
);

export function getFirstBatteryAfter(fromMs) {
  return selectFirstBatteryAfter.get(fromMs) ?? null;
}

// --- Smart plugs (A17X8): live power samples + daily energy ----------------
// Live watts piggyback on the 10 s scene poll (anker-cloud.js getBatteryInfo
// extracts smart_plug_info); the cloud exposes NO intraday plug history, so
// this local accumulation is the only source for per-plug power curves
// (2026-10-06, Plugs tab). Daily per-plug kWh comes from the home_usage
// energy_analysis response's smart_plug_info (same query the home trend
// sync already runs — zero extra API calls).
db.exec(`
  CREATE TABLE IF NOT EXISTS plug_samples (
    ts INTEGER NOT NULL,
    sn TEXT NOT NULL,
    watts REAL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_plug_samples_ts ON plug_samples(ts)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS plug_daily (
    date TEXT NOT NULL,
    sn TEXT NOT NULL,
    name TEXT,
    kwh REAL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (date, sn)
  )
`);

const insertPlugSample = db.prepare(
  `INSERT INTO plug_samples (ts, sn, watts) VALUES (?, ?, ?)`,
);

export function savePlugSamples(ts, plugs) {
  if (!plugs?.length) return;
  db.exec("BEGIN");
  try {
    for (const p of plugs) insertPlugSample.run(ts, p.sn, p.watts);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const selectPlugSamples = db.prepare(
  `SELECT ts, sn, watts FROM plug_samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`,
);

// Trapezoid-integrated kWh for ONE plug over [fromMs, toMs] from local
// samples — the daily-kWh source for SITE-LESS plugs (2026-10-10): the
// cloud's per-plug daily kWh only exists for site members, so account-level
// plugs integrate their MQTT-fed samples instead. Gaps (server off) simply
// integrate across them — watts are assumed to hold between samples.
export function plugDayKwhFromSamples(sn, fromMs, toMs) {
  let wh = 0;
  let prev = null;
  for (const r of selectPlugSamples.all(fromMs, toMs)) {
    if (r.sn !== sn || r.watts == null) continue;
    if (prev != null) {
      // Clamp long gaps to 15 min of credit — a stale value shouldn't
      // integrate over hours of server downtime as if it ran constantly.
      const dtH = Math.min(r.ts - prev.ts, 15 * 60 * 1000) / 3600000;
      wh += ((prev.watts + r.watts) / 2) * dtH;
    }
    prev = r;
  }
  return Math.round(wh / 10) / 100; // Wh → kWh, 2 decimals
}

// Single-row daily upsert for site-less plugs (cloud rows for site plugs
// come via savePlugDaily; these are computed locally from samples).
export function upsertPlugDailyRow(date, sn, name, kwh) {
  upsertPlugDaily.run(date, sn, name, kwh, Date.now());
}

export function getPlugSamples(fromMs, toMs) {
  return selectPlugSamples.all(fromMs, toMs);
}

const prunePlugSamplesStmt = db.prepare(`DELETE FROM plug_samples WHERE ts < ?`);

// 7 days of intraday detail (long-term per-plug history lives in plug_daily).
export function prunePlugSamples() {
  prunePlugSamplesStmt.run(Date.now() - 7 * 86400000);
}

const upsertPlugDaily = db.prepare(
  `INSERT OR REPLACE INTO plug_daily (date, sn, name, kwh, fetched_at) VALUES (?, ?, ?, ?, ?)`,
);

export function savePlugDaily(date, plugs) {
  if (!plugs?.length) return;
  const now = Date.now();
  db.exec("BEGIN");
  try {
    for (const p of plugs) {
      upsertPlugDaily.run(date, p.device_sn, p.device_name ? displayDeviceName(p.device_name) : null, num(p.total_power), now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const selectPlugDailySince = db.prepare(
  `SELECT date, sn, name, kwh FROM plug_daily WHERE date >= ? ORDER BY date ASC`,
);

export function getPlugDaily(sinceDate) {
  // Rows written before the display-name convention (2026-10-07) still
  // carry the h-solar- prefix — normalize on read.
  return selectPlugDailySince.all(sinceDate).map((r) => ({
    ...r,
    name: r.name ? displayDeviceName(r.name) : r.name,
  }));
}

const selectEarliestPlugDate = db.prepare(`SELECT MIN(date) AS d FROM plug_daily`);

export function getEarliestPlugDate() {
  return selectEarliestPlugDate.get()?.d ?? null;
}

// All plug SNs ever seen, with their latest name — the Consumers tiles list
// every known plug even in periods where it reported 0 (2026-10-07).
const selectAllPlugNames = db.prepare(
  `SELECT sn, name FROM plug_daily ORDER BY date ASC`,
);

export function getAllPlugNames() {
  const names = new Map();
  for (const r of selectAllPlugNames.all()) {
    if (r.name) names.set(r.sn, displayDeviceName(r.name));
    else if (!names.has(r.sn)) names.set(r.sn, null);
  }
  return names;
}
