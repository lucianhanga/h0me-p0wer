// ROI baseline: ONE conservative estimate of the expected average daily
// savings, computed once (AI-assisted) and persisted in the kv store. It is
// the fixed basis for payback/projections/forecast — it must NOT drift with
// the noisy measured average. Recomputed only on first initialization or an
// explicit POST /api/roi/baseline/refresh — never on a schedule.
import { kvGet, kvSet, getCloudTrendMulti, getAnyDeviceSn, getMeterSns } from "./db.js";
import {
  parseWelcomeConfig,
  geocode,
  fetchPvgis,
  fetchJson,
  localDate,
} from "./welcome-sources.js";
import { savedEur } from "./savings.js";
import { getTariff } from "./env.js";
import { resolveConstants, systemCapacityKwh } from "./battery-params.js";

const KV_KEY = "roi_baseline";
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

// Last-resort climatology when HOME_ADDRESS/PVGIS is unavailable: Munich-ish
// annual yield for 1 kWp and a typical Central-Europe monthly shape.
const FALLBACK_YEARLY_KWH_PER_KWP = 1048;
const FALLBACK_MONTHLY_SHARE = [0.03, 0.05, 0.09, 0.12, 0.13, 0.13, 0.13, 0.11, 0.09, 0.06, 0.03, 0.03];

const BASELINE_SCHEMA = {
  name: "roi_baseline",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["annualPvKwh", "selfConsumptionRatio", "annualSavingsEur", "monthlyDistribution", "reasoning"],
    properties: {
      annualPvKwh: { type: "number" },
      selfConsumptionRatio: { type: "number" },
      annualSavingsEur: { type: "number" },
      monthlyDistribution: {
        type: "array",
        items: { type: "number" },
        minItems: 12,
        maxItems: 12,
      },
      reasoning: { type: "string" },
    },
  },
};

const SYSTEM_PROMPT = `You estimate the EXPECTED yearly electricity savings of a home solar + battery setup for an ROI payback model. The result becomes a FIXED planning baseline — be CONSERVATIVE: slightly low is better than optimistic.
Inputs in the JSON context: PV system specs (peakKwp, panelCount, panelW), PVGIS climatology (monthly + yearly kWh for this exact setup, already including 14% system loss), the grid tariff, the household's measured average grid import, the battery, and a short noisy window of measured savings.
Hard rules:
- annualPvKwh must NOT exceed the PVGIS yearly figure — that is the climatological ceiling for this setup; stay at or below it (shading, soiling, downtime).
- The PVGIS climatology was computed for the EXACT system described by pvSystem (peakKwp × panelCount) — use it AS-IS. NEVER re-scale it by panel count, nameplate guesses, or assumptions about "typical" balcony systems.
- selfConsumptionRatio: share of PV energy the household actually uses instead of buying from the grid (direct use + battery discharge). The inverter ENFORCES zero export, but production beyond what the house plus battery can absorb at any moment is curtailed and lost. Judge it from the numbers in the context: compare the PVGIS yearly yield against the annual consumption (avgImportKwhPerDay × 365) and the battery capacity. A system whose production is well below the baseload can stay near 1.0; a system producing far above consumption needs a clearly lower ratio. Stay inside 0.3–0.95.
- annualSavingsEur must equal annualPvKwh × selfConsumptionRatio × tariffEurPerKwh.
- monthlyDistribution: 12 shares (January…December) of the ANNUAL SAVINGS, summing to 1. It roughly follows PV production but slightly flatter (winter PV is almost fully self-consumed; summer surplus above consumption+battery is lost).
- reasoning: 1-2 plain sentences.
- The measured savings window is short and noisy — use it only as a weak sanity signal, never as the basis.`;

