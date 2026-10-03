import { buildContext } from "./welcome-ai.js";
import {
  parseWelcomeConfig,
  geocode,
  fetchWeather,
  fetchPvgis,
  fetchJson,
  localDate,
  LANG_NAMES,
  isWelcomeLang,
} from "./welcome-sources.js";
import { kvGet, kvSet, computeConsumptionProfile } from "./db.js";

// AI day briefing for the simple view's first section (2026-10-03, user
// request): ONE AI message generated at the beginning of the day and kept
// for the whole day — greeting, forecasted weather (with emojis),
// forecasted production for the installed capacity, and the expected house
// consumption split (grid / battery / expected end-of-day SOC). Cached in
// kv per (language, date) — the key IS the date, so it can never refresh
// mid-day. The deterministic numbers (production forecast from PVGIS,
// house estimate from the 56-day consumption profile) are server-computed
// and override whatever the AI proposes — the model only narrates and does
// the grid/battery split reasoning ("AI narrates, server computes", the
// same pattern as welcome.js's overrides).

const DAYBRIEF_SCHEMA = {
  name: "day_brief",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["greeting", "weatherText", "usage", "note"],
    properties: {
      greeting: { type: "string" },
      weatherText: { type: "string" },
      usage: {
        type: "object",
        additionalProperties: false,
        required: ["houseKwh", "gridKwh", "batteryKwh", "batteryEndPct"],
        properties: {
          houseKwh: { type: "number" },
          gridKwh: { type: "number" },
          batteryKwh: { type: "number" },
          batteryEndPct: { type: "number" },
        },
      },
      note: { type: "string" },
    },
  },
};

const DAYBRIEF_SYSTEM_PROMPT = `You write the ONCE-PER-DAY morning briefing for a home solar+battery dashboard (simple view, first section). Answer in the language given by the language field.

You get a context JSON with: today's weather forecast (today: tempMin/tempMax/weathercode (WMO code)/precipProbMax/sunHours/radiationSumKwhM2/sunrise/sunset), pvSystem (peakKwp/panelCount/panelW — the INSTALLED capacity, real and present), pvProjectedTodayKwh (the server's production forecast for today), battery (socNow, capacityKwh), strategy.effectiveBehavior (how the system actually runs today), and consumption estimates.

Produce:
- greeting: ONE short friendly sentence (hello + today's date/weekday flavor). Match the time of day from context.localTime (morning before noon, afternoon, evening) — the briefing is normally generated at day start, but a late first request must not say "good morning" at night. No numbers.
- weatherText: ONE plain-text sentence about today's weather. NO emojis, NO icons — the UI renders its own abstract glyph from the weathercode. Use the WMO weathercode (0-1 clear, 2-3 cloudy, 45/48 fog, 51-67 rain, 71-77 snow, 80-82 showers, 95+ thunder). Include min/max temperatures.
- usage: your best estimate of TODAY's total house consumption split:
  - houseKwh: total the house will use today. If context.houseEstimateKwh is set, use it EXACTLY (it comes from the measured 56-day consumption profile). Otherwise estimate from the consumption averages and lastSameWeekday.
  - gridKwh / batteryKwh: how the house demand will be covered. PV covers the house directly while the sun shines (from pvProjectedTodayKwh), surplus charges the battery, the battery discharges in the evening/night down to its floor, the grid covers the rest. gridKwh + batteryKwh MUST sum to houseKwh (PV-direct is inside this split too — count PV-direct-to-house as part of batteryKwh ONLY if it round-trips the battery; PV used directly by the house belongs to NEITHER grid nor battery-from-storage: in that case put it in gridKwh's complement by reducing gridKwh — the sum rule is what matters).
  - batteryEndPct: expected battery state of charge at end of day (0-100), starting from battery.socNow and the day's expected charge/discharge. Respect strategy.effectiveBehavior (e.g. under "never discharge" the battery only gains).
- note: ONE practical sentence for the day (e.g. "run the dishwasher around noon").

Be concise. Numbers rounded to 1 decimal (percentages whole).`;

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

