import { useEffect, useMemo, useRef, useState } from "react";
import echarts from "../echarts.js";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import FlipTile from "../components/FlipTile.jsx";
import { readCached, writeCached } from "../historyCache.js";
import { fetchOnce } from "../fetchDedupe.js";
import { homeOf } from "../graph/derive.js";
import { SHORTCUTS } from "../graph/GraphTab.jsx";

// Smart plugs tab (2026-10-06): one card per A17X8 plug with a power chart,
// plus a derived "rest of home" chart (home − Σ plugs, floored at 0 — plug
// and meter sample cadences differ by seconds, so small negatives at load
// edges are skew artifacts, not data). Per-plug intraday history is LOCAL
// ONLY (plug_samples, accumulated by the 10 s scene poll): the Anker cloud
// exposes per-plug daily kWh but no power trend, so the curves fill in from
// deploy day.
//
// Charts behave like the Graph tab's (same resolution choices, 2026-10-06
// user request): per-card span buttons (SHORTCUTS shared with GraphTab),
// zoom/pan with a debounced 250 ms padded refetch, live-edge incremental
// appends every 10 s (plug samples land at the 10 s scene cadence), and the
// last span remembered across tab switches. Per-plug cards fetch only
// /api/plugs/timeseries; the Rest card also fetches /api/timeseries with
// the same bucket so rows align by t and "rest" is a per-bucket
// subtraction (home definition shared via derive.js's homeOf).
// Card headers poll /api/plugs every 10 s for live watts + today's kWh.
const LIVE_EDGE_MS = 2 * 60 * 1000; // "live" when right edge within 2 min of now
// Palette shared with the Dashboard's Consumers tile (2026-10-06) — a plug
// must keep the same color in both places.
// 2026-10-10 redesign (user request): 16 hues 22.5° apart (HSL S65/L62,
// tuned for the dark card background), ordered by BIT-REVERSED index so any
// used prefix is maximally hue-separated and unused tail slots stay reserved
// — and mutually distinct — for future plugs. Assignment is STABLE: the
// server hands each plug its first-seen colorIdx (kv plug_color_order), so
// adding/renaming a plug never recolors the others (the old name-sorted
// position did exactly that). plugColor() falls back to list position for
// payloads without colorIdx.
export const PLUG_COLORS = [
  "#dd5f5f", "#5fdddd", "#9edd5f", "#9e5fdd",
  "#ddbe5f", "#5f7fdd", "#5fdd7f", "#dd5fbe",
  "#dd8e5f", "#5faedd", "#6fdd5f", "#cd5fdd",
  "#cddd5f", "#6f5fdd", "#5fddae", "#dd5f8e",
];
export const REST_COLOR = "#90a4ae";
export function plugColor(p, fallbackIdx) {
  return PLUG_COLORS[(p.colorIdx ?? fallbackIdx) % PLUG_COLORS.length];
}

// Remembers each card's selected span across tab switches (the tab unmounts
// on switch — see App.jsx), same pattern as GraphTab's savedSpanMs.
const savedSpanMs = {};

