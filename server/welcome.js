// Orchestrates the Welcome briefing: deterministic data gathering (cached
// per TTL), ONE structured AI call, stale-on-error, deterministic fallback
// when the AI is unavailable. The route never throws and never leaks config.
import { kvGet, kvSet } from "./db.js";
import {
  parseWelcomeConfig, geocode, fetchWeather, fetchPvgis,
} from "./welcome-sources.js";
import { buildContext, callWelcomeAI, buildFallback } from "./welcome-ai.js";

const AI_TTL_MS = 6 * 3600 * 1000; // max 4 AI calls/day
const CACHE_KEY = "welcome:latest";

export function registerWelcomeRoute(app, deps) {
  let inflight = null; // dedupe concurrent refreshes

  async function refresh(config) {
    const geo = await geocode(config.address);
    const [weather, pvgis] = await Promise.all([
      fetchWeather(geo.lat, geo.lon),
      fetchPvgis(geo.lat, geo.lon, config.pv),
    ]);
    const context = buildContext({ config, geo, weather, pvgis, deps });
    let ai;
    let aiPowered = Boolean(config.ai.apiKey);
    if (aiPowered) {
      try {
        ai = await callWelcomeAI(config, context);
      } catch (err) {
        console.warn(`[welcome] AI call failed (${err.message}) — deterministic fallback`);
        ai = buildFallback(config, context);
        aiPowered = false;
      }
    } else {
      ai = buildFallback(config, context);
    }
    const payload = {
      ...ai,
      aiPowered,
      generatedAt: new Date().toISOString(),
      stale: false,
      // Ground truth owned by the server — never by the model.
      groundTruth: {
        sunrise: context.sun.sunrise,
        sunset: context.sun.sunset,
        sunHoursToday: context.sun.sunHoursToday,
        tempMin: context.today?.tempMin ?? null,
        tempMax: context.today?.tempMax ?? null,
        week: context.week,
      },
      startOfDay: {
        sunrise: context.sun.sunrise,
        batterySoc: context.battery.sunriseSoc,
        gridImportKwhSoFar: context.consumption.todayImportKwhSoFar,
      },
    };
    kvSet(CACHE_KEY, payload);
    return payload;
  }

  app.get("/api/welcome", async (req, res) => {
    let config;
    try {
      config = parseWelcomeConfig();
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
    if (!config) {
      return res.json({ ok: false, error: "HOME_ADDRESS not set in .env — Welcome tab not configured." });
    }
    const cached = kvGet(CACHE_KEY);
    // Fallback payloads self-heal: retry the AI after 15 min instead of
    // letting one outage block AI briefings for the full 6 h TTL.
    const ttl = cached?.value?.aiPowered === false ? 15 * 60 * 1000 : AI_TTL_MS;
    if (cached && Date.now() - cached.fetchedAt < ttl) {
      return res.json({ ok: true, data: cached.value });
    }
    try {
      inflight ??= refresh(config).finally(() => (inflight = null));
      return res.json({ ok: true, data: await inflight });
    } catch (err) {
      console.warn(`[welcome] refresh failed: ${err.message}`);
      if (cached) return res.json({ ok: true, data: { ...cached.value, stale: true } });
      // Cold start, AI down: deterministic fallback still needs weather; if
      // THAT is what failed, there is nothing sensible to show. Generic
      // message only — err.message can embed the home address / coordinates.
      return res.json({ ok: false, error: "Welcome data unavailable — check server logs." });
    }
  });
}
