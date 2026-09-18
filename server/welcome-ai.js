// Builds the deterministic fact base for the Welcome briefing. Everything
// here comes from local DB rows or the fetched weather/PVGIS payloads — the
// AI (welcome-ai call below) only interprets these numbers, never invents
// them.
import {
  getCloudTrend,
  getSnapshotRows,
  getFirstBatteryAfter,
  getBatteryHistory,
  integrateBatteryEnergy,
  getCloudPvDayPower,
  sumCloudEnergyInGaps,
} from "./db.js";
import { localDate } from "./welcome-sources.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const hhmm = (iso) => iso?.slice(11, 16) ?? null;

function dailyImportRows(sn, monthsBack = 2) {
  // cloud_history month rows: label = yyyy-MM-dd, import_energy per day.
  const rows = [];
  const now = new Date();
  for (let i = monthsBack; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = localDate(d).slice(0, 7);
    for (const r of getCloudTrend(sn, "month", ym).rows) {
      if (r.time && r.import_energy != null) rows.push({ date: r.time, importKwh: r.import_energy });
    }
  }
  return rows;
}

const AVG_RAD_KWH_M2 = 3.0; // rough Central-Europe yearly mean kWh/m²/day, used only to scale PVGIS monthly climatology down to a single day

// Full-day PV production PROJECTION from PVGIS monthly climatology, scaled
// by today's forecast radiation vs. the rough yearly average — an ESTIMATE
// for how much today will produce in total, not a measurement. Distinct
// from pvProducedTodayKwh (context, below), which is the real, measured
// so-far figure and can legitimately be ~0 early in the morning. Used as
// the offline fallback's todayKwh AND (2026-09-18 fix) as the basis for
// endOfDay's savings estimate: an "end of day" figure needs a projected
// FULL-DAY total, not what's been measured so far — using the so-far
// figure produced "€0 saved today" at 06:01, an hour before sunrise, right
// next to a note describing the battery about to discharge several kWh to
// the house over the rest of the day.
function projectedTodayKwh(pvgis, todayRow) {
  const month = new Date().getMonth() + 1;
  const monthKwh = pvgis?.monthly?.find((m) => m.month === month)?.kwh ?? null;
  if (monthKwh == null) return null;
  const daysInMonth = new Date(new Date().getFullYear(), month, 0).getDate();
  const radToday = todayRow?.radiationSumKwhM2 ?? AVG_RAD_KWH_M2;
  return Math.round(((monthKwh / daysInMonth) * (radToday / AVG_RAD_KWH_M2)) * 10) / 10;
}

