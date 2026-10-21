export function consumerListRows(data, restLabel, colorOf, restColor) {
  const rows = data.plugs
    .map((p, i) => ({
      key: p.sn,
      label: p.name,
      color: colorOf(p, i),
      kwh: p.kwh,
    }))
    .sort((a, b) => (b.kwh ?? 0) - (a.kwh ?? 0));
  rows.push({ key: "rest", label: restLabel, color: restColor, kwh: data.restKwh });
  return rows;
}
