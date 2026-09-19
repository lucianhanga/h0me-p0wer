import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAnyDeviceSn,
  getBatterySn,
  getPvDaily,
  getPvDailyDates,
  getStoredPeriodStarts,
  kvGet,
  kvSet,
} from "./db.js";
import { buildBomPdf } from "./roi-pdf.js";
import { getBaseline, computeBaseline } from "./roi-baseline.js";
import { parseWelcomeConfig, fetchJson } from "./welcome-sources.js";
import { savedEur } from "./savings.js";
import { dayBattery } from "./energy-day.js";
import { getTariff } from "./env.js";

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

// Battery cells discharge kWh for one date — see energy-day.js's
// dayBattery(). The trend is ALREADY cells-only (verified numerically in
// the dashboard channel audit: cloud 0.41 ≈ local cells 0.34, NOT the
// inverter output), so it never overlaps the PV channel — do NOT subtract
// pvToHome here.
function cellsKwhForDay(battSn, dateStr) {
  const { dischargedKwh, hasRows } = dayBattery(battSn, dateStr);
  return { cellsKwh: dischargedKwh, hasRows };
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
    const row = pvByDate.get(date);
    // pvKwh/battKwh stay as the physical to-home/cells flow (informational
    // — where the energy actually went); the € figure is production-based
    // (savings.js, 2026-09-17 fix — was to-home+cells here too, which
    // undercounts a day that mostly charged the battery for later).
    const pvToHomeKwh = row?.to_home ?? 0;
    const producedKwh = row?.produced ?? 0;
    const { cellsKwh, hasRows } = cellsKwhForDay(battSn, date);
    if (pvByDate.has(date) || hasRows) measuredDays++;
    const dayEur = savedEur(producedKwh, tariff) ?? 0;
    savingsSoFar = r2(savingsSoFar + dayEur);
    series.push({
      date,
      pvKwh: r2(pvToHomeKwh),
      battKwh: r2(cellsKwh),
      savedEur: dayEur,
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

// "Possible outcome": a rolling forecast (2026-09-16, user request — see
// AGENTS.md; industry term confirmed via research) that continues from the
// LAST MEASURED point (not from 0, so the chart line is continuous) using
// the baseline's seasonal SHAPE scaled by how the system has actually
// performed so far. This is deliberately separate from buildForecast()'s
// flat baseline-from-day-1 line: the baseline object itself stays fixed
// (see roi-baseline.js's "must not drift" note) — only this DERIVED
// quantity blends it with the current trend. performanceRatio = measured
// savings so far ÷ what the baseline alone would have predicted for the
// same days (the PV-monitoring "Performance Ratio" concept, expressed
// against this system's own seasonal baseline rather than a physical
// irradiance model, since that's the reference this app already has).
function buildOutlook(installDate, baseline, measured, totalInvestedEur) {
  if (!baseline?.annualSavingsEur || baseline.annualSavingsEur <= 0) {
    return {
      performanceRatio: null,
      baselineSoFarEur: 0,
      outlookSeries: [],
      outlookPaybackDate: null,
      daysToOutlookPayback: null,
    };
  }
  const dailyAvg = baseline.annualSavingsEur / 365;
  const startMs = new Date(`${installDate}T00:00:00`).getTime();
  const measuredDays = measured.series.length;

  // What the baseline ALONE would have predicted for the same measured
  // period — the denominator for "ahead of or behind plan."
  let baselineSoFar = 0;
  for (let day = 1; day <= measuredDays; day++) {
    const t = startMs + day * DAY_MS;
    const month = new Date(t).getMonth();
    baselineSoFar = r2(baselineSoFar + dailyAvg * baseline.monthlyDistribution[month] * 12);
  }
  // Don't over-fit a short/noisy window (research finding): the ratio is
  // still exact math, but callers should treat it as a weak signal while
  // measuredDays is small — same caveat roi-baseline.js already applies.
  const performanceRatio = baselineSoFar > 0 ? r2(measured.savingsSoFarEur / baselineSoFar) : null;
  const ratio = performanceRatio ?? 1;

  const lastDate = measuredDays ? measured.series[measuredDays - 1].date : installDate;
  const lastMs = new Date(`${lastDate}T00:00:00`).getTime();
  const lastCum = measured.savingsSoFarEur;
  const outlookSeries = [{ date: lastDate, cumulativeEur: lastCum }];
  let cum = lastCum;
  let outlookPaybackDate = lastCum >= totalInvestedEur ? lastDate : null;
  let daysToOutlookPayback = outlookPaybackDate ? measuredDays : null;
  let marginEndMs = outlookPaybackDate ? lastMs + POST_PAYBACK_MONTHS * 30.44 * DAY_MS : null;
  for (let day = 1; day <= MAX_FORECAST_DAYS; day++) {
    const t = lastMs + day * DAY_MS;
    const month = new Date(t).getMonth();
    cum = r2(cum + dailyAvg * baseline.monthlyDistribution[month] * 12 * ratio);
    outlookSeries.push({ date: localDate(new Date(t)), cumulativeEur: cum });
    if (outlookPaybackDate == null && cum >= totalInvestedEur) {
      outlookPaybackDate = localDate(new Date(t));
      daysToOutlookPayback = measuredDays + day;
      marginEndMs = t + POST_PAYBACK_MONTHS * 30.44 * DAY_MS;
    }
    if (marginEndMs != null && t >= marginEndMs) break;
  }
  return { performanceRatio, baselineSoFarEur: baselineSoFar, outlookSeries, outlookPaybackDate, daysToOutlookPayback };
}

// One-line AI interpretation of the tracking numbers above — the AI only
// narrates server-computed figures (same pattern as welcome-ai.js /
// roi-baseline.js's `reasoning`), never invents them. Cached once per day
// (keyed by the measured window's last date, which only changes once daily)
// so this doesn't trigger an AI call on every 5-min poll.
const OUTLOOK_NOTE_KEY = "roi_outlook_note";

const OUTLOOK_NOTE_SCHEMA = {
  name: "roi_outlook_note",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["note"],
    properties: { note: { type: "string" } },
  },
};

const OUTLOOK_NOTE_SYSTEM_PROMPT = `You write a ONE-to-TWO sentence "tracking" note for a home solar ROI dashboard, comparing MEASURED savings so far against a FIXED seasonal baseline for the same period.
Hard rules:
- Use ONLY the numbers given in the context. Never invent figures.
- performanceRatioPct: measured ÷ baseline-predicted for the same days, as a percentage — over 100 means ahead of the seasonal plan, under 100 means behind it.
- If measuredDays is small (under ~14), explicitly caveat that it's an early/short read, not a confirmed trend — do not overstate confidence.
- Interpret, don't just restate the numbers verbatim — but only mention a specific cause (season, weather, a habit change) if it's plausible from the data given; otherwise keep it general.
- Plain, friendly, ≤2 sentences. Currency EUR. Language: see language field.`;

function fallbackOutlookNote(ctx) {
  if (ctx.performanceRatioPct == null) return "Not enough measured days yet to compare against the baseline.";
  const dir = ctx.performanceRatioPct >= 100 ? "ahead of" : "behind";
  return `Currently tracking ${ctx.performanceRatioPct}% of the seasonal baseline — ${dir} plan.`;
}

async function computeOutlookNote(config, ctx) {
  if (!config?.ai?.apiKey) return fallbackOutlookNote(ctx);
  const user = JSON.stringify({ language: config.ai.language, ...ctx });
  const body = (responseFormat) => ({
    model: config.ai.model,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: OUTLOOK_NOTE_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    response_format: responseFormat,
  });
  const url = `${config.ai.baseUrl}/chat/completions`;
  const headers = { Authorization: `Bearer ${config.ai.apiKey}`, "Content-Type": "application/json" };
  for (const format of [
    { type: "json_schema", json_schema: OUTLOOK_NOTE_SCHEMA },
    { type: "json_object" },
  ]) {
    try {
      const j = await fetchJson(url, {
        timeoutMs: 20000,
        headers,
        method: "POST",
        body: JSON.stringify(body(format)),
      });
      const parsed = JSON.parse(j.choices[0].message.content);
      if (typeof parsed.note === "string" && parsed.note) return parsed.note;
    } catch (err) {
      console.warn(`[roi] outlook note AI attempt failed (${err.message})`);
    }
  }
  return fallbackOutlookNote(ctx);
}

async function getOutlookNote(lastDate, ctx) {
  const hit = kvGet(OUTLOOK_NOTE_KEY);
  if (hit?.value?.forDate === lastDate) return hit.value.note;
  let config = null;
  try {
    config = parseWelcomeConfig();
  } catch {
    /* misconfigured — fall through to the deterministic note */
  }
  const note = await computeOutlookNote(config, ctx);
  kvSet(OUTLOOK_NOTE_KEY, { forDate: lastDate, note });
  return note;
}

async function buildRoiPayload(deps, { recomputeBaseline = false } = {}) {
  const bom = loadBom().map((r) => ({ ...r, lineTotalEur: r2(r.qty * r.unitPriceEur) }));
  // Rows flagged `excluded` stay listed but don't count toward the total.
  const totalInvestedEur = r2(bom.reduce((a, r) => a + (r.excluded ? 0 : r.lineTotalEur), 0));
  const tariff = getTariff();

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

  // forecastSeries/paybackDate: the ORIGINAL flat baseline-from-day-1 plan
  // — still computed (used as the "baseline plan" comparison date), but no
  // longer the chart's primary line; see buildOutlook for the trend-adjusted
  // "possible outcome" that continues from what's actually been measured.
  const { forecastSeries, paybackDate, daysToPayback } = buildForecast(
    installDate,
    baseline,
    totalInvestedEur,
  );
  const outlook = buildOutlook(installDate, baseline, measured, totalInvestedEur);
  const performanceRatioPct =
    outlook.performanceRatio != null ? Math.round(outlook.performanceRatio * 100) : null;
  const lastMeasuredDate = measured.series.length
    ? measured.series[measured.series.length - 1].date
    : installDate;
  const outlookNote = await getOutlookNote(lastMeasuredDate, {
    performanceRatioPct,
    measuredDays: measured.measuredDays,
    savingsSoFarEur: measured.savingsSoFarEur,
    baselineSoFarEur: outlook.baselineSoFarEur,
    baselinePaybackDate: paybackDate,
    outlookPaybackDate: outlook.outlookPaybackDate,
  });
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
    performanceRatioPct,
    outlookPaybackDate: outlook.outlookPaybackDate,
    daysToOutlookPayback: outlook.daysToOutlookPayback,
    outlookNote,
    projections,
    series: measured.series,
    forecastSeries,
    outlookSeries: outlook.outlookSeries,
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
