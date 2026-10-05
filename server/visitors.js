// Active-visitor count (2026-10-05, user request: "show me the number of
// active visitors... made a call within the last minute... find a way to
// fingerprint them"). No accounts exist here (single shared token, see
// auth.js) — a "visitor" is a per-browser random id the frontend generates
// once and keeps in localStorage (web/src/auth.js's getVisitorId()),
// stable across reloads/tabs so the SAME browser doesn't count twice but
// DOES still count distinctly from another device behind the same IP/NAT.
// A request with no visitor id (curl, the Garmin watch) falls back to its
// IP so it's still represented, just coarser.
//
// In-memory only — a restart resets the count to 0, which is fine for an
// "active right now" figure (nothing persists activity history here).

const ACTIVE_WINDOW_MS = 60 * 1000;
const seen = new Map(); // visitor key -> last-seen ms

export function touchVisitor(key) {
  seen.set(key || "unknown", Date.now());
}

export function trackVisitor(req, res, next) {
  touchVisitor(req.query?.visitor || req.ip);
  next();
}

// The WS upgrade request isn't an Express req (no req.query/req.ip) — same
// extraction logic by hand, for the one connection-time touch. A LIVE
// connection then keeps touching itself on every broadcast push (see
// broadcastLiveSync in index.js) rather than going stale after 60s of a
// client that's connected but just hasn't made a fresh REST call —
// otherwise an open WS tab would silently drop out of the active count.
export function visitorKeyFromUpgradeRequest(req) {
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("visitor") || req.socket?.remoteAddress || "unknown";
}

export function activeVisitorCount() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  for (const [key, lastSeen] of seen) {
    if (lastSeen < cutoff) seen.delete(key); // prune opportunistically
  }
  return seen.size;
}
