import { getSnapshotRows } from "./db.js";

export function integrateGridImportKwh(startMs, endMs, digits = 1) {
  const rows = getSnapshotRows(startMs, endMs).filter((r) => r.grid_total != null);
  let kwh = 0;
  for (let i = 1; i < rows.length; i++) {
    const dtH = (rows[i].ts - rows[i - 1].ts) / 3600000;
    if (dtH > 0.25) continue;
    kwh += (((Math.max(rows[i - 1].grid_total, 0) + Math.max(rows[i].grid_total, 0)) / 2) * dtH) / 1000;
  }
  const scale = 10 ** digits;
  return Math.round(kwh * scale) / scale;
}
