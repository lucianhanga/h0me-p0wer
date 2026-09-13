// Builds the deterministic fact base for the Welcome briefing. Everything
// here comes from local DB rows or the fetched weather/PVGIS payloads — the
// AI (welcome-ai call below) only interprets these numbers, never invents
// them.
import { getCloudTrend, getSnapshotRows, getFirstBatteryAfter } from "./db.js";
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

  return {
    location: { address: config.address, lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
    date: localDate(),
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
      ? { socNow: batt.soc, outputW: batt.outputW, chargeW: batt.chargeW, sunriseSoc: sunriseBatt?.soc ?? null }
      : { socNow: null, outputW: null, chargeW: null, sunriseSoc: sunriseBatt?.soc ?? null },
  };
}

import { fetchJson } from "./welcome-sources.js";

export const WELCOME_SCHEMA = {
  name: "welcome",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["greeting", "today", "week", "month", "production", "endOfDay", "savings"],
    properties: {
      greeting: { type: "string" },
      today: {
        type: "object", additionalProperties: false, required: ["summary", "icon"],
        properties: {
          summary: { type: "string" },
          icon: { type: "string", enum: ["sun", "cloud-sun", "cloud", "rain", "snow"] },
        },
      },
      week: { type: "object", additionalProperties: false, required: ["statement"], properties: { statement: { type: "string" } } },
      month: { type: "object", additionalProperties: false, required: ["statement"], properties: { statement: { type: "string" } } },
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
        required: ["batterySocEstimate", "toHouseKwh", "toBatteryKwh", "gridExportKwh", "note"],
        properties: {
          batterySocEstimate: { type: "number" }, toHouseKwh: { type: "number" },
          toBatteryKwh: { type: "number" }, gridExportKwh: { type: "number" }, note: { type: "string" },
        },
      },
      savings: {
        type: "object", additionalProperties: false, required: ["todayEur", "monthEur", "note"],
        properties: { todayEur: { type: "number" }, monthEur: { type: "number" }, note: { type: "string" } },
      },
    },
  },
};

const SYSTEM_PROMPT = `You write the morning energy briefing for a home dashboard.
Hard rules:
- Use ONLY the numbers in the provided JSON context for weather, sun and consumption facts. Never invent figures.
- The PV system is PLANNED, not installed: production numbers are estimates from the PVGIS climatology for this exact setup, scaled by today's and the week's forecast radiation vs. the monthly average.
- Power-flow priority (Self-Consumption mode with a smart meter, per the storage manual): PV power FIRST covers the home's current consumption; only the SURPLUS charges the battery; export to the grid happens last. Compare estimated PV output with the home's baseline consumption (consumption averages / 24 h): with a small PV system and a high baseline, most PV power goes DIRECTLY to the house and little reaches the battery — never claim the opposite.
- Estimates (production, end-of-day battery, savings) must be consistent with the context: consumption averages, battery SOC, tariff.
- Currency: EUR. Language for all prose: see language field. Every statement ≤ 3 sentences, plain and friendly.`;

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
  try {
    const j = await fetchJson(url, { timeoutMs: 30000, headers, method: "POST", body: JSON.stringify(body({ type: "json_schema", json_schema: WELCOME_SCHEMA })) });
    return validateAiResponse(JSON.parse(j.choices[0].message.content));
  } catch (err) {
    console.warn(`[welcome] structured AI call failed (${err.message}) — retrying with json_object`);
    const j = await fetchJson(url, { timeoutMs: 30000, headers, method: "POST", body: JSON.stringify(body({ type: "json_object" })) });
    return validateAiResponse(JSON.parse(j.choices[0].message.content));
  }
}

// Deterministic stand-in when the AI is unreachable: same response shape,
// numbers prorated from PVGIS by today's forecast radiation vs. the month's
// average, template prose instead of AI prose.
export function buildFallback(config, context) {
  const month = new Date().getMonth() + 1;
  const monthKwh = context.solarClimatology?.monthly?.find((m) => m.month === month)?.kwh ?? null;
  const daysInMonth = new Date(new Date().getFullYear(), month, 0).getDate();
  const avgRad = 3.0; // rough Central-Europe yearly mean kWh/m²/day, used only to scale
  const radToday = context.today?.radiationSumKwhM2 ?? avgRad;
  const todayKwh = monthKwh != null ? Math.round(((monthKwh / daysInMonth) * (radToday / avgRad)) * 10) / 10 : null;
  const weekKwh = monthKwh != null
    ? Math.round(context.week.reduce((a, d) => a + ((monthKwh / daysInMonth) * ((d.radiationSumKwhM2 ?? avgRad) / avgRad)), 0) * 10) / 10
    : null;
  const icon = context.today == null ? "cloud" : context.today.weathercode < 2 ? "sun" : context.today.weathercode < 60 ? "cloud-sun" : context.today.weathercode < 80 ? "cloud" : "rain";
  return {
    greeting: `Welcome! ${context.weekday}, ${context.date} — sunrise ${context.sun.sunrise}, sunset ${context.sun.sunset}.`,
    today: { summary: `Between ${context.today?.tempMin ?? "?"}°C and ${context.today?.tempMax ?? "?"}°C, about ${context.sun.sunHoursToday ?? "?"} h of sunshine.`, icon },
    week: { statement: `Sunshine between ${Math.min(...context.week.map((d) => d.sunHours ?? 0))} h and ${Math.max(...context.week.map((d) => d.sunHours ?? 0))} h per day this week.` },
    month: { statement: `Typical ${context.monthName} production for your setup: ~${monthKwh ?? "?"} kWh (PVGIS climatology).` },
    production: { todayKwh, weekKwh, monthKwh, reasoning: "Prorated from PVGIS monthly average by forecast radiation (offline estimate)." },
    endOfDay: {
      batterySocEstimate: context.battery.socNow ?? 0,
      toHouseKwh: context.consumption.monthToDateAvgImportKwh ?? 0,
      toBatteryKwh: 0, gridExportKwh: 0,
      note: "Offline estimate — based on your average consumption; the PV system is still planned.",
    },
    savings: {
      todayEur: todayKwh != null ? Math.round(todayKwh * context.tariffEurPerKwh * 100) / 100 : 0,
      monthEur: monthKwh != null ? Math.round(monthKwh * context.tariffEurPerKwh * 100) / 100 : 0,
      note: `At ${context.tariffEurPerKwh} €/kWh, assuming full self-consumption.`,
    },
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
- The PV system is PLANNED, not installed: production numbers are PVGIS-based
  estimates. Power-flow priority: PV covers the house FIRST, surplus to the
  battery, grid last.
- Plain spoken-style language (the answer may be read aloud), ≤ 6 sentences,
  numbers rounded sensibly. Language for both fields: see language field.`;

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
