// Orchestrates the Welcome briefing: deterministic data gathering (cached
// per TTL), ONE structured AI call, stale-on-error, deterministic fallback
// when the AI is unavailable. A background scheduler keeps the cache warm so
// opening the tab never waits for the AI; the route's lazy refresh is only
// the fallback. The route never throws and never leaks config.
import { kvGet, kvSet } from "./db.js";
import {
  parseWelcomeConfig, geocode, fetchWeather, fetchPvgis,
} from "./welcome-sources.js";
import { buildContext, callWelcomeAI, buildFallback, callAskAI } from "./welcome-ai.js";

const AI_TTL_MS = 6 * 3600 * 1000; // max 4 AI calls/day
// Fallback payloads self-heal: retry the AI after 15 min instead of letting
// one outage block AI briefings for the full 6 h TTL.
const FALLBACK_TTL_MS = 15 * 60 * 1000;
const CACHE_KEY = "welcome:latest";
// How often the scheduler checks staleness (a no-op while the cache is fresh).
const SCHEDULER_TICK_MS = 10 * 60 * 1000;
// Post-startup delay before the first scheduled refresh — lets the meter and
// battery syncs produce data for the start-of-day snapshot.
const STARTUP_DELAY_MS = 45 * 1000;

export function registerWelcomeRoute(app, deps) {
  let inflight = null; // dedupe concurrent refreshes (route + scheduler)

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

  function ttlFor(cached) {
    return cached?.value?.aiPowered === false ? FALLBACK_TTL_MS : AI_TTL_MS;
  }

  function freshCache() {
    const cached = kvGet(CACHE_KEY);
    return cached && Date.now() - cached.fetchedAt < ttlFor(cached) ? cached : null;
  }

  // Refresh only when the cache is missing or past its TTL. Shared by the
  // scheduler and the route; failures leave any old cache in place.
  async function refreshIfStale(config) {
    if (freshCache()) return;
    inflight ??= refresh(config).finally(() => (inflight = null));
    await inflight;
  }

  function loadConfig() {
    try {
      return parseWelcomeConfig();
    } catch {
      return null; // misconfiguration — the route reports it, scheduler stays quiet
    }
  }

  // Background scheduler: keeps the briefing warm with the same TTL budget
  // (≤ 4 AI calls/day). unref'd so it never blocks shutdown.
  setTimeout(() => {
    const config = loadConfig();
    if (!config) return;
    refreshIfStale(config).catch((err) => console.warn(`[welcome] scheduled refresh failed: ${err.message}`));
  }, STARTUP_DELAY_MS).unref();
  setInterval(() => {
    const config = loadConfig();
    if (!config) return;
    refreshIfStale(config).catch((err) => console.warn(`[welcome] scheduled refresh failed: ${err.message}`));
  }, SCHEDULER_TICK_MS).unref();

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
    const fresh = freshCache();
    if (fresh) return res.json({ ok: true, data: fresh.value });
    const cached = kvGet(CACHE_KEY);
    try {
      await refreshIfStale(config);
      return res.json({ ok: true, data: kvGet(CACHE_KEY).value });
    } catch (err) {
      console.warn(`[welcome] refresh failed: ${err.message}`);
      if (cached) return res.json({ ok: true, data: { ...cached.value, stale: true } });
      // Cold start, AI down: deterministic fallback still needs weather; if
      // THAT is what failed, there is nothing sensible to show. Generic
      // message only — err.message can embed the home address / coordinates.
      return res.json({ ok: false, error: "Welcome data unavailable — check server logs." });
    }
  });

  // Voice Q&A: the browser STT transcript is corrected AND answered in one
  // structured AI call, fed with the full context (location, weather, PV
  // climatology, consumption, battery) plus live grid power.
  app.post("/api/ask", async (req, res) => {
    const question = String(req.body?.question ?? "").slice(0, 1000).trim();
    if (!question) return res.json({ ok: false, error: "Empty question." });
    let config;
    try {
      config = parseWelcomeConfig();
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
    if (!config) {
      return res.json({ ok: false, error: "Welcome tab not configured (HOME_ADDRESS missing)." });
    }
    if (!config.ai.apiKey) {
      return res.json({ ok: false, error: "No AI configured (AI_API_KEY missing)." });
    }
    try {
      const geo = await geocode(config.address);
      const [weather, pvgis] = await Promise.all([
        fetchWeather(geo.lat, geo.lon),
        fetchPvgis(geo.lat, geo.lon, config.pv),
      ]);
      const context = buildContext({ config, geo, weather, pvgis, deps });
      const live = {
        liveGridW: deps.getLivePower?.() ?? null,
        liveBattery: context.battery,
      };
      const answer = await callAskAI(config, { ...context, live }, question);
      return res.json({ ok: true, data: answer });
    } catch (err) {
      console.warn(`[ask] failed: ${err.message}`);
      return res.json({ ok: false, error: "Couldn't get an answer right now — try again in a moment." });
    }
  });
  // Manual refresh (tab's refresh button): regenerates immediately, bypassing
  // the TTL — the 6h budget governs the scheduler; this is user-initiated.
  app.post("/api/welcome/refresh", async (req, res) => {
    let config;
    try {
      config = parseWelcomeConfig();
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
    if (!config) {
      return res.json({ ok: false, error: "HOME_ADDRESS not set in .env — Welcome tab not configured." });
    }
    try {
      inflight ??= refresh(config).finally(() => (inflight = null));
      return res.json({ ok: true, data: await inflight });
    } catch (err) {
      console.warn(`[welcome] manual refresh failed: ${err.message}`);
      const cached = kvGet(CACHE_KEY);
      if (cached) return res.json({ ok: true, data: { ...cached.value, stale: true } });
      return res.json({ ok: false, error: "Welcome data unavailable — check server logs." });
    }
  });
}
