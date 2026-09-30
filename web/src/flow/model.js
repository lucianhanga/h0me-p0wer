import { formatEta } from "../batteryEta.js";

// Renderer-agnostic flow model (2026-09-29): the ONE place where the
// /api/flow payload becomes nodes + edges for the live flow diagram. All
// data semantics live here — every visual variant (basic now, artistic
// later) renders THIS model, so the views can never drift on WHAT is
// shown, only on HOW it looks.
//
// Values come from flow.diagram — Anker's own scen_info channels (the
// same numbers the Anker app displays; arcs close exactly to the Home
// node). Grid node carries NO value by user instruction — the arcs
// represent the grid usage. Battery node carries the SOC percentage plus
// the time-to-empty estimated from the 7-day-average consumption rate
// (computed server-side).
export function buildFlowModel(flow, t) {
  const d = flow?.diagram;
  if (!d) return null;
  const eta = d.timeToEmptyH != null ? formatEta(d.timeToEmptyH) : null;
  // ONE arc between grid and house: the DOMINANT direction only
  // (2026-09-29, user report — "the arc goes both directions"). The two
  // cloud channels can be nonzero at the same moment (per-phase import on
  // L3 while the single-phase inverter exports on L1, plus measurement
  // timing), and photovoltaic_to_grid_power can even read a small
  // NEGATIVE (e.g. −7) — which drew an export arc labeled "−7 W" next to
  // the import arc. Net them like the old signed value did; the battery
  // pair already follows the same dominant-direction rule.
  // The ±20 W display deadband lives here (2026-09-29 review — it used to
  // be a LiveTab wrapper zeroing flow.grid, which this model doesn't
  // read): the meter/net value jitters around zero at near-balanced flow,
  // and a flickering arc is noise, not signal.
  const GRID_DEADBAND_W = 20;
  let gridNet = Math.max(0, d.gridToHomeW ?? 0) - Math.max(0, d.pvToGridW ?? 0);
  if (Math.abs(gridNet) <= GRID_DEADBAND_W) gridNet = 0;
  return {
    nodes: [
      { id: "pv", label: t("flow.pv"), valueW: d.pvW ?? null, sub: null, color: "#5fce80" },
      // No value on the Grid node (user instruction) — arcs carry the usage.
      { id: "grid", label: t("flow.grid"), valueW: null, sub: null, color: "#f7a44f" },
      { id: "home", label: t("flow.home"), valueW: d.homeW ?? null, sub: null, color: "#e8ecef" },
      {
        id: "batt",
        label: flow.battery?.name ?? t("flow.battery"),
        text: d.batterySoc != null ? `${d.batterySoc}%` : "—",
        sub: eta ? t("flow.eta", { eta }) : null,
        color: "#c084fc",
      },
    ],
    edges: [
      { id: "pv-batt", from: "pv", to: "batt", watts: d.pvToBattW ?? 0, color: "#5fce80" },
      { id: "pv-home", from: "pv", to: "home", watts: d.pvToHomeW ?? 0, color: "#5fce80" },
      { id: "grid-home", from: "grid", to: "home", watts: Math.max(0, gridNet), color: "#f7a44f" },
      { id: "home-grid", from: "home", to: "grid", watts: Math.max(0, -gridNet), color: "#f7a44f" },
      { id: "batt-home", from: "batt", to: "home", watts: d.battToHomeW ?? 0, color: "#c084fc" },
    ],
  };
}
