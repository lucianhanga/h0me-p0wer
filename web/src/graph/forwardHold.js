export function forwardHoldBridge(data, maxGapMs) {
  let lastT = null;
  let lastV = null;
  return data.map(([t, value]) => {
    if (value != null) {
      lastT = t;
      lastV = value;
      return [t, value];
    }
    if (lastT != null && t - lastT <= maxGapMs) return [t, lastV];
    return [t, null];
  });
}
