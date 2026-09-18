// Charge/discharge ETA — shared by BatteryTab.jsx and LiveTab.jsx so the two
// never compute this differently (2026-09-18, user request: "all over the
// place where you have the battery displayed... estimate how much time will
// be full respectively empty at the current rate... take in account the
// observed limits for charge and discharge, at discharged including the
// extra amount").
//
// "Full"/"empty" are NOT 0%/100% — they're the account's configured charge
// ceiling and the controller's EFFECTIVE discharge floor (the account floor
// plus its safety margin, i.e. "the extra amount" — see power-plan.js's
// DISCHARGE_TOLERANCE_PCT / BatteryTab.jsx's effectiveFloorPct). Both are
// server-resolved (getBatteryLimits(), the SAME 6 h-cached account config
// used everywhere else) and passed in — this module does no fetching.
export function batteryEtaHours({ mode, soc, chargeW, cellsW, maxPct, floorPct, capacityKwh }) {
  if (capacityKwh == null || soc == null) return null;
  if (mode === "charging" && chargeW > 0 && maxPct != null) {
    const remainingKwh = Math.max(0, ((maxPct - soc) / 100) * capacityKwh);
    return remainingKwh / (chargeW / 1000);
  }
  if (mode === "discharging" && cellsW > 0 && floorPct != null) {
    const remainingKwh = Math.max(0, ((soc - floorPct) / 100) * capacityKwh);
    return remainingKwh / (cellsW / 1000);
  }
  return null;
}

export function formatEta(hours) {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return null;
  const totalMin = Math.round(hours * 60);
  if (totalMin < 1) return "< 1 min";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h}h ${m}m`;
}
