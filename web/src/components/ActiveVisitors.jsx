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
  return (
    <span className="active-visitors" title="Active in the last minute">
      {data.count} online
    </span>
  );
}
