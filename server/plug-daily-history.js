import { plugGroupForName, plugGroupForSn } from "./plug-groups.js";

export function dailyAveragePlugBuckets({ rows, names, from, to, bucketMs, beforeMs, onlySn = null }) {
  const onlyGroup = onlySn ? plugGroupForSn(onlySn) : null;
  const totals = new Map();

  for (const row of rows) {
    if (row.kwh == null) continue;
    const kwh = Number(row.kwh);
    if (!Number.isFinite(kwh) || kwh < 0) continue;
    const group = plugGroupForName(names.get(row.sn) ?? row.name);
    let sn;
    if (onlyGroup) {
      if (group?.sn !== onlyGroup.sn) continue;
      sn = onlyGroup.sn;
    } else if (onlySn) {
      if (row.sn !== onlySn) continue;
      sn = onlySn;
    } else {
      sn = group?.sn ?? row.sn;
    }
    const key = `${row.date}\0${sn}`;
    totals.set(key, (totals.get(key) ?? 0) + kwh);
  }

  const result = [];
  for (const [key, kwh] of totals) {
    const [date, sn] = key.split("\0");
    const [year, month, day] = date.split("-").map(Number);
    const dayStart = new Date(year, month - 1, day).getTime();
    const dayEnd = new Date(year, month - 1, day + 1).getTime();
    if (dayEnd > beforeMs || dayEnd <= from || dayStart >= to) continue;

    const averageW = (kwh * 1000) / ((dayEnd - dayStart) / 3600000);
    const first = Math.max(
      Math.floor(from / bucketMs) * bucketMs,
      Math.ceil(dayStart / bucketMs) * bucketMs,
    );
    for (let bt = first; bt < to && bt < dayEnd; bt += bucketMs) {
      result.push({ bt, sn, w: averageW });
    }
  }
  return result.sort((a, b) => a.bt - b.bt || a.sn.localeCompare(b.sn));
}
