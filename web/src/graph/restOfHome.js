// "Rest of home" power series (2026-10-22, user report: the coffee
// machine's ~1.4 kW draw ALSO showed up as a Rest-of-home spike while
// nothing else was running). Root cause, verified against production data:
// pulsing loads (coffee thermoblock duty-cycles at ~6 s: 1.4 kW on / ~0 off)
// are sampled by the plug only every ~3 s, so a 5 s bucket holds 1-2
// samples and aliases the pulse phase, while the meter's 1 s samples make
// its bucket a true mean. home − Σplugs then compares out-of-phase values
// and the pulse lands in Rest (seen live: home 1299 W with the plug bucket
// at 0 W → phantom 824 W Rest).
//
// Fix: smooth BOTH home and the plug sum with the same centered moving
// average before subtracting. Over a window covering several pulse periods
// both sides converge to their true means and the pulse cancels; the
// steady-state value and the daily kWh math (integrated separately) are
// untouched. Only small buckets need it — at ≥30 s buckets every plug
// already contributes ≥10 samples, a true mean.
const SMOOTH_MAX_BUCKET_MS = 30000;
const SMOOTH_WINDOW_MS = 35000; // ≈6 coffee-pulse periods at 5 s buckets

function centeredMean(values, i, radius) {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
    const v = values[j];
    if (v == null) continue;
    sum += v;
    n++;
  }
  return n ? sum / n : null;
}

// rows: /api/plugs/timeseries data ([{t, plug__<sn>: W|null, ...}]),
// homeByT: Map(t -> home watts|null) from /api/timeseries at the same
// bucket, plugKeys: the payload's `plugs` list. Returns [[t, restW|null]].
export function restOfHomeSeries(rows, homeByT, plugKeys, bucketMs) {
  const radius =
    bucketMs <= SMOOTH_MAX_BUCKET_MS ? Math.max(1, Math.round(SMOOTH_WINDOW_MS / bucketMs / 2)) : 0;
  const homes = rows.map((r) => homeByT.get(r.t) ?? null);
  const sums = rows.map((r) => {
    let sum = 0;
    for (const s of plugKeys) {
      const v = r[`plug__${s}`];
      if (v != null) sum += v;
    }
    return sum;
  });
  return rows.map((r, i) => {
    const home = radius ? centeredMean(homes, i, radius) : homes[i];
    if (home == null) return [r.t, null];
    const sum = radius ? centeredMean(sums, i, radius) : sums[i];
    return [r.t, Math.max(0, Math.round(home - sum))];
  });
}