function chartOption(color) {
  const isPhone = window.matchMedia("(max-width: 600px)").matches;
  return {
    animation: false,
    backgroundColor: "transparent",
    grid: isPhone
      ? { top: 8, right: 2, bottom: 22, left: 2, containLabel: false }
      : { top: 8, right: 8, bottom: 22, left: 44 },
    tooltip: {
      trigger: "axis",
      valueFormatter: (v) => (v == null ? "—" : `${Math.round(v)} W`),
      backgroundColor: "#1a2128",
      borderColor: "#2a3238",
      textStyle: { color: "#e8ecef", fontSize: 12 },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: "#2a3238" } },
      axisLabel: {
        color: "#8b98a5",
        fontSize: 10,
        hideOverlap: true,
        formatter: (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      splitNumber: 2,
      // Never finer than 50 W steps (2026-10-06, user request): low-power
      // plugs (a 9 W idle draw) otherwise get 5/10 W tick labels that read
      // as false precision. Bigger steps are still allowed when the data
      // range needs them.
      minInterval: 50,
      axisLabel: {
        color: "#8b98a5",
        fontSize: 10,
        formatter: (v) => `${Math.round(v)}`,
        inside: isPhone,
      },
      splitLine: { lineStyle: { color: "#2a323866" } },
    },
    // preventDefaultMouseMove: false (2026-10-07, user report): with the
    // default (true) the inside-zoom roam controller preventDefaults
    // touchmove-as-mousemove — a vertical swipe over a chart showed the
    // tooltip but never scrolled the page on phones.
    dataZoom: [{ type: "inside", xAxisIndex: 0, filterMode: "none", preventDefaultMouseMove: false }],
    series: [
      {
        name: "W",
        type: "line",
        // Symbols are enabled DYNAMICALLY (2026-10-12): only when the
        // loaded series is sparse (< 50% of buckets non-null — e.g. house
        // light's 30 s samples in 5 s buckets, where a line-only chart
        // renders nothing). Dense plug series stay clean lines (user
        // feedback: "the dots look strange").
        showSymbol: false,
        symbolSize: 2.5,
        connectNulls: false,
        lineStyle: { color, width: 1.5 },
        itemStyle: { color },
        areaStyle: { color: `${color}33` },
        emphasis: { disabled: true },
        data: [],
      },
    ],
  };
}

