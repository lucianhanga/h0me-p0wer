import { geocode, parseWelcomeConfig, fetchJson } from "./welcome-sources.js";
import { kvGet, kvSet } from "./db.js";

// Deterministic PVGIS expected-production model (2026-10-18, user request):
// historical PVGIS seriescalc data for the installed system, reduced to one
// hourly expected-power curve per local day. NOT a weather forecast: the
// values are the historical mean production at each hour of the SAME local
// month/day across the 2005–2023 PVGIS years.
//
// PVGIS row: { time: "20230615:1200", P: 5234.12 } — P is WATTS.
// We convert each timestamp from UTC to Europe/Berlin using Intl's timezone
// database (DST-safe, no hand-rolled offsets), then average P per hour.
const PVGIS_URL = "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc";
const CACHE_KEY = "pvgis_seriescalc_v1";

const BERLIN_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function berlinParts(date) {
  const parts = {};
  for (const { type, value } of BERLIN_PARTS.formatToParts(date)) {
    if (["year", "month", "day", "hour"].includes(type)) parts[type] = Number(value);
  }
  return parts;
}

function parsePvgisTime(value) {
  const m = /^(\d{4})(\d{2})(\d{2}):(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

function buildHourlyForecast(hourlyRows, targetDate) {
  const target = berlinParts(targetDate);
  const perHour = Array.from({ length: 24 }, () => ({ sum: 0, count: 0 }));
  for (const row of hourlyRows) {
    const ts = parsePvgisTime(row?.time);
    const power = Number(row?.P);
    if (ts == null || !Number.isFinite(power)) continue;
    const local = berlinParts(new Date(ts));
    if (local.month !== target.month || local.day !== target.day) continue;
    perHour[local.hour].sum += power;
    perHour[local.hour].count++;
  }
  return perHour.map(({ sum, count }, hour) => {
    const watts = count ? Math.round((sum / count) * 100) / 100 : 0;
    return { hour, watts, kw: watts / 1000 };
  });
}

let seriescalcInflight = null;

function loadSeriescalc() {
  if (seriescalcInflight) return seriescalcInflight;
  seriescalcInflight = (async () => {
    const config = parseWelcomeConfig();
    if (!config) return null;
    const geo = await geocode(config.address);
    const pv = config.pv;
    const cacheKey = `${CACHE_KEY}:${geo.lat},${geo.lon},${pv.peakKwp},${pv.aspect},${pv.tiltDeg}`;
    const cached = kvGet(cacheKey);
    if (cached?.value?.hourly?.length) return cached.value;
    const params = new URLSearchParams({
      lat: String(geo.lat),
      lon: String(geo.lon),
      startyear: "2005",
      endyear: "2023",
      pvcalculation: "1",
      peakpower: String(pv.peakKwp),
      loss: "14",
      angle: String(pv.tiltDeg),
      aspect: String(pv.aspect),
      pvtechchoice: "crystSi2025",
      mountingplace: "free",
      usehorizon: "1",
      outputformat: "json",
    });
    const data = await fetchJson(`${PVGIS_URL}?${params}`, { timeoutMs: 60000 });
    const hourly = data?.outputs?.hourly;
    if (!Array.isArray(hourly) || !hourly.length) {
      throw new Error("PVGIS returned no hourly production data");
    }
    const value = { hourly, fetchedAt: Date.now() };
    kvSet(cacheKey, value);
    return value;
  })().finally(() => {
    seriescalcInflight = null;
  });
  return seriescalcInflight;
}

export async function getPvForecast() {
  const payload = await loadSeriescalc();
  if (!payload) return null;
  const today = new Date();
  const hours = buildHourlyForecast(payload.hourly, today);
  const expectedDailyKwh = Math.round(hours.reduce((a, h) => a + h.kw, 0) * 100) / 100;
  return {
    date: today.toLocaleDateString("sv"),
    hours: hours.map((h) => ({
      ...h,
      t: new Date(today.getFullYear(), today.getMonth(), today.getDate(), h.hour).getTime(),
    })),
    expectedDailyKwh,
    source: "pvgis-historical-mean",
    fetchedAt: payload.fetchedAt,
  };
}
