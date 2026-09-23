import {
  getSnapshotRows,
  getCloudDayPower,
  getBatteryHistory,
  getCloudPvDayPower,
  sumCloudEnergyInGaps,
  integrateBatteryEnergy,
  getPvDaily,
  getAnyDeviceSn,
  getBatterySn,
  getEarliestCloudDay,
  getCloudTrend,
  getLatestBattery,
  getGridDaily,
} from "./db.js";
import { savedEur } from "./savings.js";
import { dayBattery, dayGridImportKwh, dayPv } from "./energy-day.js";
import { getTariff } from "./env.js";

// /api/stats/* — Dashboard + top-days: today's live profile, week/month/
// year rollups, single-period time navigation, and production leaderboards.
// Extracted from index.js (2026-09-19, architecture-review roadmap item
// #2 — same registerXRoute(app, deps) shape already proven by welcome.js/
// roi.js/battery-params.js) verbatim except for the deps substitutions
// noted at each site below; see AGENTS.md for the before/after behavior-
// preservation verification.

// Cloud period dates are interpreted by Anker as ACCOUNT-LOCAL days, so
// they must come from local components — toISOString() is UTC and shifts
// the day for the first 1–2 h after local midnight. Local copy (not
// imported from index.js) for the same reason roi.js keeps its own: index.js
// has top-level side effects (starting the server, background jobs) that
// would run on import, so nothing extracted out of it imports back into it.
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

