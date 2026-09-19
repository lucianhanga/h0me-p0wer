import { getCloudTrend, getPvDaily } from "./db.js";

// Single-day energy lookups, factored out of index.js/roi.js where this
// same operation had drifted into four independent implementations (see
// AGENTS.md's architecture-review entry) — one of them (the pre-refactor
// top-days battery helper) silently missing the discharge-only filter the
// other three had, which only matters if this account's battery day-trend
// ever reports a negative (charging) value — it hasn't so far (verified
// against raw rows), but there's no reason to keep three copies of the
// fix and one without it.

// Battery day-trend (20-min signed power; discharge +, charge −) summed
// into kWh for one finished date. The cloud series is CELLS-only (no PV
// pass-through inside — verified 2026-09-15) and, on this account,
// discharge-only in practice — `chargedKwh` stays structurally correct
// (computed, not assumed zero) in case that ever changes, but real
// per-day charge amounts come from `dayPv()`'s `toBattery` instead (see
// its own comment for why).
export function dayBattery(battSn, dateStr) {
  if (!battSn) return { dischargedKwh: 0, chargedKwh: 0, hasRows: false };
  const rows = getCloudTrend(battSn, "day", dateStr).rows;
  let dischargedKwh = 0;
  let chargedKwh = 0;
  for (const r of rows) {
    if (r.power == null) continue;
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
export function dayGridImportKwh(sn, dateStr) {
  if (!sn) return 0;
  const ym = dateStr.slice(0, 7);
  return getCloudTrend(sn, "month", ym).rows.find((r) => r.time === dateStr)?.import_energy ?? 0;
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
