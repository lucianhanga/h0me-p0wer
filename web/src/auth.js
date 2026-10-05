// Token auth + visitor fingerprint, client side (2026-10-05, see
// server/auth.js and server/visitors.js). One shared token, not a real
// login — captured once (from a ?token=... URL, or typed into AuthGate's
// prompt), stashed in localStorage, then attached to every /api request
// automatically by wrapping the global fetch, so none of this app's ~19
// existing fetch("/api/...") call sites need to know auth exists.
// getVisitorId() is a separate, auth-independent per-browser random id
// for the header's "active visitors" count. useLiveStream.js reads both
// getToken()/getVisitorId() directly for the WebSocket URL (a wrapped
// fetch can't help there).
const TOKEN_KEY = "apiToken";
const VISITOR_KEY = "visitorId";

// Active-visitor fingerprint (2026-10-05, see server/visitors.js) — a
// random id generated once per browser and kept in localStorage, so the
// SAME browser counts as one visitor across reloads/tabs, while a
// different device (even behind the same IP/NAT) counts separately. Not
// tied to the shared API token — this is just "how many distinct clients
// are using the app right now," independent of auth.
export function getVisitorId() {
  let id = localStorage.getItem(VISITOR_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(VISITOR_KEY, id);
  }
  return id;
}

// A shared link (e.g. the watch's own setup instructions, or just
// bookmarking the dashboard once with the token attached) can carry the
// token in the URL — grab it on first load, persist it, then scrub it
// from the visible address bar/history so it doesn't linger there.
(function bootstrapTokenFromUrl() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (!fromUrl) return;
  localStorage.setItem(TOKEN_KEY, fromUrl);
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
})();

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Every API fetch in this app is a same-origin relative "/api/..." string
// (verified against every call site) — append the token as a query param
// rather than a header, so the exact same getToken() value also works
// for the watch app and the WebSocket URL, which can't set headers.
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  let url = typeof input === "string" ? input : input?.url;
  if (url && url.startsWith("/api")) {
    const token = getToken();
    const params = [];
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    params.push(`visitor=${encodeURIComponent(getVisitorId())}`);
    const sep = url.includes("?") ? "&" : "?";
    url = `${url}${sep}${params.join("&")}`;
    if (typeof input === "string") input = url;
  }
  return nativeFetch(input, init).then((res) => {
    // A 401 means the stored token is missing/wrong/expired — tell
    // AuthGate to drop it and re-prompt, rather than leaving every tile
    // silently stuck on "—" with no way back in.
    if (res.status === 401 && url && url.startsWith("/api")) {
      window.dispatchEvent(new Event("auth:unauthorized"));
    }
    return res;
  });
};
