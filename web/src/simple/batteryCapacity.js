export function capacityValueLabel(value, capacityKwh) {
  if (value == null) return "—";
  const kwh = `${value.toFixed(2)} kWh`;
  if (!(capacityKwh > 0)) return kwh;
  return `${kwh} · ${Math.round((value / capacityKwh) * 100)}%`;
}

export function capacityYAxis(capacityKwh, tight) {
  return {
    min: capacityKwh > 0 ? 0 : tight?.min ?? null,
    max: capacityKwh > 0 ? capacityKwh : tight?.max ?? null,
  };
}

export function socLimitKwh(capacityKwh, pct) {
  if (!(capacityKwh > 0) || pct == null) return null;
  return Math.round((capacityKwh * pct) / 100 * 100) / 100;
}
