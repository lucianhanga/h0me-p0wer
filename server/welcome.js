// Orchestrates the Welcome briefing: deterministic data gathering (cached
// per TTL), ONE structured AI call, stale-on-error, deterministic fallback
// when the AI is unavailable. A background scheduler keeps the cache warm so
// opening the tab never waits for the AI; the route's lazy refresh is only
// the fallback. The route never throws and never leaks config.
import { kvGet, kvSet } from "./db.js";
import {
  parseWelcomeConfig, geocode, fetchWeather, fetchPvgis, fetchJson,
} from "./welcome-sources.js";
import {
  buildContext,
  callWelcomeAI,
  buildFallback,
  callAskAI,
  callStatusQuoAI,
  fallbackStatusQuo,
  buildStrategyContext,
} from "./welcome-ai.js";
import { savedEur } from "./savings.js";

// Fixed briefing times (local clock): every 2 h from 6:00 to 22:00 — 9 AI
// calls/day, each updated with the day's actuals so far. Stale = cache older
// than the most recent slot boundary (handles restarts naturally).
const SLOTS_H = [6, 8, 10, 12, 14, 16, 18, 20, 22];
function lastSlotMs(now = new Date()) {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  for (let i = SLOTS_H.length - 1; i >= 0; i--) {
    d.setHours(SLOTS_H[i]);
    if (d.getTime() <= now.getTime()) return d.getTime();
  }
  d.setHours(SLOTS_H[SLOTS_H.length - 1]);
  return d.getTime() - 86400000; // before 6:00 → yesterday's 22:00
}
// Fallback payloads self-heal: retry the AI after 15 min instead of letting
// one outage block AI briefings until the next slot.
const FALLBACK_TTL_MS = 15 * 60 * 1000;
const CACHE_KEY = "welcome:latest";
// "Right now" (today.statusQuo) refreshes independently of the main 2h
// slots (2026-09-17, user request) — lazily, whenever a GET request finds
// it older than this, not on its own background timer (user: "update it
// schedule based... when an app is requesting it and if its older than 30
// minutes, update it again").
const STATUS_QUO_TTL_MS = 30 * 60 * 1000;
// How often the scheduler checks staleness (a no-op while the cache is fresh).
const SCHEDULER_TICK_MS = 60 * 1000;
// Post-startup delay before the first scheduled refresh — lets the meter and
// battery syncs produce data for the start-of-day snapshot.
const STARTUP_DELAY_MS = 45 * 1000;

