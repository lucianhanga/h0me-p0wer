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
    const h = remainingKwh / (chargeW / 1000);
    // Same degenerate-ETA suppression as the discharge branch (2026-09-29
    // review): at the ceiling this used to print "full in ≈ < 1 min".
    return h * 60 < 2 ? null : h;
  }
  if (mode === "discharging" && cellsW > 0 && floorPct != null) {
    const remainingKwh = Math.max(0, ((soc - floorPct) / 100) * capacityKwh);
    const h = remainingKwh / (cellsW / 1000);
    // At/below the floor the ETA degenerates to "< 1 min" (2026-09-29,
    // user report — "the value in the tile is not right"): the device is
    // about to stop discharging, and the bogus-looking estimate read as
    // broken next to the diagram node's average-rate figure. Suppress it.
    return h * 60 < 2 ? null : h;
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

// Charging status text with the grid-sourced portion (2026-10-03, user
// request — "how do you recommend to display when the battery is charging
// from the grid? go for it"): "charging 129 W · 40 W from grid" for a
// PV+grid mix, "charging 40 W from grid" when purely grid-sourced, plain
// "charging N W" otherwise. ONE helper for every battery status line
// (Strategy cards, system tile, simple-view stacks) so they can't drift.
// gridDominant flags when the grid supplies at least half the charge —
// the call sites tint the status orange (grid money) instead of green.
export function chargingStatus(t, chargeW, gridChargeW = 0) {
  const w = `${Math.round(chargeW)} W`;
  const g = `${Math.round(gridChargeW)} W`;
  const gridDominant = gridChargeW > 0 && gridChargeW >= chargeW / 2;
  const text =
    gridChargeW > 0 && gridChargeW < chargeW
      ? t("battery.status.chargingSplit", { w, grid: g })
      : gridChargeW > 0
        ? t("battery.status.chargingFromGrid", { grid: g })
        : t("battery.status.charging", { w });
  return { text, gridDominant };
}
