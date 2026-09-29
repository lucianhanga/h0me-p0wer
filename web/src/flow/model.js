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
      { id: "grid-home", from: "grid", to: "home", watts: d.gridToHomeW ?? 0, color: "#f7a44f" },
      { id: "home-grid", from: "home", to: "grid", watts: d.pvToGridW ?? 0, color: "#f7a44f" },
      { id: "batt-home", from: "batt", to: "home", watts: d.battToHomeW ?? 0, color: "#c084fc" },
    ],
  };
}
