import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCloudTrend,
  getAnyDeviceSn,
  getBatterySn,
  getPvDaily,
  getPvDailyDates,
  getStoredPeriodStarts,
} from "./db.js";

// Bill of materials with SNAPSHOTTED purchase prices — user-editable config.
// ROI math must use the prices paid, never live prices, so rows carry their
// own priceSnapshotDate; `estimated: true` flags guesses to correct by hand.
const BOM_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "roi-bom.json");
const FALLBACK_INSTALL_DATE = "2026-09-07"; // day the meter was linked

const r2 = (v) => Math.round(v * 100) / 100;

// Same local-day rule as index.js (account-local dates, never toISOString).
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadBom() {
  try {
    return JSON.parse(fs.readFileSync(BOM_PATH, "utf8")).filter((r) => r && r.asin);
  } catch {
    return [];
  }
}

// Battery cells discharge kWh for one date: integrate the battery SN's
// cloud day-trend (signed 20-min power, discharge +), positive part only.
// The trend is ALREADY cells-only (verified numerically in the dashboard
// channel audit: cloud 0.41 ≈ local cells 0.34, NOT the inverter output),
// so it never overlaps the PV channel — do NOT subtract pvToHome here.
function cellsKwhForDay(battSn, dateStr) {
  if (!battSn) return { cellsKwh: 0, hasRows: false };
  const rows = getCloudTrend(battSn, "day", dateStr).rows;
  let disKwh = 0;
  for (const r of rows) {
    if (r.power == null || r.power <= 0) continue;
    disKwh += (r.power * (20 / 60)) / 1000;
  }
  return { cellsKwh: disKwh, hasRows: rows.length > 0 };
}

export function registerRoiRoute(app, deps = {}) {
  app.get("/api/roi", (req, res) => {
    const bom = loadBom().map((r) => ({ ...r, lineTotalEur: r2(r.qty * r.unitPriceEur) }));
    const totalInvestedEur = r2(bom.reduce((a, r) => a + r.lineTotalEur, 0));
    const tariff = Number(process.env.TARIFF_EUR_PER_KWH ?? 0.3);

    const meterSn = deps.getMeterSn?.() ?? getAnyDeviceSn();
    const battSn = deps.getBatterySn?.() ?? getBatterySn(meterSn);

    // installDate = first day with savings data (PV rollup or battery trend).
    const candidates = [...getPvDailyDates()];
    if (battSn) candidates.push(...getStoredPeriodStarts(battSn, "day"));
    const installDate = candidates.length
      ? candidates.reduce((a, b) => (a < b ? a : b))
      : FALLBACK_INSTALL_DATE;

    // Per-day savings from installDate to YESTERDAY — today is unfinished
    // and would drag the daily average down.
    const yesterday = localDate(new Date(Date.now() - 86400000));
    const pvByDate = new Map(getPvDaily(installDate, yesterday).map((r) => [r.date, r]));

    const series = [];
    let savingsSoFar = 0;
    let measuredDays = 0;
    const startMs = new Date(`${installDate}T00:00:00`).getTime();
    const endMs = new Date(`${yesterday}T00:00:00`).getTime();
    for (let t = startMs; t <= endMs; t += 86400000) {
      const date = localDate(new Date(t));
      const pvToHomeKwh = pvByDate.get(date)?.to_home ?? 0;
      const { cellsKwh, hasRows } = cellsKwhForDay(battSn, date);
      if (pvByDate.has(date) || hasRows) measuredDays++;
      const savedEur = r2((pvToHomeKwh + cellsKwh) * tariff);
      savingsSoFar = r2(savingsSoFar + savedEur);
      series.push({
        date,
        pvKwh: r2(pvToHomeKwh),
        battKwh: r2(cellsKwh),
        savedEur,
        cumulativeEur: savingsSoFar,
      });
    }

    const avgDailySavingsEur = measuredDays ? r2(savingsSoFar / measuredDays) : 0;
    const projectedAnnualSavingsEur = r2(avgDailySavingsEur * 365);
    let paybackDate = null;
    let daysToPayback = null;
    if (avgDailySavingsEur > 0 && totalInvestedEur > 0) {
      daysToPayback = Math.ceil(totalInvestedEur / avgDailySavingsEur);
      paybackDate = localDate(new Date(startMs + daysToPayback * 86400000));
    }
    const projections = [1, 2, 3, 5, 10, 15].map((years) => {
      const cumulativeSavingsEur = r2(avgDailySavingsEur * 365 * years);
      return {
        years,
        cumulativeSavingsEur,
        profitEur: r2(cumulativeSavingsEur - totalInvestedEur),
      };
    });

    res.json({
      ok: true,
      data: {
        bom,
        totalInvestedEur,
        tariffEurPerKwh: tariff,
        installDate,
        savingsSoFarEur: savingsSoFar,
        measuredDays,
        avgDailySavingsEur,
        projectedAnnualSavingsEur,
        paybackDate,
        daysToPayback,
        projections,
        series,
      },
    });
  });
}
