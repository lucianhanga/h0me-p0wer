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
//
// 2026-10-22 (user request): each visitor also carries its last-seen IP so
// /api/visitors/active can list them (the header count's hover tooltip).
// The IP is best-effort: broadcast touches (a quiet-but-connected WS tab)
// don't know it and keep the previously seen one.

const ACTIVE_WINDOW_MS = 60 * 1000;
const seen = new Map(); // visitor key -> { ip: string|null, lastSeen: ms }

const normIp = (ip) => {
  const v = (ip ?? "").replace(/^::ffff:/, "");
  return v || null;
};

// Real client IP (2026-10-22): production sits behind the Cloudflare
// tunnel (BIND_IP=127.0.0.1) and docker NAT — req.ip/socket address is
// then 127.0.0.1 / ::1 / the docker gateway for EVERYONE, while the actual
// client IP arrives in CF-Connecting-IP. Direct LAN hits have no such
// header and fall through to the socket address.
function clientIp(req) {
  return req.headers?.["cf-connecting-ip"] ?? req.headers?.["x-real-ip"] ?? req.ip ?? req.socket?.remoteAddress ?? null;
}

export function touchVisitor(key, ip = null) {
  const k = key || "unknown";
  seen.set(k, { ip: normIp(ip) ?? seen.get(k)?.ip ?? null, lastSeen: Date.now() });
}

export function trackVisitor(req, res, next) {
  touchVisitor(req.query?.visitor || clientIp(req), clientIp(req));
  next();
}

// The WS upgrade request isn't an Express req (no req.query/req.ip) — same
// extraction logic by hand, for the one connection-time touch. A LIVE
// connection then keeps touching itself on every broadcast push (see
// broadcastLiveSync in index.js) rather than going stale after 60s of a
// client that's connected but just hasn't made a fresh REST call —
// otherwise an open WS tab would silently drop out of the active count.
export function visitorInfoFromUpgradeRequest(req) {
  const url = new URL(req.url, "http://localhost");
  return {
    key: url.searchParams.get("visitor") || clientIp(req) || "unknown",
    ip: clientIp(req),
  };
}

function prune() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  for (const [key, v] of seen) {
    if (v.lastSeen < cutoff) seen.delete(key);
  }
}

export function activeVisitors() {
  prune();
  const ips = [...new Set([...seen.values()].map((v) => v.ip).filter(Boolean))].sort();
  return { count: seen.size, ips };
}
