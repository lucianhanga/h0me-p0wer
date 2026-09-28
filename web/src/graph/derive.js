// Shared row derivations for the power charts (Graph tab + simple view).
// Validated 2026-09-13: the inverter output includes the PV pass-through;
// PV splits exactly into charge + pass-through. Extracted from GraphTab.jsx
// 2026-09-28 so the simple view's charts can never drift from the Graph
// tab's definitions.
export const pvHomeOf = (r) => ((r.battOut ?? 0) > 0 ? Math.max(0, (r.pv ?? 0) - (r.battChg ?? 0)) : 0);
export const pvBattOf = (r) => Math.min(r.pv ?? 0, r.battChg ?? 0);
// NET cells power: inverter out minus the PV pass-through, minus charge.
// A battery can't charge and discharge its cells at once — bucket averages
// over oscillating states must net, or the graphs show both at once
// (reported 2026-09-15: battery graph showed charging AND discharging).
export const cellsNetOf = (r) => (r.battOut ?? 0) - pvHomeOf(r) - (r.battChg ?? 0);
export const battCellsOf = (r) => Math.max(0, cellsNetOf(r)); // discharging cells
export const battChgNetOf = (r) => Math.min(0, cellsNetOf(r)); // charging cells (neg)
export const homeOf = (r) => (r.grid == null ? null : (r.grid ?? 0) + Math.max(r.battOut ?? 0, 0));

export function rowValue(key, r) {
  switch (key) {
    case "pvHome":
      return pvHomeOf(r);
    case "pvBatt":
      return pvBattOf(r);
    case "battCells":
      return battCellsOf(r);
    case "battChgNeg":
      return battChgNetOf(r);
    case "home":
      return homeOf(r);
    case "gridExp": // residual export below zero — negative part of grid
      return r.grid != null ? Math.min(r.grid, 0) : null;
    default:
      return r[key];
  }
}
