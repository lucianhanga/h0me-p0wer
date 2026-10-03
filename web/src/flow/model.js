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
  // Battery↔Home pair: ONE arc, dominant direction (2026-10-03 — same rule
  // as the grid pair). homeToBattW is grid-sourced charging (the device
  // tops up from the grid at the floor: PV 89 W charging 129 W = 89 PV +
  // 40 grid — user report 2026-10-03); drawing it on the PV→Battery arc
  // made PV production and charge look inconsistent.
  const battNet = (d.battToHomeW ?? 0) - (d.homeToBattW ?? 0);
  return {
    nodes: [
      {
        id: "pv",
        label: t("flow.pv"),
        valueW: d.pvW ?? null,
        // Production as a percentage of the installed peak (2026-10-03,
        // user request: "12 × 500 W — how much of maximum capacity").
        sub:
          d.pvW != null && flow.pv?.peakW > 0
            ? t("flow.pvOfMax", { pct: Math.round((d.pvW / flow.pv.peakW) * 100), kwp: Math.round(flow.pv.peakW / 100) / 10 })
            : null,
        color: "#5fce80",
      },
      // No value on the Grid node (user instruction) — arcs carry the usage.
      { id: "grid", label: t("flow.grid"), valueW: null, sub: null, color: "#f7a44f" },
      {
        id: "home",
        label: t("flow.home"),
        valueW: d.homeW ?? null,
        // Usual consumption for this weekday+hour from the 56-day
        // home_usage profile (2026-10-03, user request).
        sub: flow.home?.usualW != null ? t("flow.usualW", { w: flow.home.usualW }) : null,
        color: "#e8ecef",
      },
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
      { id: "batt-home", from: "batt", to: "home", watts: Math.max(0, battNet), color: "#c084fc" },
      // Grid-sourced charging — grid orange, the energy comes from the grid
      // through the home's AC bus, not from the battery.
      { id: "home-batt", from: "home", to: "batt", watts: Math.max(0, -battNet), color: "#f7a44f" },
    ],
  };
}
