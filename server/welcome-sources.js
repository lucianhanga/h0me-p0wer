// Data sources for the Welcome tab: config, geocoding, weather, PVGIS.
// All fetches time out fast and never throw past the route handler's catch.

import { kvGet, kvSet } from "./db.js";

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const CARDINALS = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

// PVGIS aspect convention: 0 = south, negative = east, positive = west.
export function cardinalToAspect(sym) {
  const deg = CARDINALS[sym?.toUpperCase()?.trim()];
  if (deg == null) {
    throw new Error(
      `PV_ORIENTATION must be one of ${Object.keys(CARDINALS).join(", ")} — got "${sym}"`,
    );
  }
  return deg - 180;
}

export function parseWelcomeConfig(env = process.env) {
  if (!env.HOME_ADDRESS) return null; // tab shows setup instructions
  const peakKwp = Number(env.PV_PEAK_KWP ?? 1);
  const tiltDeg = Number(env.PV_TILT_DEG ?? 17);
  if (!(peakKwp > 0) || !(tiltDeg >= 0 && tiltDeg <= 90)) {
    throw new Error(`PV_PEAK_KWP/PV_TILT_DEG not numeric: ${env.PV_PEAK_KWP}/${env.PV_TILT_DEG}`);
  }
  return {
    address: env.HOME_ADDRESS,
    pv: {
      peakKwp,
      orientation: (env.PV_ORIENTATION ?? "S").toUpperCase().trim(),
      aspect: cardinalToAspect(env.PV_ORIENTATION ?? "S"),
      tiltDeg,
      panelType: env.PV_PANEL_TYPE ?? "unknown c-Si",
    },
    ai: {
      apiKey: env.AI_API_KEY ?? "",
      baseUrl: (env.AI_BASE_URL ?? "https://api.kimi.com/coding/v1").replace(/\/$/, ""),
      model: env.AI_MODEL ?? "k3",
      language: env.AI_LANGUAGE ?? "en",
    },
    tariff: Number(env.TARIFF_EUR_PER_KWH ?? 0.3),
  };
}

export async function fetchJson(url, { timeoutMs = 10000, headers = {}, method, body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers, method, body });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url.slice(0, 80)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Nominatim usage policy: identify the app, don't re-geocode — hence the
// permanent per-address cache.
export async function geocode(address) {
  const key = `geo:${address}`;
  const hit = kvGet(key);
  if (hit) return hit.value;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const rows = await fetchJson(url, { headers: { "User-Agent": "h0me-p0wer/0.3 (private home dashboard)" } });
  if (!rows.length) throw new Error(`address not found: ${address}`);
  const value = { lat: Number(rows[0].lat), lon: Number(rows[0].lon), displayName: rows[0].display_name };
  kvSet(key, value);
  return value;
}

export function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&timezone=${encodeURIComponent("Europe/Berlin")}&forecast_days=7` +
    `&daily=sunrise,sunset,sunshine_duration,shortwave_radiation_sum,temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max` +
    `&hourly=shortwave_radiation,cloudcover`;
  return fetchJson(url);
}

export async function fetchPvgis(lat, lon, pv) {
  const key = `pvgis:${lat},${lon},${pv.peakKwp},${pv.aspect},${pv.tiltDeg}`;
  const hit = kvGet(key);
  if (hit && Date.now() - hit.fetchedAt < 24 * 3600 * 1000) return hit.value;
  const url =
    `https://re.jrc.ec.europa.eu/api/v5_2/PVcalc?lat=${lat}&lon=${lon}` +
    `&peakpower=${pv.peakKwp}&loss=14&angle=${pv.tiltDeg}&aspect=${pv.aspect}&outputformat=json`;
  const j = await fetchJson(url);
  const value = {
    monthly: j.outputs.monthly.fixed.map((m) => ({ month: m.month, kwh: Math.round(m.E_m * 10) / 10 })),
    yearlyKwh: Math.round(j.outputs.totals.fixed.E_y * 10) / 10,
  };
  kvSet(key, value);
  return value;
}
