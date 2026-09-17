// Single canonical "avoided grid cost" calculation (2026-09-17, user
// request) — ALWAYS based on total PV PRODUCTION, never on how much of it
// reached the house directly vs. by way of the battery. This system
// enforces zero export and the house baseload always exceeds PV output (see
// AGENTS.md), so every produced kWh avoids a grid import SOMEWHERE — either
// today (direct) or later (after a battery round-trip). Counting only
// same-day direct-to-home + battery-cells-discharged kWh (the previous
// approach) systematically understates a day that charged the battery for
// tonight and overstates a day that's mostly discharging energy stored on a
// previous, sunnier day — the two should converge over a full period, but
// disagree day to day, which is what the user noticed on the Dashboard.
// Used by every tab that shows a €-saved figure (Dashboard, Welcome, ROI)
// so they can't drift apart from each other again — see AGENTS.md.
export function savedEur(producedKwh, tariffEurPerKwh) {
  if (producedKwh == null || tariffEurPerKwh == null) return null;
  return Math.round(producedKwh * tariffEurPerKwh * 100) / 100;
}
