import { usePolledResource } from "../usePolledResource.js";

// Active-visitor count next to the version number (2026-10-05, user
// request: "near the version show me the number of active visitors").
// GET /api/visitors/active counts distinct fingerprints (see
// web/src/auth.js's getVisitorId() / server/visitors.js) seen in the last
// 60s — 30s poll is plenty for a slowly-changing "who's looking at this
// right now" figure. Renders nothing before the first successful poll
// (no placeholder flicker) and silently stays as last-known-good on a
// transient failure rather than disappearing.
export default function ActiveVisitors() {
  const { data } = usePolledResource("/api/visitors/active", { intervalMs: 30000, keepLastGoodOnError: true });
  if (data?.count == null) return null;
  // Hover reveals the visitors' IPs (2026-10-22, user request). Native
  // title tooltip: one line of explanation + one line per active IP.
  const title = ["Active in the last minute", ...(data.ips ?? [])].join("\n");
  return (
    <span className="active-visitors" title={title}>
      {data.count} online
    </span>
  );
}
