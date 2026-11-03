import { getCloudDayPower, getCloudTrend, getPvDaily } from "./db.js";

// Single-day energy lookups, factored out of index.js/roi.js where this
// same operation had drifted into four independent implementations (see
// AGENTS.md's architecture-review entry) — one of them (the pre-refactor
// top-days battery helper) silently missing the discharge-only filter the
// other three had, which only matters if this account's battery day-trend
// ever reports a negative (charging) value — it hasn't so far (verified
// against raw rows), but there's no reason to keep three copies of the
// fix and one without it.

function samePowerSeries(a, b) {
  if (!a.length || a.length !== b.length) return false;
  const byTs = new Map(b.map((r) => [r.ts, r.power]));
  return a.every((r) => byTs.has(r.ts) && byTs.get(r.ts) === r.power);
}

export function batteryCloudDayPower(battSns, dateStr) {
  const sns = (Array.isArray(battSns) ? battSns : [battSns]).filter(Boolean);
  const unique = [];
  for (const sn of sns) {
    const rows = getCloudDayPower(sn, dateStr, dateStr);
    if (rows.length && unique.some((other) => samePowerSeries(other, rows))) continue;
    unique.push(rows);
  }
  // The dock can return the SAME site-total series under each unit SN. Drop
  // only exact full-day duplicates; genuinely different unit series still sum.
  const byTs = new Map();
  for (const rows of unique) {
    for (const r of rows) {
      if (r.power == null) continue;
      byTs.set(r.ts, { ts: r.ts, power: (byTs.get(r.ts)?.power ?? 0) + r.power });
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export function batteryCloudPowerRange(battSns, fromDate, toDate) {
  const rows = [];
  for (let day = new Date(`${fromDate}T00:00:00Z`); ; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    if (date > toDate) break;
    rows.push(...batteryCloudDayPower(battSns, date));
  }
  return rows;
}

// Battery day-trend (20-min signed power; discharge +, charge −) summed
// into kWh for one finished date. The cloud series is CELLS-only (no PV
// pass-through inside — verified 2026-09-15) and, on this account,
// discharge-only in practice — `chargedKwh` stays structurally correct
// (computed, not assumed zero) in case that ever changes, but real
// per-day charge amounts come from `dayPv()`'s `toBattery` instead (see
// its own comment for why).
export function dayBattery(battSns, dateStr) {
  const rows = batteryCloudDayPower(battSns, dateStr);
  let dischargedKwh = 0;
  let chargedKwh = 0;
  for (const r of rows) {
    const kwh = (r.power * (20 / 60)) / 1000;
    if (kwh >= 0) dischargedKwh += kwh;
    else chargedKwh += -kwh;
  }
  return {
    dischargedKwh: Math.round(dischargedKwh * 100) / 100,
    chargedKwh: Math.round(chargedKwh * 100) / 100,
    hasRows: rows.length > 0,
  };
}

// Grid import kWh for one finished date, from the meter's cloud month
// rows. Bulk week/month/year views fetch a whole month at once instead
// (a different access pattern, not duplicated logic — see monthKwh/
// monthRows in index.js) — this is for the single-day case only.
export function dayGridImportKwh(sns, dateStr) {
  // Meter swap continuity (2026-09-27): one SN or an array — sum across
  // meters (they never measured simultaneously).
  const list = (Array.isArray(sns) ? sns : [sns]).filter(Boolean);
  if (!list.length) return 0;
  const ym = dateStr.slice(0, 7);
  return list.reduce(
    (a, sn) => a + (getCloudTrend(sn, "month", ym).rows.find((r) => r.time === dateStr)?.import_energy ?? 0),
    0,
  );
}

// PV kWh for one FINISHED date, from the local pv_daily rollup (populated
// once/day for yesterday — see rollupPvDaily in index.js). Has no row for
// today by design; callers needing today's PV use a live trapezoid
// integration instead (index.js's /api/stats/overview, welcome-ai.js's
// pvKwhForDay) — that's genuinely different data (today is unfinished),
// not a case this function should special-case.
export function dayPv(dateStr) {
  const row = getPvDaily(dateStr, dateStr)[0];
  return { toHome: row?.to_home ?? 0, produced: row?.produced ?? 0, toBattery: row?.to_batt ?? 0 };
}
