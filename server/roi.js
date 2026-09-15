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
import { buildBomPdf } from "./roi-pdf.js";
import { getBaseline, computeBaseline } from "./roi-baseline.js";

// Bill of materials with SNAPSHOTTED purchase prices — user-editable config.
// ROI math must use the prices paid, never live prices, so rows carry their
// own priceSnapshotDate; `estimated: true` flags guesses to correct by hand.
const BOM_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "roi-bom.json");
// Product pictures: fetched once (Amazon robot-walls curl; headless Chrome
// passes), committed to git so they never disappear.
const IMG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "roi-images");
const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const FALLBACK_INSTALL_DATE = "2026-09-07"; // day the meter was linked
const DAY_MS = 86400000;
// Hard cap for the forecast horizon when the investment never pays back.
const MAX_FORECAST_DAYS = 25 * 365;
// Extra horizon drawn past the break-even point.
const POST_PAYBACK_MONTHS = 6;

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

// Measured per-day savings from installDate to YESTERDAY (today is
// unfinished and would drag the average down). Display-only since the
// baseline took over the ROI math — kept as the "actual" comparison.
function measuredSavings(battSn, installDate, tariff) {
  const yesterday = localDate(new Date(Date.now() - DAY_MS));
  const pvByDate = new Map(getPvDaily(installDate, yesterday).map((r) => [r.date, r]));
  const series = [];
  let savingsSoFar = 0;
  let measuredDays = 0;
  const startMs = new Date(`${installDate}T00:00:00`).getTime();
  const endMs = new Date(`${yesterday}T00:00:00`).getTime();
  for (let t = startMs; t <= endMs; t += DAY_MS) {
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
  return {
    series,
    savingsSoFarEur: savingsSoFar,
    measuredDays,
    avgDailySavingsEur: measuredDays ? r2(savingsSoFar / measuredDays) : 0,
  };
}

// Seasonally-shaped forecast: cumulative € per day from installDate until
// the invested sum is crossed, plus ~6 months of margin. Each day's
// increment = (annualSavingsEur / 365) × monthlyDistribution[month] × 12 —
// the month's savings share relative to an average month (the distribution
// sums to 1), so a full year of increments lands on annualSavingsEur (up to
// the ≤1% day-count-vs-365/12 wobble). Also yields the break-even date.
function buildForecast(installDate, baseline, totalInvestedEur) {
  if (!baseline?.annualSavingsEur || baseline.annualSavingsEur <= 0) {
    return { forecastSeries: [], paybackDate: null, daysToPayback: null };
  }
  const dailyAvg = baseline.annualSavingsEur / 365;
  const startMs = new Date(`${installDate}T00:00:00`).getTime();
  const forecastSeries = [{ date: installDate, cumulativeEur: 0 }];
  let cum = 0;
  let paybackDate = null;
  let daysToPayback = null;
  let marginEndMs = null;
  for (let day = 1; day <= MAX_FORECAST_DAYS; day++) {
    const t = startMs + day * DAY_MS;
    const month = new Date(t).getMonth();
    cum = r2(cum + dailyAvg * baseline.monthlyDistribution[month] * 12);
    forecastSeries.push({ date: localDate(new Date(t)), cumulativeEur: cum });
    if (paybackDate == null && cum >= totalInvestedEur) {
      paybackDate = localDate(new Date(t));
      daysToPayback = day;
      marginEndMs = t + POST_PAYBACK_MONTHS * 30.44 * DAY_MS;
    }
    if (marginEndMs != null && t >= marginEndMs) break;
  }
  return { forecastSeries, paybackDate, daysToPayback };
}

async function buildRoiPayload(deps, { recomputeBaseline = false } = {}) {
  const bom = loadBom().map((r) => ({ ...r, lineTotalEur: r2(r.qty * r.unitPriceEur) }));
  // Rows flagged `excluded` stay listed but don't count toward the total.
  const totalInvestedEur = r2(bom.reduce((a, r) => a + (r.excluded ? 0 : r.lineTotalEur), 0));
  const tariff = Number(process.env.TARIFF_EUR_PER_KWH ?? 0.3);

  const meterSn = deps.getMeterSn?.() ?? getAnyDeviceSn();
  const battSn = deps.getBatterySn?.() ?? getBatterySn(meterSn);

  // installDate = first day with savings data (PV rollup or battery trend),
  // but NEVER before the panels went up: the actual return of THIS
  // investment starts Sunday 2026-09-13 — earlier battery-only days are not
  // the PV system's return and drag the measured average down (user
  // decision 2026-09-15).
  const PANELS_INSTALL_DATE = "2026-09-13";
  const candidates = [...getPvDailyDates()];
  if (battSn) candidates.push(...getStoredPeriodStarts(battSn, "day"));
  const derived = candidates.length
    ? candidates.reduce((a, b) => (a < b ? a : b))
    : FALLBACK_INSTALL_DATE;
  const installDate = derived > PANELS_INSTALL_DATE ? derived : PANELS_INSTALL_DATE;

  const measured = measuredSavings(battSn, installDate, tariff);
  const measuredHint = {
    measuredDays: measured.measuredDays,
    avgDailySavingsEur: measured.avgDailySavingsEur,
  };
  // The fixed baseline drives ALL forward-looking numbers; the measured
  // average only initializes the AI context on first compute / refresh.
  const baseline = recomputeBaseline
    ? await computeBaseline(deps, measuredHint)
    : await getBaseline(deps, measuredHint);

  const { forecastSeries, paybackDate, daysToPayback } = buildForecast(
    installDate,
    baseline,
    totalInvestedEur,
  );
  const projections = [1, 2, 3, 5, 10, 15].map((years) => {
    const cumulativeSavingsEur = r2(baseline.annualSavingsEur * years);
    return {
      years,
      cumulativeSavingsEur,
      profitEur: r2(cumulativeSavingsEur - totalInvestedEur),
    };
  });

  return {
    bom,
    totalInvestedEur,
    tariffEurPerKwh: tariff,
    installDate,
    baseline,
    savingsSoFarEur: measured.savingsSoFarEur,
    measuredDays: measured.measuredDays,
    measuredAvgDailySavingsEur: measured.avgDailySavingsEur,
    projectedAnnualSavingsEur: baseline.annualSavingsEur,
    paybackDate,
    daysToPayback,
    projections,
    series: measured.series,
    forecastSeries,
  };
}

export function registerRoiRoute(app, deps = {}) {
  // Cached product picture per ASIN; 404 answers a 1x1 transparent GIF so
  // <img> tags degrade silently when an item has no cached image.
  app.get("/api/roi/image/:asin", (req, res) => {
    const asin = String(req.params.asin).replace(/[^A-Za-z0-9]/g, "");
    const file = path.join(IMG_DIR, `${asin}.jpg`);
    if (fs.existsSync(file)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(file);
    }
    res.status(404).setHeader("Content-Type", "image/gif").send(PIXEL_GIF);
  });

  // Printable BOM (no-dep hand-rolled PDF, images embedded from roi-images/).
  app.get("/api/roi/bom.pdf", (req, res) => {
    const bom = loadBom().map((r) => ({
      ...r,
      name: r.excluded ? `${r.name} (not counted)` : r.name,
      lineTotalEur: r2(r.qty * r.unitPriceEur),
    }));
    // Rows flagged `excluded` stay listed but don't count toward the total.
    const totalInvestedEur = r2(bom.reduce((a, r) => a + (r.excluded ? 0 : r.lineTotalEur), 0));
    const snapshotDate = bom.find((r) => r.priceSnapshotDate)?.priceSnapshotDate ?? "n/a";
    const pdf = buildBomPdf({ bom, totalInvestedEur, snapshotDate });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="h0me-p0wer-bom.pdf"');
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);
  });

  app.get("/api/roi", async (req, res) => {
    try {
      res.json({ ok: true, data: await buildRoiPayload(deps) });
    } catch (err) {
      console.warn(`[roi] failed: ${err.message}`);
      res.json({ ok: false, error: "ROI data unavailable — check server logs." });
    }
  });

  // The ONLY way (besides first-time initialization) to move the "set in
  // stone" baseline: explicit user action from the ROI tab.
  app.post("/api/roi/baseline/refresh", async (req, res) => {
    try {
      res.json({ ok: true, data: await buildRoiPayload(deps, { recomputeBaseline: true }) });
    } catch (err) {
      console.warn(`[roi] baseline refresh failed: ${err.message}`);
      res.json({ ok: false, error: "Baseline recompute failed — check server logs." });
    }
  });
}
