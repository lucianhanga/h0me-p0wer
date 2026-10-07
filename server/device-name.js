// Display names for Anker devices (2026-10-07, user request): the account
// uses an internal naming convention — "h-solar-tv", "h-solarbank-4",
// possibly plain "h-xxx" — which must not leak into the UI. Strip ONLY at
// the point a name is emitted into a UI-bound payload: internal lookups
// keep the raw name (PV_PORT_W_<sanitized unit name> env keys in
// index.js are built from the raw unit name, and site resolution matches
// raw SNs/names).
export function displayDeviceName(name) {
  if (typeof name !== "string") return name;
  return name.replace(/^h-(solar-)?/, "");
}
