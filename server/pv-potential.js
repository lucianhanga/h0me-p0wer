// PV curtailment potential (2026-10-13, user request): when the batteries
// sit at the charge ceiling, the system curtails — the panels COULD produce
// more than they do. Estimate the current potential from Open-Meteo's
// hourly shortwave radiation (GHI, W/m² — already fetched by the weather
// pipeline) scaled by the system's nameplate: potential ≈ GHI/1000 ×
// nameplate × PR. This is a VISUAL estimate (a ghost segment on the PV
// bars), not a billing figure — orientation/tilt differ per port and GHI
// ignores them; PR 0.8 covers temperature/angle/inverter losses honestly
// enough for that purpose.
import { parseWelcomeConfig, geocode, fetchWeather } from "./welcome-sources.js";

const PR = 0.8;
const CACHE_MS = 30 * 60 * 1000; // hourly weather data — 30-min refresh is plenty

let cached = null; // { at, wPerKwp }

// Watts currently producible per kWp of nameplate (GHI × PR), or null when
// weather/location is unconfigured or the fetch failed. Never throws.
export async function refreshPvPotential() {
  try {
    const config = parseWelcomeConfig();
    if (!config) return null;
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      const { lat, lon } = await geocode(config.address);
      const w = await fetchWeather(lat, lon);
      const hours = w?.hourly?.time ?? [];
      const ghi = w?.hourly?.shortwave_radiation ?? [];
      const nowH = new Date();
      nowH.setMinutes(0, 0, 0);
      const nowIso = nowH.toLocaleString("sv").replace(" ", "T").slice(0, 16);
      // Find the current hour (Open-Meteo returns ISO local times).
      let idx = hours.findIndex((t) => t.slice(0, 16) === nowIso);
      if (idx < 0) idx = hours.findLastIndex((t) => t < nowIso);
      if (idx < 0 || typeof ghi[idx] !== "number") return cached;
      cached = { at: Date.now(), wPerKwp: ghi[idx] * PR };
    }
    return cached;
  } catch (err) {
    console.warn(`[pv-potential] refresh failed: ${err.message}`);
    return cached;
  }
}

// Synchronous read for the flow payload — null until the first refresh.
export function pvPotentialWPerKwp() {
  return cached?.wPerKwp ?? null;
}