// Average daily grid import from the cloud month rows (same source as the
// welcome context): last 2 months + current, 0-filled pre-link days and the
// partial linking/current day excluded.
function avgDailyImportKwh(sns) {
  const snList = (Array.isArray(sns) ? sns : [sns]).filter(Boolean);
  if (!snList.length) return null;
  const now = new Date();
  const today = localDate();
  const rows = [];
  for (let i = 2; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = localDate(d).slice(0, 7);
    // Meter swap continuity (2026-09-27): merge across meter SNs.
    for (const r of getCloudTrendMulti(snList, "month", ym).rows) {
      if (r.time && r.import_energy > 0 && r.time < today) {
        rows.push({ date: r.time, kwh: r.import_energy });
      }
    }
  }
  if (!rows.length) return null;
  const firstDate = rows[0].date; // linking day — always partial
  const full = rows.filter((r) => r.date !== firstDate);
  if (!full.length) return null;
  return Math.round((full.reduce((a, r) => a + r.kwh, 0) / full.length) * 10) / 10;
}

// Human-readable battery description for the AI context, built from the
// LIVE system (dock era: multi-unit aggregate with per-unit members) instead
// of a hardcoded string — a static description went stale after every
// hardware change (Plus→Pro swap, SB4 + 2× BP5000) and misled the AI's
// self-consumption-ratio judgment.
function describeBattery(live) {
  const members = (live?.members ?? []).filter((m) => m?.sn);
  if (!members.length) return "Anker Solarbank home battery system (capacity unknown)";
  const total = systemCapacityKwh(live);
  const parts = members.map((m) => {
    const c = resolveConstants(m.pn, m.expansionPacks ?? 0);
    return `${c.product} (${c.capacityKwh} kWh${c.expansionPacks > 0 ? ` incl. ${c.expansionPacks} expansion pack(s)` : ""}, AC out ≤ ${c.maxAcOutputW} W)`;
  });
  return `${total} kWh total home battery across ${members.length} solarbanks: ${parts.join("; ")}`;
}

async function callBaselineAI(config, context) {
  const user = JSON.stringify({ language: config.ai.language, ...context });
  const body = (responseFormat) => ({
    model: config.ai.model,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    response_format: responseFormat,
  });
  const url = `${config.ai.baseUrl}/chat/completions`;
  const headers = { Authorization: `Bearer ${config.ai.apiKey}`, "Content-Type": "application/json" };
  for (const format of [
    { type: "json_schema", json_schema: BASELINE_SCHEMA },
    { type: "json_schema", json_schema: BASELINE_SCHEMA },
    { type: "json_object" },
  ]) {
    try {
      const j = await fetchJson(url, { timeoutMs: 60000, headers, method: "POST", body: JSON.stringify(body(format)) });
      return JSON.parse(j.choices[0].message.content);
    } catch (err) {
      console.warn(`[roi-baseline] AI attempt failed (${err.message})`);
    }
  }
  throw new Error("all AI attempts failed");
}

// Validate + clamp the AI (or fallback) estimate into the persisted shape.
// annualSavingsEur is ALWAYS derived deterministically
// (annualPvKwh × ratio × tariff) so the three numbers can never disagree.
function validateEstimate(est, pvgisYearlyKwh, tariff) {
  let annualPvKwh = Number(est.annualPvKwh);
  if (!(annualPvKwh > 0) || annualPvKwh > 100000) {
    throw new Error(`implausible annualPvKwh ${est.annualPvKwh}`);
  }
  if (pvgisYearlyKwh != null) annualPvKwh = Math.min(annualPvKwh, pvgisYearlyKwh);
  const selfConsumptionRatio = Math.min(1.0, Math.max(0.3, Number(est.selfConsumptionRatio) || 1.0));
  const dist = (Array.isArray(est.monthlyDistribution) ? est.monthlyDistribution : [])
    .slice(0, 12)
    .map((v) => Math.max(0, Number(v) || 0));
  if (dist.length !== 12 || dist.reduce((a, b) => a + b, 0) <= 0) {
    throw new Error("bad monthlyDistribution");
  }
  const sum = dist.reduce((a, b) => a + b, 0);
  const monthlyDistribution = dist.map((v) => r4(v / sum));
  // Fix normalization rounding on the largest month so the sum is exactly 1.
  const drift = r4(1 - monthlyDistribution.reduce((a, b) => a + b, 0));
  const maxIdx = monthlyDistribution.indexOf(Math.max(...monthlyDistribution));
  monthlyDistribution[maxIdx] = r4(monthlyDistribution[maxIdx] + drift);
  // Uses the same canonical kWh×tariff arithmetic as everywhere else
  // (savings.js) — the ratio here is a deliberate, documented exception
  // (a deployment-time derate for a structural reason, e.g. an
  // undersized battery), not a different formula.
  const annualSavingsEur = savedEur(annualPvKwh * selfConsumptionRatio, tariff);
  return {
    annualPvKwh: r2(annualPvKwh),
    selfConsumptionRatio,
    annualSavingsEur,
    monthlyDistribution,
    avgDailySavingsEur: r2(annualSavingsEur / 365),
    reasoning: String(est.reasoning ?? "").slice(0, 500),
  };
}

