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

// Outlier capping for chart axes (moved from GraphTab.jsx 2026-10-03 so the
// simple view's charts share it). A spike is an outlier only when it beats
// the typical range by BOTH tests: an absolute margin AND a ratio — a
// percentile-only test breaks on a near-zero baseline (a window that's
// mostly 0 W with a brief legit 150 W got capped at 0 W), a ratio-only test
// would cap 500 W baseline + 900 W peak, which is normal house variation.
const MIN_OUTLIER_DELTA_W = 300; // must be > the "100 or 200 over 0" case
const MIN_OUTLIER_RATIO = 2;
export function robustCap(values) {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rawMax = sorted[sorted.length - 1];
  const p98 = sorted[Math.min(sorted.length - 1, Math.floor(0.98 * sorted.length))];
  const cap = Math.max(50, Math.ceil((p98 * 1.15) / 50) * 50);
  const isOutlier =
    rawMax > cap &&
    rawMax - p98 >= MIN_OUTLIER_DELTA_W &&
    (p98 <= 0 || rawMax >= p98 * MIN_OUTLIER_RATIO);
  return isOutlier ? { cap, rawMax } : null;
}

// Tight y-axis bounds for the POWER charts (2026-10-03, user request:
// "maximize the shown data — make the Y range as small as possible to
// accommodate the values"; the °C/% module charts keep their fixed ranges).
// Pads the data extent by 8% and snaps outward to a 1-2-5 "nice" step so
// the tick labels stay round. An all-positive chart keeps 0 as its floor
// only when the data actually reaches near it — otherwise the dead space
// below the data is exactly what this removes (a calm 200-800 W night no
// longer renders on a 0-3000 W axis).
export function tightAxisBounds(dataMin, dataMax) {
  if (dataMin == null || dataMax == null || !Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
    return null;
  }
  if (dataMax <= dataMin) dataMax = dataMin + 1;
  const pad = (dataMax - dataMin) * 0.08;
  const lo = dataMin - pad;
  const hi = dataMax + pad;
  const span = hi - lo;
  const mag = Math.pow(10, Math.floor(Math.log10(span)));
  const step = [0.1, 0.2, 0.5, 1].map((f) => f * mag).find((s) => span / s <= 5) ?? mag;
  let min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  if (dataMin >= 0 && min < 0) min = 0;
  // Guard against float noise in the snap arithmetic (e.g. 0.30000000004).
  return { min: Math.round(min * 100) / 100, max: Math.round(max * 100) / 100 };
}