// Deterministic fallback when the AI is unreachable — same shape.
function buildDayBriefFallback(context, houseEstimateKwh) {
  const w = context.today ?? {};
  const code = w.weathercode ?? 0;
  const house = houseEstimateKwh ?? context.consumption?.avgImportKwhPerDay ?? null;
  const pv = context.pvProjectedTodayKwh ?? 0;
  const grid = house != null ? Math.max(0, round1(house - pv)) : null;
  return {
    greeting: "Good morning!",
    weatherText: `${w.tempMin ?? "—"}–${w.tempMax ?? "—"} °C today.`,
    usage: {
      houseKwh: house,
      gridKwh: grid,
      batteryKwh: house != null && grid != null ? round1(Math.max(0, house - grid - pv) + Math.min(house, pv)) : null,
      batteryEndPct: context.battery?.socNow ?? null,
    },
    note: "Estimates are offline fallback values.",
  };
}

// House-consumption estimate from the 56-day usual-consumption profile
// (the same profile behind the flow diagram's "usual ≈ N W"): today's
// weekday cells preferred, all-days average as fallback. Sum of per-hour
// average watts over 24 h = Wh/day.
function houseEstimateFromProfile() {
  const p = kvGet("consumption_profile_v1")?.value ?? computeConsumptionProfile(56);
  if (!p || (p.daysUsed ?? 0) < 5) return null;
  const cells = p.cells?.[new Date().getDay()] ?? p.cellsAny;
  if (!cells) return null;
  const hours = Object.values(cells);
  if (hours.length < 20) return null;
  const wh = hours.reduce((a, w) => a + w, 0); // avg W per hour → Wh per covered hour
  return round1((wh / 1000) * (24 / hours.length)); // scale partial coverage to 24 h
}

async function callDayBriefAI(config, context, lang) {
  const user = JSON.stringify({ language: LANG_NAMES[lang] ?? lang, ...context });
  const body = (responseFormat) => ({
    model: config.ai.model,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: DAYBRIEF_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    response_format: responseFormat,
  });
  const url = `${config.ai.baseUrl}/chat/completions`;
  const headers = { Authorization: `Bearer ${config.ai.apiKey}`, "Content-Type": "application/json" };
  // Same retry ladder as welcome (json_schema → json_schema → json_object).
  for (const format of [
    { type: "json_schema", json_schema: DAYBRIEF_SCHEMA },
    { type: "json_schema", json_schema: DAYBRIEF_SCHEMA },
    { type: "json_object" },
  ]) {
    try {
      const j = await fetchJson(url, { timeoutMs: 60000, headers, method: "POST", body: JSON.stringify(body(format)) });
      const parsed = JSON.parse(j.choices[0].message.content);
      if (
        typeof parsed.greeting === "string" &&
        typeof parsed.weatherText === "string" &&
        parsed.usage &&
        typeof parsed.note === "string"
      ) {
        return parsed;
      }
    } catch (err) {
      console.warn(`[daybrief] AI attempt failed (${err.message})`);
    }
  }
  throw new Error("all AI attempts failed");
}

