import { geocode, parseWelcomeConfig, fetchJson, localDate } from "./welcome-sources.js";
import { kvGet, kvSet } from "./db.js";

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const CACHE_KEY = "open_meteo_pv_forecast_v1";
const CACHE_TTL_MS = 15 * 60 * 1000;
const SYSTEM_LOSS = 0.14;
const SOURCE = "open-meteo-weather-forecast";

export function buildWeatherForecast(hourly, pv, now = new Date()) {
  const date = localDate(now);
  if (!Array.isArray(hourly?.time) || !Array.isArray(hourly?.global_tilted_irradiance)) {
    throw new Error("Open-Meteo returned no tilted-irradiance forecast");
  }
  const rows = hourly.time
    .map((time, i) => ({ time, irradiance: hourly.global_tilted_irradiance[i] }))
    .filter((row) => row.time.startsWith(date));
  if (rows.length !== 24) throw new Error(`Open-Meteo returned ${rows.length} hours for ${date}`);
  const hours = rows.map(({ time, irradiance }) => {
    const gti = Number(irradiance);
    const watts = Math.round(Math.max(0, Number.isFinite(gti) ? gti : 0) * pv.peakKwp * (1 - SYSTEM_LOSS) * 100) / 100;
    return {
      hour: Number(time.slice(11, 13)),
      watts,
      kw: watts / 1000,
      t: new Date(`${time}:00`).getTime(),
    };
  });
  return {
    date,
    hours,
    expectedDailyKwh: Math.round(hours.reduce((sum, h) => sum + h.kw, 0) * 100) / 100,
    source: SOURCE,
  };
}

let forecastInflight = null;

function loadForecastWeather() {
  if (forecastInflight) return forecastInflight;
  forecastInflight = (async () => {
    const config = parseWelcomeConfig();
    if (!config) return null;
    const geo = await geocode(config.address);
    const pv = config.pv;
    const cacheKey = `${CACHE_KEY}:${geo.lat},${geo.lon},${pv.tiltDeg},${pv.aspect}`;
    const cached = kvGet(cacheKey);
    if (cached?.value?.hourly && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { ...cached.value, pv };
    }
    try {
      const params = new URLSearchParams({
        latitude: String(geo.lat),
        longitude: String(geo.lon),
        timezone: "Europe/Berlin",
        forecast_days: "2",
        hourly: "global_tilted_irradiance",
        tilt: String(pv.tiltDeg),
        azimuth: String(pv.aspect),
      });
      const data = await fetchJson(`${OPEN_METEO_URL}?${params}`, { timeoutMs: 20000 });
      if (!data?.hourly?.global_tilted_irradiance?.length) {
        throw new Error("Open-Meteo returned no tilted-irradiance forecast");
      }
      const value = { hourly: data.hourly, fetchedAt: Date.now() };
      kvSet(cacheKey, value);
      return { ...value, pv };
    } catch (err) {
      if (cached?.value?.hourly) return { ...cached.value, pv };
      throw err;
    }
  })().finally(() => {
    forecastInflight = null;
  });
  return forecastInflight;
}

export async function getPvForecast() {
  const payload = await loadForecastWeather();
  if (!payload) return null;
  return {
    ...buildWeatherForecast(payload.hourly, payload.pv),
    fetchedAt: payload.fetchedAt,
  };
}