function PlugCard({ cardKey, sn, isRest, title, subtitle, color, watts, todayKwh, offline, t, aggregate = false, membersUrl = null }) {
  const ref = useRef(null);
  const apiRef = useRef(null);
  const [activeSpan, setActiveSpan] = useState(savedSpanMs[cardKey] ?? 24 * 3600 * 1000);

  useEffect(() => {
    // No width/height at init — the pinned-size rotation bug (2026-09-12).
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption(chartOption(color));
    let rows = []; // [[t, watts|null], ...]
    let bucketMs = 0;
    let fetchSeq = 0;
    let fetchTimer = null;
    let programmatic = false;
    let liveBusy = false;
    let disposed = false;

    // Fetch this card's series over [fromMs, toMs]. `extra` carries either
    // points+view (full loads) or bucket (live-edge appends).
    // Span loads are STALE-WHILE-REVALIDATE (2026-10-14, user report:
    // switching tabs showed empty cards while refetching): loadRange serves
    // any cached copy instantly and this always fetches fresh to replace
    // it. Zoom/pan and live deltas stay uncached.
    async function fetchRows(fromMs, toMs, extra, { spanCache = false } = {}) {
      // sn= (2026-10-12 Consume-slowness fix): the server then reads only
      // this plug's rows via the (sn, ts) index instead of full-scanning
      // plug_samples for every card. The Rest card stays unfiltered — it
      // genuinely needs every plug.
      const snParam = isRest ? "" : `&sn=${encodeURIComponent(sn)}`;
      const url = `/api/plugs/timeseries?from=${Math.round(fromMs)}&to=${Math.round(toMs)}&${extra}${snParam}`;
      const pr = await fetchOnce(url).catch(() => null);
      if (!pr?.ok) return null;
      let result;
      if (!isRest) {
        result = { bucketMs: pr.bucketMs, data: pr.data.map((r) => [r.t, r[`plug__${sn}`] ?? null]) };
      } else {
        const hr = await fetchOnce(
          `/api/timeseries?from=${Math.round(fromMs)}&to=${Math.round(toMs)}&bucket=${pr.bucketMs}`,
        ).catch(() => null);
        const homeByT = new Map();
        if (hr?.ok) for (const r of hr.data) homeByT.set(r.t, homeOf(r));
        result = {
          bucketMs: pr.bucketMs,
          data: pr.data.map((r) => {
            let sum = 0;
            for (const s of pr.plugs) {
              const v = r[`plug__${s}`];
              if (v != null) sum += v;
            }
            const home = homeByT.get(r.t);
            return [r.t, home == null ? null : Math.max(0, Math.round(home - sum))];
          }),
        };
      }
      if (spanCache) writeCached(url, result);
      return result;
    }

    function setWindow(fromMs, toMs) {
      programmatic = true;
      chart.setOption({ dataZoom: [{ startValue: fromMs, endValue: toMs }] });
      programmatic = false;
    }

    function visibleWindow() {
      const win = chart.getOption().dataZoom?.[0];
      const start = Number(win?.startValue);
      const end = Number(win?.endValue);
      return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
    }

    // Gap-capped forward hold (2026-10-12, user request: house light
    // should show a continuous line like the other graphs): a null bucket
    // takes the previous value when the gap to the last real sample is ≤
    // BRIDGE_MAX_GAP_MS — bridges the sampling cadence (30 s HmIP polls in
    // 5 s buckets) without ever drawing across a real outage. Honest for
    // power data (a load holds its state until it changes) and harmless
    // for dense series, which have no nulls to bridge.
    const BRIDGE_MAX_GAP_MS = 2 * 60 * 1000;
    function bridgeGaps(data) {
      let lastT = null;
      let lastV = null;
      return data.map(([t, v]) => {
        if (v != null) {
          lastT = t;
          lastV = v;
          return [t, v];
        }
        if (lastT != null && t - lastT <= BRIDGE_MAX_GAP_MS) return [t, lastV];
        return [t, null];
      });
    }

    // Symbols only where the (bridged) series is still sparse — after the
    // forward hold, a healthy 30 s-cadence series is continuous and needs
    // no dots at all, exactly like the other graphs.
    function applySeries() {
      const bridged = bridgeGaps(rows);
      const nonNull = bridged.reduce((a, r) => a + (r[1] != null ? 1 : 0), 0);
      const sparse = bridged.length > 0 && nonNull / bridged.length < 0.5;
      chart.setOption({ series: [{ data: bridged, showSymbol: sparse }] });
    }

    const SPAN_SNAP_MS = 5 * 60 * 1000; // snapped window for cache-shared span loads

    async function loadRange(fromMs, toMs, viewMs = toMs - fromMs, opts = {}) {
      const seq = ++fetchSeq;
      const extra = `points=800&view=${Math.round(viewMs)}`;
      // Populate from cache instantly, then let the fresh fetch replace it
      // (stale-while-revalidate — the live appender covers the gap between
      // the cached window's end and now within seconds).
      if (opts.spanCache) {
        const snParam = isRest ? "" : `&sn=${encodeURIComponent(sn)}`;
        const hit = readCached(
          `/api/plugs/timeseries?from=${Math.round(fromMs)}&to=${Math.round(toMs)}&${extra}${snParam}`,
        );
        if (hit) {
          rows = hit.data;
          bucketMs = hit.bucketMs;
          applySeries();
        }
      }
      const payload = await fetchRows(fromMs, toMs, extra, opts);
      if (!payload || seq !== fetchSeq || disposed) return;
      rows = payload.data;
      bucketMs = payload.bucketMs;
      applySeries();
    }

    function loadVisible() {
      const win = visibleWindow();
      if (!win) return;
      const pad = (win[1] - win[0]) / 2;
      loadRange(win[0] - pad, win[1] + pad, win[1] - win[0]);
    }

    function scheduleLoad() {
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(loadVisible, 250);
    }

    chart.on("datazoom", () => {
      if (programmatic) return;
      scheduleLoad();
      const win = visibleWindow();
      if (win) {
        const span = win[1] - win[0];
        const match = SHORTCUTS.find((s) => Math.abs(span - s.ms) / s.ms < 0.02);
        if (match) savedSpanMs[cardKey] = match.ms;
        setActiveSpan(match?.ms ?? null);
      }
    });

    async function setSpan(ms) {
      savedSpanMs[cardKey] = ms;
      setActiveSpan(ms);
      // Snap the right edge UP to a 5-min boundary so repeated span loads
      // (and full page reloads) share one cache URL (see fetchRows); the
      // 3 s live timer re-anchors the window to now within seconds.
      const to = Math.ceil(Date.now() / SPAN_SNAP_MS) * SPAN_SNAP_MS;
      const from = to - ms;
      await loadRange(from, to, ms, { spanCache: true });
      setWindow(from, to);
    }
    apiRef.current = { setSpan };

    // Initial view: the span this card was last showing, else 24h.
    setSpan(savedSpanMs[cardKey] ?? 24 * 3600 * 1000);

    // Keep the view fresh while watching the live edge. 3 s baseline (the
    // server's scene poll runs at ~2.5 s while watched) — but at ≥6 h spans
    // the live tick is capped at 30 s (2026-10-13, user request): a delta
    // of two buckets is invisible at that width, and 14 cards × 3 s is
    // real churn on a phone. The window slide stays at 3 s (visual only,
    // no fetch).
    const LIVE_DELTA_MIN_MS = 5.9 * 3600 * 1000; // 6h span MINUS clamp slack — ECharts clamps the
    // window to the data extent (observed: 6h span → 5.96h visible), so a
    // 6h-exact threshold would never fire (tick-log verified 2026-10-13).
    const LIVE_DELTA_SLOW_MS = 30 * 1000;
    let lastLiveFetchAt = 0;
    const liveTimer = setInterval(async () => {
      if (liveBusy) return;
      const win = visibleWindow();
      if (!win) return;
      if (win[1] < Date.now() - LIVE_EDGE_MS) return;
      const width = win[1] - win[0];
      if (width >= LIVE_DELTA_MIN_MS && Date.now() - lastLiveFetchAt < LIVE_DELTA_SLOW_MS) {
        // Slow tick: still slide the window, skip the fetch.
        setWindow(Date.now() - width, Date.now());
        return;
      }
      liveBusy = true;
      lastLiveFetchAt = Date.now();
      try {
        const lastT = rows.length ? rows[rows.length - 1][0] : win[0];
        const payload = await fetchRows(lastT + 1, Date.now(), `bucket=${bucketMs}`);
        if (payload?.data.length) {
          const cutoff = Date.now() - width * 1.5;
          const byT = new Map();
          for (const r of rows) if (r[0] >= cutoff) byT.set(r[0], r);
          for (const r of payload.data) byT.set(r[0], r);
          rows = [...byT.values()].sort((a, b) => a[0] - b[0]);
          applySeries();
        }
        // Only slide the window if the right edge is still at the live edge.
        const win2 = visibleWindow();
        if (win2 && win2[1] >= Date.now() - LIVE_EDGE_MS) {
          setWindow(Date.now() - width, Date.now());
        }
      } finally {
        liveBusy = false;
      }
    }, 3000);

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      disposed = true;
      clearInterval(liveTimer);
      clearTimeout(fetchTimer);
      ro.disconnect();
      chart.dispose();
      apiRef.current = null;
    };
  }, [cardKey, sn, isRest, color]);

  const cardBody = (
    <div className={`card plug-card${offline ? " plug-offline" : ""}`}>
      <div className="plug-card-head">
        <div className="plug-card-title">
          <span className="plug-name">{title}</span>
          {subtitle && <span className="plug-sub">{subtitle}</span>}
        </div>
        <div className="plug-card-stats">
          <span className="plug-watts">
            {offline ? t("plugs.offline") : watts != null ? `${Math.round(watts)} W` : "—"}
          </span>
          {todayKwh != null && <span className="plug-kwh">{todayKwh.toFixed(2)} kWh {t("plugs.today")}</span>}
        </div>
      </div>
      {/* Span buttons + chart must not toggle the aggregate flip
          (2026-10-12): FlipTile flips on any inner click — only the header
          area is meant to flip. */}
      <div className="controls" onClick={(e) => e.stopPropagation()}>
        {SHORTCUTS.map((s) => (
          <button
            key={s.labelKey}
            className={activeSpan === s.ms ? "span-active" : ""}
            onClick={() => apiRef.current?.setSpan(s.ms)}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </div>
      <div className="plug-chart" ref={ref} onClick={(e) => aggregate && e.stopPropagation()} />
    </div>
  );

  // Aggregate cards (2026-10-12 — "house light" sums many metering
  // devices; 2026-10-16 — named plug groups like "cooking" too): flippable,
  // the back face lists the sub-consumers with their values for the card's
  // selected span. The members endpoint rides on the plug payload
  // (membersUrl) so any aggregate can point at its own source.
  if (aggregate) {
    return (
      <FlipTile back={(flipped) => <AggregateBack activeSpanMs={activeSpan} visible={flipped} membersUrl={membersUrl} t={t} />}>
        {cardBody}
      </FlipTile>
    );
  }
  return cardBody;
}

// Back face of an aggregate card (2026-10-12, user request — "house light"
// is a collection): every sub-consumer with its current watts and its kWh
// over the card's selected span, biggest first (same ordering rule as the
// Consume list face).
function AggregateBack({ activeSpanMs, visible, membersUrl, t }) {
  // Snapped 30 s window (2026-10-12 review): Date.now() in render made a
  // NEW url on every render — usePolledResource treated each as a fresh
  // resource and refetched constantly. The snap also lets the 60 s TTL
  // cache actually hit on re-flip.
  const [from, to] = useMemo(() => {
    const end = Math.ceil(Date.now() / 30000) * 30000;
    return [end - (activeSpanMs ?? 24 * 3600 * 1000), end];
  }, [activeSpanMs]);
  const { data } = usePolledResource(`${membersUrl ?? "/api/hmip/devices"}?from=${from}&to=${to}`, {
    intervalMs: 30000,
    enabled: visible, // both flip faces stay mounted — poll only when seen
    cacheTtlMs: 60000,
  });
  const devices = data?.devices ?? [];
  if (!devices.length) return <p className="muted">{t("common.loading")}</p>;
  return (
    <div className="aggregate-back">
      <p className="aggregate-back-title muted">{t("plugs.devicesTitle", { n: devices.length })}</p>
      <div className="src-rows">
        {devices.map((d) => (
          <div className="src-row" key={d.sn}>
            <span className="src-label">
              {d.name}
              {d.room && <span className="aggregate-room muted"> · {d.room}</span>}
            </span>
            <span className="src-value">
              <span className="aggregate-watts muted">{d.wattsNow != null ? `${Math.round(d.wattsNow)} W` : "—"}</span>
              <span className="src-kwh">{d.kwh.toFixed(2)} kWh</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PlugsTab() {
  const t = useT();
  const { data: live, error } = usePolledResource("/api/plugs", {
    intervalMs: 3000,
    keepLastGoodOnError: true,
    cacheTtlMs: 3000,
  });

  if (error && !live) return <p className="error">{String(error)}</p>;
  if (!live) return <p>{t("common.loading")}</p>;

  const plugs = [...(live.plugs ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (!plugs.length) return <p className="plug-empty">{t("plugs.empty")}</p>;

  return (
    <section>
      <div className="plug-cards">
        {plugs.map((p, i) => (
          <PlugCard
            key={p.sn}
            cardKey={p.sn}
            sn={p.sn}
            isRest={false}
            title={p.name}
            subtitle={p.typeTag && p.typeTag !== "Smart Plug" ? p.typeTag : p.tag}
            color={plugColor(p, i)}
            watts={p.watts}
            todayKwh={live.todayKwh?.[p.sn]}
            offline={!p.online}
            aggregate={p.external === true}
            membersUrl={p.membersUrl ?? null}
            t={t}
          />
        ))}
        <PlugCard
          cardKey="rest"
          isRest={true}
          title={t("plugs.rest")}
          subtitle={t("plugs.restSub")}
          color={REST_COLOR}
          watts={null}
          todayKwh={null}
          offline={false}
          t={t}
        />
      </div>
      <p className="plug-note">{t("plugs.note")}</p>
    </section>
  );
}
