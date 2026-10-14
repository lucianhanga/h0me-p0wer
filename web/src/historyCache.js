// Browser cache for IMMUTABLE history windows (2026-10-01, user request):
// "cache historical values in the browser so you fetch less for
// visualizations — cache only values which are not changing anymore."
//
// Rules:
// - Callers decide what's immutable: a window is immutable only when it ends
//   BEFORE yesterday 00:00 local (the cloud sync rewrites today+yesterday
//   day-trends on its 15-min loop; older periods never change).
// - localStorage, version-keyed by __APP_VERSION__ (repairs ride deploys) —
//   a deploy evicts everything automatically. Additionally, when a fresh
//   response carries a different server historyV (a one-time history repair
//   — see getHistoryVersion in server/db.js), every cached entry is purged.
// - Bounded: max 12 entries, LRU eviction; on quota errors, clear all
//   history entries and retry once.
const PREFIX = `h0mep0wer.hist.${__APP_VERSION__}.`;
// 12 → 24 → 64 (2026-10-14/15 eviction post-mortems): the working set is
// per-tab — 5 graph spans + 14 plug cards + rest + tiles — and a 24-slot
// global LRU THRASHED on every tab switch (Consume filled it, eviction
// halved the oldest = the just-viewed Graph entries, so switching back to
// Graph always refetched: "the data should be there!" — it was, minutes
// earlier). With the keys+rows compression below the whole set is ~2-3 MB,
// far under the 5 MB quota; 64 also covers 2-3 span variants per chart.
const MAX_ENTRIES = 64;

// Timeseries rows repeat the same ~20 keys 800 times per payload — store
// each entry as keys + row arrays instead (≈60-70% smaller). Plug-card
// rows are already [t, v] arrays and pass through untouched.
function pack(payload) {
  const d = payload?.data;
  if (
    Array.isArray(d) &&
    d.length &&
    typeof d[0] === "object" &&
    d[0] !== null &&
    !Array.isArray(d[0])
  ) {
    const k = Object.keys(d[0]);
    return { ...payload, data: { z: 1, k, r: d.map((row) => k.map((key) => row[key] ?? null)) } };
  }
  return payload;
}

function unpack(payload) {
  const d = payload?.data;
  if (d && d.z === 1 && Array.isArray(d.r)) {
    return { ...payload, data: d.r.map((r) => Object.fromEntries(d.k.map((k, i) => [k, r[i]]))) };
  }
  return payload;
}

let knownHistoryV = null; // learned from any fresh response this session

function purgeAll() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* private mode — nothing cached anyway */
  }
}

function evictOldestIfFull() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) keys.push(k);
  }
  if (keys.length < MAX_ENTRIES) return;
  const aged = keys
    .map((k) => {
      try {
        return [k, JSON.parse(localStorage.getItem(k)).at ?? 0];
      } catch {
        return [k, 0];
      }
    })
    .sort((a, b) => a[1] - b[1]);
  for (const [k] of aged.slice(0, Math.ceil(aged.length / 2))) localStorage.removeItem(k);
}

// Returns the cached payload, or null. A historyV mismatch with the
// current server marker purges and misses (a repair rewrote history).
// maxAgeMs (default Infinity): live-edge entries expire — the immutable
// history windows never do.
// The historyV purge only applies when BOTH sides carry a version
// (2026-10-14 bug: plug-card timeseries payloads have NO historyV field —
// null hv !== server's historyV, so every plug-card read purged the WHOLE
// cache and tab switches refetched everything).
export function readCached(url, maxAgeMs = Infinity) {
  try {
    const raw = localStorage.getItem(PREFIX + url);
    if (!raw) return null;
    const { at, hv, v } = JSON.parse(raw);
    if (Date.now() - at > maxAgeMs) return null;
    if (knownHistoryV != null && hv != null && hv !== knownHistoryV) {
      purgeAll();
      return null;
    }
    return unpack(v);
  } catch {
    return null;
  }
}

export function writeCached(url, payload) {
  try {
    const hv = payload?.historyV ?? null;
    if (hv != null && knownHistoryV == null) knownHistoryV = hv;
    if (hv != null && knownHistoryV !== hv) purgeAll(); // server repaired history
    evictOldestIfFull();
    localStorage.setItem(PREFIX + url, JSON.stringify({ at: Date.now(), hv, v: pack(payload) }));
  } catch {
    try {
      purgeAll();
      localStorage.setItem(PREFIX + url, JSON.stringify({ at: Date.now(), hv: payload?.historyV ?? null, v: pack(payload) }));
    } catch {
      /* storage unavailable — caching is best-effort */
    }
  }
}

// "Immutable" test shared by the callers: the window's end must lie before
// YESTERDAY 00:00 local (today's and yesterday's cloud day-trends are still
// being rewritten by the sync loop).
export function immutableBeforeMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - 86400000;
}

// Is this past period immutable? (2026-10-01, user request: cache history
// in the browser — only values that never change.) The cloud sync rewrites
// today+yesterday, so a period is immutable only when it ENDED before
// yesterday 00:00 local. Moved here from Dashboard.jsx 2026-10-07 (the
// Consume period tiles in components/ need it too, and importing it from
// Dashboard.jsx would be a circular import).
export function periodImmutable(type, offset) {
  if (offset < 1) return false; // current period — live
  const bound = immutableBeforeMs();
  const now = new Date();
  let endMs;
  if (type === "day") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    endMs = d.getTime() - (offset - 1) * 86400000;
  } else if (type === "week") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    endMs = d.getTime() - dow * 86400000 - (offset - 1) * 7 * 86400000;
  } else if (type === "month") {
    endMs = new Date(now.getFullYear(), now.getMonth() - offset + 1, 1).getTime();
  } else {
    // year
    endMs = new Date(now.getFullYear() - offset + 1, 0, 1).getTime();
  }
  return endMs <= bound;
}
