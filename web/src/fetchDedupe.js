// In-flight GET dedupe (2026-10-14, production slowness report): GraphTab's
// five charts are "self-contained units" and each fires the IDENTICAL
// /api/timeseries request on a span switch — 5× the server work for one
// answer (~670k rows × 5 at 7d on the small production host). fetchOnce
// shares the promise: same in-flight URL → one network request.
// Result JSON is shared read-only (callers only read it).
const inflight = new Map();

export function fetchOnce(url) {
  if (!inflight.has(url)) {
    inflight.set(
      url,
      fetch(url)
        .then((r) => r.json())
        .finally(() => {
          // Delete on the next microtask so simultaneous callers share the
          // promise, but a LATER request (next span switch, next poll tick)
          // re-fetches — this is request coalescing, not a cache.
          queueMicrotask(() => inflight.delete(url));
        }),
    );
  }
  return inflight.get(url);
}
