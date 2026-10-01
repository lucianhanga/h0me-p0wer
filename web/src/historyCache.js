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
const MAX_ENTRIES = 12;

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
export function readCached(url) {
  try {
    const raw = localStorage.getItem(PREFIX + url);
    if (!raw) return null;
    const { hv, v } = JSON.parse(raw);
    if (knownHistoryV != null && hv !== knownHistoryV) {
      purgeAll();
      return null;
    }
    return v;
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
    localStorage.setItem(PREFIX + url, JSON.stringify({ at: Date.now(), hv, v: payload }));
  } catch {
    try {
      purgeAll();
      localStorage.setItem(PREFIX + url, JSON.stringify({ at: Date.now(), hv: payload?.historyV ?? null, v: payload }));
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