export function registerWelcomeRoute(app, deps) {
  let inflight = null; // dedupe concurrent refreshes (route + scheduler)

  async function refresh(config) {
    const geo = await geocode(config.address);
    const [weather, pvgis, statsOverview] = await Promise.all([
      fetchWeather(geo.lat, geo.lon),
      fetchPvgis(geo.lat, geo.lon, config.pv),
      // Best-effort: an internal loopback call, same process — should
      // basically never fail independently of the whole server being
      // down, but a transient hiccup shouldn't block the whole briefing.
      fetchJson(deps.statsOverviewUrl)
        .catch((err) => {
          console.warn(`[welcome] stats-overview fetch failed (${err.message})`);
          return null;
        }),
    ]);
    const context = buildContext({ config, geo, weather, pvgis, statsOverview, deps });
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
      // production.todayKwh/weekKwh/monthKwh: hard backstop, regardless of
      // prompt compliance (2026-09-18 fix — real incident: the AI
      // substituted a full-day PVGIS projection, 3.7 kWh, for the actual
      // measured so-far value at 06:01, an hour before sunrise, when the
      // true figure was ~0 — displayed as "measured" on the Right now
      // card, which was wrong). weekKwh/monthKwh get the SAME treatment
      // (2026-09-18, second fix same day): both are Dashboard's own real,
      // already-computed week/month-to-date production (statsOverview,
      // fetched once in welcome.js and threaded through context — see
      // buildContext's comment) rather than a second, independent AI/PVGIS
      // estimate that could disagree with what Dashboard shows for the
      // exact same numbers. Falls back to the AI's own value only if the
      // internal stats fetch itself failed (statsOverview null) — better a
      // possibly-stale AI guess than a blank field.
      // UNCONDITIONAL as of 2026-09-19 — previously gated on
      // battery.pvLiveToday (`pvMaxToday > 0`, i.e. "has today itself
      // produced anything yet"), which is TRUE INSTALLATION STATUS'S WRONG
      // PROXY: the system has been permanently installed since 2026-09-13,
      // but that check went false every single day before the first sun of
      // the morning — real incident: a 06:01 generation, before sunrise,
      // had the AI describe the system as "not yet live" and substitute a
      // PVGIS projection for todayKwh, exactly the bug the FIRST fix this
      // week was meant to close, just via a different door. The system is
      // always installed — these three NUMBERS are never left to the
      // model, period; only the narration (reasoning) is.
      production: {
        ...ai.production,
        todayKwh: context.pvProducedTodayKwh,
        weekKwh: context.pvProducedWeekToDateKwh ?? ai.production?.weekKwh,
        monthKwh: context.pvProducedMonthToDateKwh ?? ai.production?.monthKwh,
      },
      // endOfDay.estimatedSavingsEur: derived from THIS SAME CARD's own
      // toHouseKwh (2026-09-18, second fix same week — user: "it cannot
      // be only this if you estimate [2.9 kWh to the house]" — €0.17
      // sat next to "house ≈ 2.9 kWh" because the two numbers came from
      // completely disconnected calculations: toHouseKwh is the AI's own
      // forward estimate, while estimatedSavingsEur was independently
      // derived from pvProjectedTodayKwh — a full-day PRODUCTION
      // projection with no guaranteed relationship to toHouseKwh at all.
      // Unlike Dashboard/ROI/Yesterday (real, HISTORICAL measurements,
      // where production-based accounting matters so today/yesterday/
      // week/month don't double-count or drift against each other —
      // see savings.js), this card is a single forward-looking GUESS with
      // no other card it needs to reconcile against once the day is over
      // — the REAL, measured, production-based figure appears elsewhere
      // once today becomes yesterday. Internal coherence with the number
      // shown right next to it matters more here than matching a
      // philosophy built for reconciling separate historical cards.
      endOfDay: {
        ...ai.endOfDay,
        estimatedSavingsEur: savedEur(ai.endOfDay?.toHouseKwh, config.tariff),
      },
      // Was previously based on ai.production?.weekKwh — already a latent
      // mismatch (production.weekKwh answers "how much so far", not "how
      // much through Sunday"), now definitely wrong since weekKwh is
      // overridden to the real to-date figure above. week.estimateKwh is
      // the field the AI actually uses for the forward "through Sunday"
      // projection (see SYSTEM_PROMPT) — that's the correct basis here.
      week: { ...ai.week, estimateEur: savedEur(ai.week?.estimateKwh, config.tariff) },
      // A full refresh naturally refreshes statusQuo too — timestamp it so
      // the lazy 30-min mini-refresh below knows it doesn't need to.
      today: { ...ai.today, statusQuoUpdatedAt: new Date().toISOString() },
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
        // For the Weather tile's radiation line (2026-09-19, user
        // request) — shown directly, not left to the AI's prose, since
        // it's a single clean number already in context.today.
        radiationSumKwhM2Today: context.today?.radiationSumKwhM2 ?? null,
        week: context.week,
      },
      // Sunrise-bounded, NOT "so far"/until now — see buildContext's
      // comment on gridImportKwhUntilSunrise/battDischargeKwhUntilSunrise
      // (2026-09-19 fix: "How the day started" was showing the wrong
      // window, todayImportKwhSoFar, which keeps growing all day instead
      // of describing the period the card's own name refers to).
      startOfDay: {
        sunrise: context.sun.sunrise,
        batterySoc: context.battery.sunriseSoc,
        gridImportKwhUntilSunrise: context.consumption.gridImportKwhUntilSunrise,
        battDischargeKwhUntilSunrise: context.consumption.battDischargeKwhUntilSunrise,
      },
    };
    kvSet(CACHE_KEY, payload);
    return payload;
  }

  function freshCache() {
    const cached = kvGet(CACHE_KEY);
    if (!cached) return null;
    // Fresh = generated at/after the most recent briefing slot; a fallback
    // payload additionally expires after 15 min so the AI self-heals sooner.
    if (cached.fetchedAt < lastSlotMs()) return null;
    if (cached.value?.aiPowered === false && Date.now() - cached.fetchedAt > FALLBACK_TTL_MS) return null;
    return cached;
  }

  // Refresh only when the cache is missing or past its TTL. Shared by the
  // scheduler and the route; failures leave any old cache in place.
  async function refreshIfStale(config) {
    if (freshCache()) return;
    inflight ??= refresh(config).finally(() => (inflight = null));
    await inflight;
  }

  // Lightweight "Right now" mini-refresh — see welcome-ai.js's
  // callStatusQuoAI for why this is separate from the main briefing.
  // Merges into whatever's cached rather than replacing it; a no-op if
  // there's nothing cached yet (the main refresh will produce the first
  // statusQuo on its own).
  let statusQuoInflight = null;
  async function refreshStatusQuo(config) {
    const cached = kvGet(CACHE_KEY);
    if (!cached?.value) return;
    const batt = deps.getLiveBattery?.() ?? null;
    const context = {
      battery: batt
        ? { socNow: batt.soc, outputW: batt.outputW, chargeW: batt.chargeW, pvNowW: batt.pvW ?? null }
        : { socNow: null, outputW: null, chargeW: null, pvNowW: null },
      strategy: buildStrategyContext(deps.getPowerPlanState?.()),
      language: config.ai.language,
    };
    const statusQuo = config.ai.apiKey
      ? await callStatusQuoAI(config, context)
      : fallbackStatusQuo(context);
    kvSet(CACHE_KEY, {
      ...cached.value,
      today: { ...cached.value.today, statusQuo, statusQuoUpdatedAt: new Date().toISOString() },
    });
  }

  function statusQuoStale() {
    const cached = kvGet(CACHE_KEY);
    if (!cached?.value) return false; // nothing to refresh into yet
    const updatedAt = cached.value.today?.statusQuoUpdatedAt;
    if (!updatedAt) return true; // pre-existing cache from before this field existed
    return Date.now() - new Date(updatedAt).getTime() > STATUS_QUO_TTL_MS;
  }

  // Fire-and-forget, same "never make the client wait" philosophy as the
  // main refresh — only called when the MAIN payload is otherwise fresh
  // (a full refresh already updates statusQuo, so triggering both at once
  // would just be two concurrent AI calls for the same field).
  function refreshStatusQuoIfStale(config) {
    if (!statusQuoStale()) return;
    statusQuoInflight ??= refreshStatusQuo(config)
      .catch((err) => console.warn(`[welcome] status-quo refresh failed: ${err.message}`))
      .finally(() => (statusQuoInflight = null));
  }

  function loadConfig() {
    try {
      return parseWelcomeConfig();
    } catch {
      return null; // misconfiguration — the route reports it, scheduler stays quiet
    }
  }

  // Background scheduler: keeps the briefing warm at the fixed slots.
  // unref'd so it never blocks shutdown.
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
    if (fresh) {
      // Main payload's slot hasn't rolled over — but "Right now" has its
      // own, shorter TTL (see refreshStatusQuoIfStale); a no-op when it's
      // not actually stale yet.
      refreshStatusQuoIfStale(config);
      return res.json({ ok: true, data: fresh.value });
    }
    const cached = kvGet(CACHE_KEY);
    if (cached) {
      // Never make the client wait: serve what we have (flagged stale) and
      // refresh in the background. The blocking wait for the AI call was the
      // recurring "Preparing your briefing…" the user reported.
      refreshIfStale(config).catch((err) =>
        console.warn(`[welcome] background refresh failed: ${err.message}`),
      );
      return res.json({ ok: true, data: { ...cached.value, stale: true } });
    }
    try {
      // Cold start (no cache at all): nothing to serve yet — wait once.
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