// Deterministic estimate without the AI: PVGIS annual yield, 100%
// self-consumption (zero-export setup — everything produced is used on
// site), monthly shape from the PVGIS monthly averages.
function fallbackEstimate(config, pvgis) {
  const yearlyKwh = pvgis?.yearlyKwh ?? FALLBACK_YEARLY_KWH_PER_KWP * (config?.pv.peakKwp ?? 1);
  const monthly = pvgis?.monthly?.length === 12
    ? pvgis.monthly.map((m) => m.kwh)
    : FALLBACK_MONTHLY_SHARE.map((s) => s * yearlyKwh);
  return {
    annualPvKwh: yearlyKwh,
    selfConsumptionRatio: 1.0,
    monthlyDistribution: monthly,
    reasoning: "PVGIS climatology for this setup, 100% self-consumption (zero-export, AI unavailable).",
  };
}

export async function computeBaseline(deps = {}, measured = null) {
  const config = parseWelcomeConfig(); // null when HOME_ADDRESS is unset
  const tariff = config?.tariff ?? getTariff();
  let pvgis = null;
  if (config) {
    try {
      const geo = await geocode(config.address);
      pvgis = await fetchPvgis(geo.lat, geo.lon, config.pv);
    } catch (err) {
      console.warn(`[roi-baseline] PVGIS unavailable (${err.message}) — built-in climatology fallback`);
    }
  }
  const context = config
    ? {
        pvSystem: config.pv,
        battery: describeBattery(deps.getLiveBattery?.()),
        pvgisClimatology: pvgis,
        tariffEurPerKwh: tariff,
        consumption: {
          avgImportKwhPerDay: avgDailyImportKwh(deps.getMeterSns?.() ?? [deps.getMeterSn?.() ?? getAnyDeviceSn()]),
        },
        measuredSavings: measured && measured.measuredDays > 0
          ? { days: measured.measuredDays, avgDailySavingsEur: measured.avgDailySavingsEur, note: "short noisy window — weak signal only" }
          : null,
      }
    : null;
  let est = null;
  let source = "pvgis-fallback";
  if (context?.pvgisClimatology && config.ai.apiKey) {
    try {
      est = await callBaselineAI(config, context);
      source = "ai";
    } catch (err) {
      console.warn(`[roi-baseline] AI failed (${err.message}) — PVGIS fallback`);
    }
  }
  if (!est) est = fallbackEstimate(config, pvgis);
  const baseline = {
    ...validateEstimate(est, pvgis?.yearlyKwh ?? null, tariff),
    source,
    tariff,
    createdAt: new Date().toISOString(),
  };
  kvSet(KV_KEY, baseline);
  console.log(
    `[roi-baseline] set: €${baseline.avgDailySavingsEur}/day (€${baseline.annualSavingsEur}/yr, ${baseline.annualPvKwh} kWh @ ${baseline.selfConsumptionRatio}, ${source})`,
  );
  return baseline;
}

// The fixed basis for all ROI math. First call initializes it; afterwards it
// NEVER changes on its own — only POST /api/roi/baseline/refresh recomputes.
export async function getBaseline(deps = {}, measured = null) {
  const hit = kvGet(KV_KEY);
  if (hit?.value?.avgDailySavingsEur != null) return hit.value;
  return computeBaseline(deps, measured);
}
