export function mergeRowsByT(existingRows, appendedRows, cutoffMs, getT) {
  const byT = new Map();
  for (const row of existingRows) {
    const t = getT(row);
    if (t >= cutoffMs) byT.set(t, row);
  }
  for (const row of appendedRows) byT.set(getT(row), row);
  return [...byT.values()].sort((a, b) => getT(a) - getT(b));
}
