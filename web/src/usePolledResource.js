import { useCallback, useEffect, useRef, useState } from "react";

// Poll a JSON endpoint on an interval, exposing {data, error, loading,
// refresh, setData} — retires the fetch+useEffect+setInterval+error-state
// boilerplate that was independently hand-rolled in nearly every tab (see
// AGENTS.md's architecture-review entry: the same ~15 lines, written 5+
// times, each with tiny drifting differences).
//
// `envelope` (default true): this API has two response shapes in the wild
// (a second architecture-review finding, not yet fixed) — most routes
// return {ok, data, error}; a few (/api/power-plan and friends) return the
// bare payload directly. Pass `envelope: false` for those.
//
// `keepLastGoodOnError` (default false): once real data has loaded, a
// transient poll failure is swallowed instead of surfacing as an error —
// for tabs whose render prioritizes showing an error over showing stale
// data (i.e. `if (error) return <Error/>` runs BEFORE `if (!data)`), so a
// single missed poll would otherwise blank out an otherwise-fine page.
// Off by default: most tabs here already gate their error render behind
// `!data`, so the plain always-set-error behavior is harmless for them and
// keeps a genuine, currently-unreachable endpoint visibly erroring instead
// of silently going quiet forever.
//
// `setData` is exposed so a mutation (POST) can push its own response
// straight into state without waiting for the next poll tick — every
// current call site already does this (RoiTab's baseline recompute,
// StrategyTab/PowerPlanCard's strategy/enable actions, BatteryTab's
// refresh button).
export function usePolledResource(
  url,
  { intervalMs, envelope = true, keepLastGoodOnError = false, enabled = true } = {},
) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const hasData = useRef(false);

  const load = useCallback(() => {
    if (!enabled || !url) return Promise.resolve();
    return fetch(url)
      .then((r) => r.json())
      .then((res) => {
        if (!mounted.current) return;
        if (envelope) {
          if (!res.ok) throw new Error(res.error ?? "request failed");
          setData(res.data);
        } else {
          setData(res);
        }
        hasData.current = true;
        setError(null);
      })
      .catch((e) => {
        if (!mounted.current) return;
        if (keepLastGoodOnError && hasData.current) return; // keep showing the last good data
        setError(String(e.message ?? e));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, [url, envelope, keepLastGoodOnError, enabled]);

  useEffect(() => {
    mounted.current = true;
    load();
    const timer = intervalMs ? setInterval(load, intervalMs) : null;
    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
    };
  }, [load, intervalMs]);

  return { data, error, loading, refresh: load, setData };
}
