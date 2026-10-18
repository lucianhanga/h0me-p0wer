export function toPvExpectedRows(payload) {
  const hours = Array.isArray(payload?.data?.hours) ? payload.data.hours : [];
  const rows = hours
    .filter((h) => Number.isFinite(h?.t) && Number.isFinite(h?.watts))
    .map((h) => ({ t: h.t, pvgisExpected: h.watts }))
    .sort((a, b) => a.t - b.t);
  if (rows.length === 24) {
    const end = new Date(rows[0].t);
    end.setDate(end.getDate() + 1);
    rows.push({ t: end.getTime(), pvgisExpected: rows[0].pvgisExpected });
  }
  return rows;
}

export function pvExpectedAt(rows, t) {
  if (!rows?.length || t < rows[0].t || t > rows[rows.length - 1].t) return null;
  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = rows[lo];
  const b = rows[hi];
  if (a.t === b.t || t === a.t) return a.pvgisExpected;
  const ratio = (t - a.t) / (b.t - a.t);
  return a.pvgisExpected + (b.pvgisExpected - a.pvgisExpected) * ratio;
}