// PV energy for a date (or day-so-far) from battery_snapshots, split per the
// validated model: produced (Σ pvW), to_home (gated pvW − chargeW through
// the inverter), to_batt (min(pvW, chargeW) into the cells). Shared by the
// daily rollup (index.js) and the welcome/ask context. See
// integrateBatteryEnergy (db.js) for the shared gap-handling policy. `produced`
// is backfilled from Anker's own cloud (site-level "solar_production" day
// trend, synced by syncCloudHistory in index.js) for any local telemetry
// gap — the cloud total-produced figure is standalone, so it's safe to
// recover; `toHome`/`toBatt` are a derived split that can't be reconstructed
// the same way and stay local-only (see AGENTS.md, 2026-09-16).
export function pvKwhForDay(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`).getTime();
  const end = start + 86400000;
  const rows = getBatteryHistory(start, end);
  const { producedKwh, toHomeKwh, toBattKwh, gaps } = integrateBatteryEnergy(rows, {
    windowStartMs: start,
    windowEndMs: Math.min(end, Date.now()),
  });
  let produced = producedKwh;
  if (gaps.length) {
    const backfillKwh = sumCloudEnergyInGaps(getCloudPvDayPower(dateStr, dateStr), gaps);
    produced = Math.round((produced + backfillKwh) * 100) / 100;
  }
  return { produced, toHome: toHomeKwh, toBatt: toBattKwh };
}

function avgImportByWeekday(rows, firstDate) {
  const cutoff = localDate(new Date(Date.now() - 56 * 86400000));
  const acc = {}; // Mon -> {s, c}
  for (const r of rows) {
    if (r.date < cutoff || r.date >= localDate()) continue; // exclude today's partial row
    if (r.date === firstDate) continue; // the linking day is always partial
    const wd = WEEKDAYS[new Date(`${r.date}T12:00:00`).getDay()];
    (acc[wd] ??= { s: 0, c: 0 }).s += r.importKwh;
    acc[wd].c++;
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, round1(v.s / v.c)]));
}

export function buildContext({ config, geo, weather, pvgis, deps }) {
  const now = new Date();
  const sn = deps.getMeterSn();
  const daily = weather.daily;
  const dayRows = daily.time.map((t, i) => ({
    date: t,
    weekday: WEEKDAYS[new Date(`${t}T12:00:00`).getDay()],
    tempMin: daily.temperature_2m_min[i],
    tempMax: daily.temperature_2m_max[i],
    weathercode: daily.weathercode[i],
    precipProbMax: daily.precipitation_probability_max[i],
    sunHours: round1((daily.sunshine_duration[i] ?? 0) / 3600),
    radiationSumKwhM2: round1(daily.shortwave_radiation_sum[i] / 3.6),
    sunrise: hhmm(daily.sunrise[i]),
    sunset: hhmm(daily.sunset[i]),
  }));

  // Today's grid import so far: trapezoid over 5 s samples (local, exact).
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  let todayImportKwh = 0;
  const rows = getSnapshotRows(dayStart.getTime(), now.getTime()).filter((r) => r.grid_total != null);
  for (let i = 1; i < rows.length; i++) {
    const dtH = (rows[i].ts - rows[i - 1].ts) / 3600000;
    if (dtH > 0.25) continue;
    todayImportKwh += (((Math.max(rows[i - 1].grid_total, 0) + Math.max(rows[i].grid_total, 0)) / 2) * dtH) / 1000;
  }

  const imports = sn ? dailyImportRows(sn) : [];
  const ym = localDate().slice(0, 7);
  // 0-import rows are 0-filled pre-link days (cloud history starts at linking,
  // 2026-09-07), not real measurements — exclude them from every average.
  // Revisit once PV exists (a legit ~0-import day is possible then).
  const realImports = imports.filter((r) => r.importKwh > 0);
  const firstDate = realImports[0]?.date ?? null; // the linking day — partial
  const fullDays = realImports.filter((r) => r.date !== firstDate);
  const mtd = fullDays.filter((r) => r.date.startsWith(ym) && r.date < localDate());
  const yearRows = sn
    ? getCloudTrend(sn, "year", String(now.getFullYear())).rows
        .map((r) => ({ label: r.time, importKwh: round1(r.import_energy) }))
        .filter((r) => r.importKwh > 0)
    : [];

  const batt = deps.getLiveBattery();
  const sunriseToday = daily.sunrise?.[0] ? new Date(daily.sunrise[0]).getTime() : dayStart.getTime();
  const sunriseBatt = getFirstBatteryAfter(sunriseToday);
  // PV went live 2026-09-13: panels are connected to the Solarbank (DC) and
  // report pv_w. "Installed" = any production seen today (night reads 0 too).
  const pvMaxToday = getBatteryHistory(dayStart.getTime(), now.getTime()).reduce(
    (m, r) => Math.max(m, r.pv_w ?? 0),
    0,
  );

  return {
    location: { address: config.address, lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
    date: localDate(),
    localTime: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    pvProducedTodayKwh: pvKwhForDay(localDate()).produced,
    pvProjectedTodayKwh: projectedTodayKwh(pvgis, dayRows[0]),
    weekday: WEEKDAYS[now.getDay()],
    monthName: MONTHS[now.getMonth()],
    tariffEurPerKwh: config.tariff,
    pvSystem: config.pv,
    sun: { sunrise: dayRows[0]?.sunrise, sunset: dayRows[0]?.sunset, sunHoursToday: dayRows[0]?.sunHours },
    today: dayRows[0] ?? null,
    week: dayRows,
    solarClimatology: pvgis,
    consumption: {
      avgImportKwhByWeekday: avgImportByWeekday(realImports, firstDate),
      avgImportKwhPerDay: fullDays.length
        ? round1(fullDays.reduce((a, r) => a + r.importKwh, 0) / fullDays.length)
        : null,
      monthToDateAvgImportKwh: mtd.length ? round1(mtd.reduce((a, r) => a + r.importKwh, 0) / mtd.length) : null,
      yearMonthlyAvgImportKwh: yearRows,
      todayImportKwhSoFar: round1(todayImportKwh),
    },
    battery: batt
      ? {
          socNow: batt.soc,
          outputW: batt.outputW,
          chargeW: batt.chargeW,
          pvNowW: batt.pvW ?? null,
          pvLiveToday: pvMaxToday > 0,
          sunriseSoc: sunriseBatt?.soc ?? null,
        }
      : { socNow: null, outputW: null, chargeW: null, pvNowW: null, pvLiveToday: pvMaxToday > 0, sunriseSoc: sunriseBatt?.soc ?? null },
    // 2026-09-17 (user request): the briefing must reflect what strategy the
    // battery is actually running under, not just current numbers — the
    // same behavior/numbers mean something different under house_priority
    // vs. battery_priority. effectiveBehavior is pre-resolved here (not
    // left for the AI to work out) because Manual silently overrides the
    // selected strategy — the exact same logic as StrategyTab's help modal,
    // duplicated in one clear sentence so the model can't get it wrong.
    strategy: buildStrategyContext(deps.getPowerPlanState?.()),
  };
}

export function buildStrategyContext(s) {
  if (!s) return null;
  let effectiveBehavior;
  if (!s.enabled) {
    effectiveBehavior = "power plan is OFF — the device runs its own static schedule, not this app's strategy logic";
  } else if (s.trigger === "manual") {
    effectiveBehavior = s.manualDischarge
      ? "MANUAL override: battery continuously discharges to the house (same shape as house_priority), REGARDLESS of the selected strategy below"
      : "MANUAL override: battery never discharges, PV passes straight through to the house (same shape as battery_priority once full), REGARDLESS of the selected strategy below";
  } else if (s.strategy === "battery_priority") {
    effectiveBehavior = "battery_priority: PV charges the battery first while it isn't full (house draws from the grid meanwhile); the battery is never discharged under this strategy";
  } else {
    effectiveBehavior = "house_priority: the battery continuously tops up the house from stored energy, down to its floor plus a safety margin";
  }
  return {
    enabled: s.enabled,
    selectedStrategy: s.strategy,
    trigger: s.trigger,
    manualDischarge: s.manualDischarge,
    effectiveBehavior,
  };
}

import { fetchJson } from "./welcome-sources.js";

// 2026-09-16 restructure (user request): the Welcome tab now groups cards
// as Today (start/right-now/end) and Week (so-far/upcoming/estimate), with
// Production/Savings folded into whichever card they narratively belong to
// instead of standing alone — see AGENTS.md. "This week so far" is
// deterministic (Dashboard's own /api/stats/overview week totals, now
// calendar-week-aligned), not part of this schema.
export const WELCOME_SCHEMA = {
  name: "welcome",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["greeting", "today", "production", "endOfDay", "week", "month"],
    properties: {
      greeting: { type: "string" },
      today: {
        type: "object", additionalProperties: false, required: ["summary", "icon", "statusQuo"],
        properties: {
          summary: { type: "string" },
          icon: { type: "string", enum: ["sun", "cloud-sun", "cloud", "rain", "snow"] },
          statusQuo: { type: "string" },
        },
      },
      production: {
        type: "object", additionalProperties: false,
        required: ["todayKwh", "weekKwh", "monthKwh", "reasoning"],
        properties: {
          todayKwh: { type: "number" }, weekKwh: { type: "number" }, monthKwh: { type: "number" },
          reasoning: { type: "string" },
        },
      },
      endOfDay: {
        type: "object", additionalProperties: false,
        required: ["batterySocEstimate", "toHouseKwh", "toBatteryKwh", "gridExportKwh", "estimatedSavingsEur", "note"],
        properties: {
          batterySocEstimate: { type: "number" }, toHouseKwh: { type: "number" },
          toBatteryKwh: { type: "number" }, gridExportKwh: { type: "number" },
          estimatedSavingsEur: { type: "number" }, note: { type: "string" },
        },
      },
      week: {
        type: "object", additionalProperties: false,
        required: ["upcoming", "estimate", "estimateKwh", "estimateEur"],
        properties: {
          upcoming: { type: "string" }, estimate: { type: "string" },
          estimateKwh: { type: "number" }, estimateEur: { type: "number" },
        },
      },
      month: { type: "object", additionalProperties: false, required: ["statement"], properties: { statement: { type: "string" } } },
    },
  },
};

const SYSTEM_PROMPT = `You write the energy briefing for a home dashboard.
Hard rules:
- Use ONLY the numbers in the provided JSON context for weather, sun and consumption facts. Never invent figures.
- Adapt to the provided localTime: morning (before 12:00) = the day ahead; afternoon (12-18) = the day so far (pvProducedTodayKwh, grid import so far) + what remains of it; evening (after 18:00) = wrap up the day and look at tomorrow (the week's first forecast day after today).
- PV status is data-driven: if battery.pvLiveToday is true, the PV system IS INSTALLED — production.todayKwh MUST equal pvProducedTodayKwh from the context EXACTLY, even if it is 0 or very small (e.g. before sunrise, or a heavily overcast morning). NEVER substitute a climatology projection for it just because it looks more informative — a real 0 is correct and more honest than an estimate mislabeled as measured. Explain a low/zero value in production.reasoning ("before sunrise", "overcast so far") instead of replacing the number. Otherwise (PV not yet live) production.todayKwh is a genuine estimate — use pvProjectedTodayKwh from the context directly, it's already computed from the PVGIS climatology for this exact setup scaled by today's forecast radiation. production.weekKwh/monthKwh are ALWAYS forward-looking climatology projections, live or not — pvProducedTodayKwh only constrains todayKwh specifically.
- Power flows (Solarbank 2 E1600 Plus, built-in inverter): ALL PV enters the battery unit; the house is fed ONLY through the unit's inverter, and the inverter's output already includes any PV pass-through — never present PV as flowing directly to the house. The bank decides dynamically (at low SOC it often charges from PV while the house runs on grid) — describe the MEASURED flows in the context, don't assume a fixed priority.
- today.statusQuo: ONE or TWO lively sentences that read like a snapshot of THIS EXACT MOMENT — battery.socNow, battery.pvNowW, battery.outputW/chargeW from the context. Present tense ("the battery is at…", "right now the panels are…"), not a forecast and not a recap of the whole day.
- week.upcoming: look ONLY at the forecast days in "week" that are still AHEAD (today and earlier are already in the past) — what the weather means for production/consumption over what's left of the calendar week. Reference specific upcoming weekdays when the forecast is notably better or worse than the rest.
- week.estimate/estimateKwh/estimateEur: a projection for how the REST of the CALENDAR week (through Sunday) will likely turn out — production total and rough savings — consistent with production.weekKwh and tariffEurPerKwh. This is a forward-looking estimate, not a summary of days already past (that's a separate, deterministic card the app builds itself).
- strategy.effectiveBehavior describes what the battery is ACTUALLY doing right now — it can differ from what the strategy name alone implies (e.g. a Manual override). Ground statusQuo, endOfDay, and week.upcoming/estimate in it: if the effective behavior says the battery never discharges, don't predict it topping up the house tonight or over the week — describe the grid covering that demand instead; if it says the battery continuously discharges, reflect that as the ongoing pattern, not a one-off.
- endOfDay projects the FULL day's outcome, not just what's already happened — base toHouseKwh/toBatteryKwh/batterySocEstimate on pvProjectedTodayKwh (today's expected total production) combined with the consumption averages, not on pvProducedTodayKwh alone (that's just what's measured so far and can be ~0 early in the day even on a day that will produce plenty).
- Estimates (production, end-of-day battery, savings, week) must be consistent with the context: consumption averages, battery SOC, tariff.
- Currency: EUR. Language for all prose: see language field. Every statement ≤ 3 sentences, plain and friendly — statusQuo can be shorter/punchier, it's a quick glance, not a report.`;

function validateAiResponse(j) {
  for (const k of WELCOME_SCHEMA.schema.required) if (!(k in j)) throw new Error(`AI reply missing "${k}"`);
  if (!WELCOME_SCHEMA.schema.properties.today.properties.icon.enum.includes(j.today?.icon)) {
    throw new Error(`AI reply bad icon "${j.today?.icon}"`);
  }
  return j;
}

export async function callWelcomeAI(config, context) {
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
  // The endpoint's latency varies wildly (seen: instant … >30 s). Refresh is
  // non-blocking/background, so a generous 60 s timeout is free. The abort is
  // transient — retry with json_schema again before degrading to json_object
  // (which the model often answers off-schema).
  for (const format of [
    { type: "json_schema", json_schema: WELCOME_SCHEMA },
    { type: "json_schema", json_schema: WELCOME_SCHEMA },
    { type: "json_object" },
  ]) {
    try {
      const j = await fetchJson(url, { timeoutMs: 60000, headers, method: "POST", body: JSON.stringify(body(format)) });
      return validateAiResponse(JSON.parse(j.choices[0].message.content));
    } catch (err) {
      console.warn(`[welcome] AI attempt failed (${err.message})`);
    }
  }
  throw new Error("all AI attempts failed");
}

// --- "Right now" mini-refresh (2026-09-17, user request) -------------------
// The full briefing only refreshes every 2 h (fixed slots) — too slow for a
// card that's meant to read as "this exact moment." Rather than run the
// WHOLE pipeline (geocode/weather/PVGIS/full schema) more often, this is a
// small, separate, dedicated AI call — just the live battery numbers in,
// one sentence out — cheap enough to refresh lazily whenever a request
// finds it more than 30 min old (see welcome.js's refreshStatusQuoIfStale).

const STATUS_QUO_SCHEMA = {
  name: "welcome_status_quo",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["statusQuo"],
    properties: { statusQuo: { type: "string" } },
  },
};

const STATUS_QUO_SYSTEM_PROMPT = `Write ONE or TWO lively sentences describing THIS EXACT MOMENT for a home solar+battery dashboard's "Right now" card.
Hard rules:
- Use ONLY battery.socNow/pvNowW/outputW/chargeW and strategy.effectiveBehavior from the context. Never invent numbers.
- Present tense ("the battery is at…", "right now the panels are…") — a snapshot, not a forecast or a recap.
- Ground it in strategy.effectiveBehavior: if the battery never discharges under the active behavior, don't describe it feeding the house even if outputW briefly reads nonzero (sensor noise) — describe what's actually happening (charging, idle, or passthrough).
- Plain, friendly, short — this is a quick glance, not a report. Language: see language field.`;

export function fallbackStatusQuo(context) {
  return context.battery?.socNow != null
    ? `Battery at ${context.battery.socNow}% right now, panels making ${context.battery.pvNowW ?? 0} W.`
    : "Live battery status isn't available right now.";
}

export async function callStatusQuoAI(config, context) {
  const user = JSON.stringify({ language: config.ai.language, ...context });
  const body = (responseFormat) => ({
    model: config.ai.model,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: STATUS_QUO_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    response_format: responseFormat,
  });
  const url = `${config.ai.baseUrl}/chat/completions`;
  const headers = { Authorization: `Bearer ${config.ai.apiKey}`, "Content-Type": "application/json" };
  for (const format of [
    { type: "json_schema", json_schema: STATUS_QUO_SCHEMA },
    { type: "json_object" },
  ]) {
    try {
      const j = await fetchJson(url, { timeoutMs: 20000, headers, method: "POST", body: JSON.stringify(body(format)) });
      const parsed = JSON.parse(j.choices[0].message.content);
      if (typeof parsed.statusQuo === "string" && parsed.statusQuo) return parsed.statusQuo;
    } catch (err) {
      console.warn(`[welcome] status-quo AI attempt failed (${err.message})`);
    }
  }
  return fallbackStatusQuo(context);
}

// Deterministic stand-in when the AI is unreachable: same response shape,
// numbers prorated from PVGIS by today's forecast radiation vs. the month's
// average, template prose instead of AI prose.
export function buildFallback(config, context) {
  const month = new Date().getMonth() + 1;
  const monthKwh = context.solarClimatology?.monthly?.find((m) => m.month === month)?.kwh ?? null;
  const daysInMonth = new Date(new Date().getFullYear(), month, 0).getDate();
  const todayKwh = context.pvProjectedTodayKwh ?? projectedTodayKwh(context.solarClimatology, context.today);
  const weekKwh = monthKwh != null
    ? Math.round(context.week.reduce((a, d) => a + ((monthKwh / daysInMonth) * ((d.radiationSumKwhM2 ?? AVG_RAD_KWH_M2) / AVG_RAD_KWH_M2)), 0) * 10) / 10
    : null;
  const icon = context.today == null ? "cloud" : context.today.weathercode < 2 ? "sun" : context.today.weathercode < 60 ? "cloud-sun" : context.today.weathercode < 80 ? "cloud" : "rain";
  const todayEur = todayKwh != null ? Math.round(todayKwh * context.tariffEurPerKwh * 100) / 100 : 0;
  const weekEur = weekKwh != null ? Math.round(weekKwh * context.tariffEurPerKwh * 100) / 100 : 0;
  const statusQuo = fallbackStatusQuo(context);
  return {
    greeting: `Welcome! ${context.weekday}, ${context.date} — sunrise ${context.sun.sunrise}, sunset ${context.sun.sunset}.`,
    today: {
      summary: `Between ${context.today?.tempMin ?? "?"}°C and ${context.today?.tempMax ?? "?"}°C, about ${context.sun.sunHoursToday ?? "?"} h of sunshine.`,
      icon,
      statusQuo,
    },
    production: { todayKwh, weekKwh, monthKwh, reasoning: "Prorated from PVGIS monthly average by forecast radiation (offline estimate)." },
    endOfDay: {
      batterySocEstimate: context.battery.socNow ?? 0,
      toHouseKwh: context.consumption.monthToDateAvgImportKwh ?? 0,
      toBatteryKwh: 0, gridExportKwh: 0,
      estimatedSavingsEur: todayEur,
      note: "Offline estimate — based on your average consumption; the PV system is still planned.",
    },
    week: {
      upcoming: `Sunshine between ${Math.min(...context.week.map((d) => d.sunHours ?? 0))} h and ${Math.max(...context.week.map((d) => d.sunHours ?? 0))} h per day this week.`,
      estimate: `Typical week for your setup: ~${weekKwh ?? "?"} kWh (PVGIS climatology).`,
      estimateKwh: weekKwh ?? 0,
      estimateEur: weekEur,
    },
    month: { statement: `Typical ${context.monthName} production for your setup: ~${monthKwh ?? "?"} kWh (PVGIS climatology).` },
  };
}

// --- Voice Q&A (/api/ask): correct the STT transcript + answer with context --

const ASK_SCHEMA = {
  name: "ask",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["correctedQuestion", "answer"],
    properties: {
      correctedQuestion: { type: "string" },
      answer: { type: "string" },
    },
  },
};

const ASK_SYSTEM_PROMPT = `You are the voice assistant of a home-energy dashboard.
The user's question comes from speech recognition and may contain transcription
errors: first recover the intended question (correctedQuestion), then answer it.
Hard rules:
- Answer ONLY from the provided JSON context (location, weather, consumption,
  battery, PV estimates, live power, tariff). Never invent figures.
- Keep it SHORT: at most 2-3 plain sentences, strictly on the question's
  subject. No background, no extra context unless asked.
- Scope: home energy only (power, grid, battery, solar/PV, weather for the
  home, costs). If the question is about anything else, or the context has no
  data to answer it, say honestly that you don't know or can't answer that —
  do NOT guess and do NOT answer off-topic questions.
- The context carries the current localTime — interpret "now", "today",
  "tonight", "this morning" against it.
- PV status is data-driven: if battery.pvLiveToday is true, the PV system IS INSTALLED and produced today (use the actual figures) — otherwise it is PLANNED and production numbers are PVGIS-based estimates. Power-flow priority: PV covers the house FIRST, surplus to the battery, grid last.
- Spoken-style language (the answer is read aloud), numbers rounded sensibly.
  Language for both fields: see language field.`;

export async function callAskAI(config, context, question) {
  const user = JSON.stringify({ language: config.ai.language, question, ...context });
  const body = (responseFormat) => ({
    model: config.ai.model,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: ASK_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    response_format: responseFormat,
  });
  const url = `${config.ai.baseUrl}/chat/completions`;
  const headers = { Authorization: `Bearer ${config.ai.apiKey}`, "Content-Type": "application/json" };
  const parse = (j) => {
    const r = JSON.parse(j.choices[0].message.content);
    for (const k of ASK_SCHEMA.schema.required) {
      if (typeof r[k] !== "string" || !r[k]) throw new Error(`AI reply missing "${k}"`);
    }
    return r;
  };
  try {
    const j = await fetchJson(url, { timeoutMs: 30000, headers, method: "POST", body: JSON.stringify(body({ type: "json_schema", json_schema: ASK_SCHEMA })) });
    return parse(j);
  } catch (err) {
    console.warn(`[ask] structured AI call failed (${err.message}) — retrying with json_object`);
    const j = await fetchJson(url, { timeoutMs: 30000, headers, method: "POST", body: JSON.stringify(body({ type: "json_object" })) });
    return parse(j);
  }
}
