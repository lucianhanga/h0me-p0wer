// Data sources for the Welcome tab: config, geocoding, weather, PVGIS.
// All fetches time out fast and never throw past the route handler's catch.

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