export function registerDayBriefRoute(app, deps) {
  const inflights = new Map(); // `${lang}:${date}` -> Promise

  async function generate(config, lang) {
    const geo = await geocode(config.address);
    const [weather, pvgis, statsOverview] = await Promise.all([
      fetchWeather(geo.lat, geo.lon),
      fetchPvgis(geo.lat, geo.lon, config.pv),
      fetchJson(deps.statsOverviewUrl).catch(() => null),
    ]);
    const context = buildContext({ config, geo, weather, pvgis, statsOverview, deps });
    const houseEstimateKwh = houseEstimateFromProfile();
    const capacityKwh = deps.getLiveBattery() ? (deps.getCapacityKwh?.() ?? null) : null;
    const aiContext = {
      ...context,
      houseEstimateKwh,
      battery: { ...context.battery, capacityKwh },
    };
    let ai;
    let aiPowered = Boolean(config.ai.apiKey);
    if (aiPowered) {
      try {
        ai = await callDayBriefAI(config, aiContext, lang);
      } catch (err) {
        console.warn(`[daybrief] AI call failed (${err.message}) — deterministic fallback`);
        ai = buildDayBriefFallback(aiContext, houseEstimateKwh);
        aiPowered = false;
      }
    } else {
      ai = buildDayBriefFallback(aiContext, houseEstimateKwh);
    }
    // Server-owned numbers, never the model's (same backstop philosophy as
    // welcome.js's production override): the production forecast is PVGIS
    // arithmetic, the house total is the measured consumption profile.
    const houseKwh = houseEstimateKwh ?? round1(ai.usage?.houseKwh);
    let gridKwh = Math.max(0, ai.usage?.gridKwh ?? 0);
    let batteryKwh = Math.max(0, ai.usage?.batteryKwh ?? 0);
    // The split must sum to the house total — normalize if the model's
    // arithmetic drifted (up to 5% tolerance before correcting).
    if (houseKwh != null && houseKwh > 0) {
      const sum = gridKwh + batteryKwh;
      if (sum <= 0 || Math.abs(sum - houseKwh) / houseKwh > 0.05) {
        if (sum > 0) {
          gridKwh = (gridKwh / sum) * houseKwh;
          batteryKwh = (batteryKwh / sum) * houseKwh;
        } else {
          gridKwh = houseKwh;
          batteryKwh = 0;
        }
      }
    }
    const batteryEndPct = Math.min(100, Math.max(0, Math.round(ai.usage?.batteryEndPct ?? context.battery?.socNow ?? 0)));
    return {
      greeting: ai.greeting,
      // Defensive strip (2026-10-03): the prompt asks for plain text, but a
      // pictograph that slips through would break the spartan glyph style.
      weatherText: (ai.weatherText ?? "")
        .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
      weatherCode: context.today?.weathercode ?? null,
      forecastPvKwh: context.pvProjectedTodayKwh ?? null,
      peakKwp: config.pv.peakKwp,
      usage: {
        houseKwh,
        gridKwh: round1(gridKwh),
        batteryKwh: round1(batteryKwh),
        batteryEndPct,
      },
      note: ai.note,
      aiPowered,
      date: localDate(),
      generatedAt: new Date().toISOString(),
    };
  }

  function generateOnce(config, lang, key) {
    if (!inflights.has(key)) {
      inflights.set(
        key,
        generate(config, lang)
          .then((payload) => {
            // Fallback payloads (AI down) are NOT cached — the next request
            // retries the AI instead of being stuck with the stand-in all day.
            if (payload.aiPowered) kvSet(key, payload);
            return payload;
          })
          .finally(() => inflights.delete(key)),
      );
    }
    return inflights.get(key);
  }

  // Beginning-of-day generation for the DEFAULT language (other languages
  // generate lazily on first request — same pattern as welcome.js). From
  // 05:00 on, if today's briefing doesn't exist yet, create it.
  function ensureTodaysBriefing() {
    const now = new Date();
    if (now.getHours() < 5) return;
    let config;
    try {
      config = parseWelcomeConfig();
    } catch {
      return;
    }
    if (!config?.ai?.apiKey) return;
    const key = `daybrief:${config.ai.language}:${localDate()}`;
    if (!kvGet(key)) {
      generateOnce(config, config.ai.language, key).catch((err) =>
        console.warn(`[daybrief] scheduled generation failed: ${err.message}`),
      );
    }
  }
  setTimeout(ensureTodaysBriefing, 60 * 1000).unref();
  setInterval(ensureTodaysBriefing, 60 * 1000).unref();

  app.get("/api/daybrief", async (req, res) => {
    let config;
    try {
      config = parseWelcomeConfig();
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
    if (!config) {
      return res.json({ ok: false, error: "HOME_ADDRESS not set in .env." });
    }
    const lang = req.query.lang ?? config.ai.language;
    if (!isWelcomeLang(lang)) {
      return res.json({ ok: false, error: `Unsupported lang "${req.query.lang}" — use one of en, de, ro.` });
    }
    const key = `daybrief:${lang}:${localDate()}`;
    const cached = kvGet(key);
    if (cached) return res.json({ ok: true, data: cached.value });
    try {
      // Cold start (first request of the day in this language): wait once.
      const payload = await generateOnce(config, lang, key);
      return res.json({ ok: true, data: payload });
    } catch (err) {
      return res.json({ ok: false, error: String(err.message ?? err) });
    }
  });
}