// deps: getMeterSn(), getBatterySn(), getLiveBattery() — same shape/names
// as roi.js and welcome.js/battery-params.js's deps, so the index.js call
// site can reuse the identical closures already passed to those.
export function registerStatsRoute(app, deps) {
  app.get("/api/stats/overview", (req, res) => {
    const sn = deps.getMeterSn?.() ?? getAnyDeviceSn();
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const dayStartMs = todayStart.getTime();
  
    // --- Today: 30-min buckets, local samples where present, cloud 20-min
    // trend elsewhere (anchors), interpolation between anchors. Same merge
    // spirit as /api/timeseries.
    const BUCKET = 30 * 60 * 1000;
    const MAX_GAP_MS = 30 * 60 * 1000;
    const anchors = new Map(); // bt -> {s, c}
    const put = (bt, v) => {
      const cell = (anchors.get(bt) ?? anchors.set(bt, { s: 0, c: 0 }).get(bt));
      cell.s += v;
      cell.c++;
    };
    let peak = null;
    let localCount = 0;
    // Meter-accurate export energy for today (2026-09-23, user request:
    // residual export visibility). The 30-min profile buckets dilute the
    // small residual exports to ~0 — the per-second integral of
    // max(0, -grid) is the truth for those. Tracked pairwise over the raw
    // samples with the same >30 min gap-skip policy as everywhere else.
    let rawExportWh = 0;
    let prevGrid = null;
    for (const r of getSnapshotRows(dayStartMs, now)) {
      if (r.grid_total == null) continue;
      if (prevGrid != null && r.ts - prevGrid.ts <= MAX_GAP_MS) {
        const avgNeg = -Math.min(0, (prevGrid.w + r.grid_total) / 2);
        rawExportWh += (avgNeg * (r.ts - prevGrid.ts)) / 3600000;
      }
      prevGrid = { ts: r.ts, w: r.grid_total };
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
    // Meter-accurate export integral for today (computed in the snapshot
    // loop above) — kWh, rounded like everything else here.
    const exportKwhRaw = Math.round(rawExportWh / 10) / 100;
    // Export is REPLACED by the meter-accurate per-second integral from the
    // snapshot loop above (2026-09-23): the 30-min bucket means dilute the
    // small residual exports this is meant to show. Import stays
    // profile-based (cloud anchors fill meter-down gaps there).
    exportKwh = exportKwhRaw;
    const avgW = profile.length
      ? Math.round(profile.reduce((a, p) => a + p.power, 0) / profile.length)
      : null;
    const elapsedBuckets = Math.max(1, Math.floor((now - dayStartMs) / BUCKET));
    const coverage = Math.min(100, Math.round((profile.length / elapsedBuckets) * 100));
  
    // --- Battery profile for today: 30-s live snapshots as anchors, cloud
    // battery day-trend as fallback, interpolated (same pattern as grid).
    const battSn = deps.getBatterySn?.() ?? getBatterySn(sn);
    const battAnchors = new Map(); // bt -> {s, c} signed battery flow (out − charge)
    const cellsAnchors = new Map(); // bt -> {s, c} cells-only output (excl. PV pass-through)
    const pvAnchors = new Map(); // bt -> {s, c} PV direct-to-home
    const chargeAnchors = new Map(); // bt -> {s, c} charge power (PV/grid into the battery)
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
      putInto(chargeAnchors, bt, Math.max(0, r.charge_w ?? 0));
    }
    if (battSn) {
      const todayStr = localDate(new Date(dayStartMs));
      for (const r of getCloudDayPower(battSn, todayStr, todayStr)) {
        if (r.power == null || r.ts < dayStartMs || r.ts > now) continue;
        if (r.ts + 20 * 60 * 1000 > now) continue;
        const bt = Math.floor(r.ts / BUCKET) * BUCKET;
        if (!battAnchors.has(bt)) putInto(battAnchors, bt, r.power);
        // The cloud battery series is CELLS-only (verified 2026-09-15) — use
        // it as the cells fallback too (no local samples that bucket). It
        // carries no charge information at all (see the ROI BOM entry's
        // sibling finding on cloud_history being discharge-only), so there's
        // no equivalent fallback for chargeAnchors — local samples only.
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
    const chargeByT = interp(chargeAnchors);
    for (const p of profile) {
      p.batt = battByT.get(p.t) ?? null;
      p.cells = cellsByT.get(p.t) ?? null;
      p.pvHome = pvByT.get(p.t) ?? null;
      p.chargeW = chargeByT.get(p.t) ?? null;
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
    for (const r of monthRows) {
      const b = dayBattery(battSn, r.label);
      r.disKwh = b.dischargedKwh;
      r.chgKwh = b.chargedKwh;
    }
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
    const battLatest = deps.getLiveBattery?.() ?? getLatestBattery();
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
    const tariff = getTariff();
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
    // Per-day export history for the period tiles (2026-09-23, user request
    // — residual export visibility): grid_daily (meter trapezoid, recomputed
    // hourly for yesterday) wins for finished days; the cloud month rows'
    // export_energy fills days without a local rollup; today = the raw
    // per-second integral from the snapshot loop above.
    const gridDailyByDate = new Map(getGridDaily("0000-01-01", "9999-12-31").map((r) => [r.date, r]));
    const exportKwhDay = (dateStr, cloudFallback = 0) =>
      dateStr === todayDs
        ? exportKwhRaw
        : (gridDailyByDate.get(dateStr)?.export_kwh ?? cloudFallback);
    // Deliberately battEnergy.dischargedKwh (LOCAL-ONLY), not the backfilled
    // `dischargedKwh` above — cells = discharge − PV-passthrough, and only
    // discharge got a cloud backfill (no matching pvToHomeKwh backfill
    // exists), so subtracting the backfilled figure here would inflate
    // today's "From battery" savings for any gap window. See the battery
    // block's comment above.
    const todayCellsKwh = Math.max(0, r2(battEnergy.dischargedKwh - pvToHomeKwh));
    const todayPvBattKwh = r2(pvToBattKwh);
    const pvDayKwh = (dateStr) => (dateStr === todayDs ? r2(pvToHomeKwh) : dayPv(dateStr).toHome);
    // Total PV production (to-home + to-battery, i.e. everything the panels
    // made) — distinct from pvDayKwh, which is PV-direct-to-home only.
    const pvProducedDayKwh = (dateStr) =>
      dateStr === todayDs ? r2(pvKwh) : dayPv(dateStr).produced;
    // Today's cells override in the per-day rows the sums/bars are built from.
    for (const r of monthRows) if (r.label === todayDs) r.disKwh = todayCellsKwh;
    const battYear = (() => {
      let sum = 0;
      const d = new Date(dayStartMs);
      for (let date = new Date(d.getFullYear(), 0, 1); date <= d; date.setDate(date.getDate() + 1)) {
        const ds = localDate(date);
        sum += ds === todayDs ? todayCellsKwh : dayBattery(battSn, ds).dischargedKwh;
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
        // Residual grid export today (meter-accurate per-second integral).
        exportKwh: exportKwhRaw,
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
        exportKwh: r2(weekRows.reduce((a, r) => a + exportKwhDay(r.label, r.exportKwh ?? 0), 0)),
      },
      month: {
        gridKwh: r2(monthImport),
        battKwh: r2(monthRowsCur.reduce((a, r) => a + (r.disKwh ?? 0), 0)),
        pvKwh: r2(monthRowsCur.reduce((a, r) => a + pvDayKwh(r.label), 0)),
        pvProducedKwh: r2(monthRowsCur.reduce((a, r) => a + pvProducedDayKwh(r.label), 0)),
        exportKwh: r2(monthRowsCur.reduce((a, r) => a + exportKwhDay(r.label, r.exportKwh ?? 0), 0)),
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
        exportKwh: r2(
          yearRows.reduce(
            (a, r) => a + r2(monthKwh(r.label).reduce((x, d) => x + exportKwhDay(d.label, d.exportKwh ?? 0), 0)),
            0,
          ),
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
        batt += ds === todayDs ? todayCellsKwh : dayBattery(battSn, ds).dischargedKwh;
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
    const sn = deps.getMeterSn?.() ?? getAnyDeviceSn();
    const battSn = deps.getBatterySn?.() ?? getBatterySn(sn);
    const tariff = getTariff();
    const r2 = (v) => Math.round(v * 100) / 100;
    const eur = (kwh) => r2(kwh * tariff);
    const earliest = getEarliestCloudDay(sn);
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    // Residual grid export per period (2026-09-23, user request): grid_daily
    // (meter trapezoid over raw samples) wins; the cloud month rows'
    // export_energy fills days without a local rollup.
    const gridDailyByDate = new Map(getGridDaily("0000-01-01", "9999-12-31").map((r) => [r.date, r]));
    const exportKwhDay = (dateStr, cloudFallback = 0) =>
      gridDailyByDate.get(dateStr)?.export_kwh ?? cloudFallback;
  
    // battKwh/pvKwhDay/pvProducedDay: see server/energy-day.js's dayBattery/
    // dayPv — this route used to keep its own copies of both lookups.
    const battKwh = (dateStr) => dayBattery(battSn, dateStr).dischargedKwh;
    const pvKwhDay = (dateStr) => dayPv(dateStr).toHome;
    const pvProducedDay = (dateStr) => dayPv(dateStr).produced;
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
        exportKwh: r.export_energy ?? 0,
      }));
    }
    const dayBars = (rows) =>
      rows.map((r) => ({ label: r.label, grid: r.importKwh, batt: battKwh(r.label), pv: pvKwhDay(r.label) }));
  
    let label;
    let gridKwh = 0;
    let battKwhSum = 0;
    let pvKwhSum = 0;
    let pvProducedKwhSum = 0;
    let exportKwhSum = 0;
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
      exportKwhSum = r2(
        exportKwhDay(dateStr, monthRows(dateStr.slice(0, 7)).find((r) => r.label === dateStr)?.exportKwh ?? 0),
      );
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
        rows.push({ label: ds, importKwh: row?.importKwh ?? 0, exportKwh: row?.exportKwh ?? 0 });
      }
      gridKwh = r2(rows.reduce((a, r) => a + r.importKwh, 0));
      bars = dayBars(rows);
      battKwhSum = r2(bars.reduce((a, b) => a + b.batt, 0));
      pvKwhSum = r2(bars.reduce((a, b) => a + b.pv, 0));
      pvProducedKwhSum = r2(rows.reduce((a, r) => a + pvProducedDay(r.label), 0));
      exportKwhSum = r2(rows.reduce((a, r) => a + exportKwhDay(r.label, r.exportKwh), 0));
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
      exportKwhSum = r2(rows.reduce((a, r) => a + exportKwhDay(r.label, r.exportKwh), 0));
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
      exportKwhSum = r2(
        yearRows.reduce(
          (a, r) => a + monthRows(r.label).reduce((x, d) => x + exportKwhDay(d.label, d.exportKwh), 0),
          0,
        ),
      );
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
        exportKwh: exportKwhSum,
        savedEur: savedEur(pvProducedKwhSum, tariff),
        bars,
      },
    });
  });
  
  // Top/bottom 3 production days (Dashboard tiles) — ranked by pv_daily's
  // `produced` (total PV production, to-home + to-battery), the same field
  // "Right now"/"How today will end" use as the day's PV total. Only
  // FINISHED days qualify: pv_daily is populated once/day for yesterday
  // (rollupPvDaily) — today is always excluded so a partial day can't win
  // or lose against full ones, and zero-production days (before the system
  // was built) are excluded so they don't dominate "lowest production."
  // Battery cloud day-trend is discharge-only (verified against raw rows —
  // power never goes negative on this account), so "charged" can't come from
  // it; that's exactly why pv_daily.to_batt (local trapezoid integration,
  // see welcome-ai.js's pvKwhForDay) is used for battInKwh below instead.
  app.get("/api/stats/top-days", (req, res) => {
    const sn = deps.getMeterSn?.() ?? getAnyDeviceSn();
    const battSn = deps.getBatterySn?.() ?? getBatterySn(sn);
    const r2 = (v) => Math.round(v * 100) / 100;
    const todayDs = localDate();
    const days = getPvDaily("2000-01-01", todayDs)
      .filter((r) => r.date < todayDs && r.produced > 0)
      .map((r) => {
        const gridKwh = r2(dayGridImportKwh(sn, r.date));
        const battKwh = r2(dayBattery(battSn, r.date).dischargedKwh);
        const pvKwh = r2(r.to_home);
        return {
          date: r.date,
          pvProducedKwh: r2(r.produced),
          gridKwh,
          battKwh,
          battInKwh: r2(r.to_batt),
          homeKwh: r2(gridKwh + battKwh + pvKwh),
        };
      });
    const sorted = [...days].sort((a, b) => b.pvProducedKwh - a.pvProducedKwh);
    res.json({
      ok: true,
      data: {
        top: sorted.slice(0, 3),
        bottom: sorted.slice(-3).reverse(),
      },
    });
  });
}
