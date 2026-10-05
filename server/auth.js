// Simple token auth (2026-10-05, user request: "its public and everybody
// can access it... just token authentication"). ONE shared secret, not
// per-user accounts — a single-user home dashboard doesn't need more than
// that. The token itself carries no claims (it's just a random string
// compared against process.env.API_TOKEN); its expiry lives alongside it
// in API_TOKEN_EXPIRES_AT so a compromised/leaked token stops working on
// its own after 4 weeks even if nobody manually revokes it — see
// generate-token.js for the renewal tool.
//
// Deliberately FAILS OPEN when API_TOKEN isn't set in .env: this ships the
// capability without silently locking out an existing deployment that
// hasn't generated a token yet. Auth only actually activates once a token
// is configured.
//
// Token must reach the server three different ways, so `requireAuth`
// accepts any of them: an `Authorization: Bearer <token>` header (the
// web frontend's wrapped fetch), a `token` query param (the Garmin watch
// app, which can't easily set custom headers on its poll, and the
// WebSocket upgrade request, which the browser's native WebSocket API
// can't attach headers to at all).

function extractToken(req) {
  const auth = req.headers?.authorization;
  const m = auth && /^Bearer (.+)$/.exec(auth);
  if (m) return m[1];
  return req.query?.token || null;
}

function isValidToken(token) {
  const expected = process.env.API_TOKEN;
  if (!expected) return true; // no token configured — auth not active yet
  if (!token || token !== expected) return false;
  const expiresAt = process.env.API_TOKEN_EXPIRES_AT;
  if (expiresAt && Date.now() > new Date(expiresAt).getTime()) return false;
  return true;
}

export function requireAuth(req, res, next) {
  if (isValidToken(extractToken(req))) return next();
  res.status(401).json({ ok: false, error: "unauthorized" });
}

// For WebSocketServer's verifyClient — `req` there is the raw HTTP
// upgrade request (http.IncomingMessage), not an Express req, so the
// token can only arrive via the query string.
export function wsTokenValid(req) {
  const url = new URL(req.url, "http://localhost");
  return isValidToken(url.searchParams.get("token"));
}

// For the server's own loopback calls back into its own now-protected
// /api routes (watch.js/welcome.js/daybrief.js calling
// http://127.0.0.1:PORT/api/stats/overview etc. to reuse that route's
// computation instead of re-deriving it) — these are real HTTP requests
// requireAuth sees just like any external caller's, so they 401 just the
// same without this (2026 regression: broke the Garmin watch's Today/
// History fields and the welcome page's weekly recap the same way,
// caught via the watch — see h0me-p0wer-garmin's commit fixing this).
// {} when no token is configured (auth isn't active, nothing to attach).
export function internalAuthHeaders() {
  const token = process.env.API_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
