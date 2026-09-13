import { useEffect, useRef, useState } from "react";
import echarts from "../echarts.js";

// Unified power chart on Apache ECharts.
//
// Why ECharts: its `time` axis is truly continuous (gaps = nulls, no filler
// points needed) and dataZoom (wheel/drag + range slider) works by value, so
// span buttons and live updates are exact — data and zoom state are managed
// independently by the library, no manual range restore hacks.
//
// Data comes from /api/timeseries, bucketed server-side to the visible
// window; refetched (debounced) on every zoom/pan so resolution follows zoom.
const SERIES = [
  // Envelope first so the main lines draw on top. Where the window is covered
  // by local 5 s samples, gridMin/gridMax show the real per-bucket fluctuation
  // of the grid total (= phase sum); cloud-only history stays flat. Both share
  // the name "Grid range" so ONE legend entry toggles them together.
  // Resolution-aware (applyRows): collapsed to the mean above 5-min buckets —
  // at coarse zoom the absolute min/max aliases into unrepresentative needles.
  { key: "gridMin", name: "Grid range", color: "#f7a44f44", width: 1, silent: true },
  { key: "gridMax", name: "Grid range", color: "#f7a44f44", width: 1, silent: true },
  // ONE stack of SOURCES feeding the house (Home Assistant energy-dashboard
  // model): grid phases at the bottom, then battery CELLS output, then the
  // FULL PV production on top. Battery charging draws below the baseline as
  // a separate sink (negative "Battery in") — so every scenario reads at a
  // glance: PV→battery (green band + purple sink), battery→house (purple
  // band), PV→house (green band, no sink), PV→both (band + sink), and the
  // Home line (grid + inverter output) stays the authoritative total.
  { key: "l1", name: "L1", color: "#4f8ef7", width: 1, stack: "home" },
  { key: "l2", name: "L2", color: "#7ab0ff", width: 1, stack: "home" },
  { key: "l3", name: "L3", color: "#b3ccff", width: 1, stack: "home" },
  { key: "battCells", name: "Battery out", color: "#c084fc", width: 1, stack: "home" },
  { key: "pv", name: "PV", color: "#5fce80", width: 1, stack: "home" },
  // Battery charging (PV→cells, or grid→cells) — rendered NEGATIVE (sink).
  { key: "battChg", name: "Battery in", color: "#8a63d2", width: 1 },
  // Explicit home-consumption line (grid + battery inverter output).
  { key: "home", name: "Home", color: "#e8ecef", width: 2 },
];

const SHORTCUTS = [
  { label: "1h", ms: 3600 * 1000 },
  { label: "6h", ms: 6 * 3600 * 1000 },
  { label: "24h", ms: 24 * 3600 * 1000 },
  { label: "7d", ms: 7 * 24 * 3600 * 1000 },
  { label: "30d", ms: 30 * 24 * 3600 * 1000 },
];

const LIVE_EDGE_MS = 2 * 60 * 1000; // consider "live" when right edge within 2 min of now

export default function GraphTab() {
  const containerRef = useRef(null);
  const apiRef = useRef(null); // { setSpan(ms) } for the span buttons
  const [stats, setStats] = useState(null); // {avg, min, max, bucketMs}
  // Which span preset the current window matches (null when zoomed/panned to
  // a custom range) — drives the highlighted shortcut button.
  const [activeMs, setActiveMs] = useState(24 * 3600 * 1000);

  useEffect(() => {
    // Smaller chart + scrollable legend on phones; touch pinch/drag zoom is
    // built into ECharts' inside dataZoom, nothing extra needed there.
    // Height comes from CSS (.chart-box, incl. landscape rule) so rotation
    // resizes via the ResizeObserver below — no JS re-init needed.
    // Do NOT pass width/height to init: ECharts stores them in its opts and
    // every later chart.resize() would re-apply the pinned init size instead
    // of measuring the container (rotation bug 2026-09-12).
    const isPhone = window.matchMedia("(max-width: 600px)").matches;
    const chart = echarts.init(containerRef.current, null, {
      renderer: "canvas",
    });

    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: isPhone
        ? // Phones: full-bleed plot — y labels drawn INSIDE the chart instead
          // of a right gutter, so the graph spans edge to edge.
          { top: 44, right: 2, bottom: 40, left: 2, containLabel: false }
        : { top: 28, right: 60, bottom: 40, left: 10, containLabel: true },
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
          fontSize: 11,
          hideOverlap: true, // prevents crammed labels on narrow screens
          formatter: (ts) => {
            const d = new Date(ts);
            // Multi-day windows need the date, not just the clock time.
            const win = chart.getOption().dataZoom?.[0];
            const spanMs =
              win?.startValue != null ? Number(win.endValue) - Number(win.startValue) : 0;
            return spanMs > 24 * 3600 * 1000
              ? d.toLocaleDateString([], { day: "numeric", month: "short" }) +
                  " " +
                  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : d.toLocaleTimeString();
          },
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        position: "right",
        scale: true,
        axisLabel: {
          color: "#8b98a5",
          fontSize: 11,
          formatter: (v) => `${v} W`,
          inside: isPhone, // labels inside the plot on phones (full-bleed)
        },
        splitLine: { lineStyle: { color: "#2a323866" } },
      },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        {
          type: "slider",
          xAxisIndex: 0,
          filterMode: "none",
          height: 18,
          bottom: 4,
          borderColor: "#2a3238",
          backgroundColor: "#1a2128",
          fillerColor: "#f7a44f22",
          handleStyle: { color: "#f7a44f" },
          textStyle: { color: "#8b98a5", fontSize: 10 },
        },
      ],
      series: SERIES.map((s) => ({
        name: s.name ?? s.key,
        type: "line",
        yAxisIndex: s.yAxis ?? 0,
        showSymbol: false,
        connectNulls: false,
        silent: !!s.silent,
        stack: s.stack,
        lineStyle: { color: s.color, width: s.width },
        itemStyle: { color: s.color },
        areaStyle: s.stack ? { color: `${s.color}44` } : undefined,
        emphasis: { disabled: true },
        data: [],
      })),
      legend: {
        top: 0,
        left: 0,
        type: "scroll", // arrows when it doesn't fit (phones)
        textStyle: { color: "#8b98a5", fontSize: 11 },
        icon: "roundRect",
        itemWidth: 12,
        itemHeight: 8,
        inactiveColor: "#5a6672",
        data: ["L1", "L2", "L3", "Battery out", "Battery in", "PV", "Home", "Grid range"],
        // All on by default: phases at the bottom of the stack, Battery out +
        // PV on top, Battery in as the sink below zero, Home line above
        // everything. Click legend entries to toggle.
        selected: {
          L1: true,
          L2: true,
          L3: true,
          "Battery out": true,
          "Battery in": true,
          PV: true,
          Home: true,
          "Grid range": true,
        },
      },
    });

    let fetchTimer = null;
    let programmatic = false; // true while we shift the window programmatically
    let liveBusy = false; // skip overlapping live ticks

    // Current visible window in ms (absolute values; null before first zoom).
    function visibleWindow() {
      const dz = chart.getOption().dataZoom?.[0];
      if (dz?.startValue != null && dz?.endValue != null) {
        return [Number(dz.startValue), Number(dz.endValue)];
      }
      return null;
    }

    function setWindow(fromMs, toMs) {
      programmatic = true; // don't let our own shift trigger a full refetch
      chart.dispatchAction({
        type: "dataZoom",
        startValue: Math.round(fromMs),
        endValue: Math.round(toMs),
      });
      programmatic = false;
    }

    // Current rows are kept in JS so live updates can append a few points
    // instead of replacing the whole dataset (which caused visible flicker).
    const rowsRef = { rows: [], bucketMs: 5000 };
    let fetchSeq = 0; // stale-response guard: only the newest fetch may apply

    function applyRows(rows) {
      // Resolution-aware envelope (best practice): per-bucket min/max is
      // informative at fine zoom but renders as unrepresentative needles at
      // coarse buckets (sparse ~30 s sampling aliases cycling loads). Above
      // 5 min buckets it collapses to the mean — the trend is the story.
      const envelopeOn = rowsRef.bucketMs <= 5 * 60 * 1000;
      chart.setOption({
        series: SERIES.map((s) => ({
          name: s.name ?? s.key,
          data:
            s.key === "battCells"
              ? rows.map((r) => {
                  if (r.battOut == null) return [r.t, null];
                  // Cells-only output: the inverter output includes the PV
                  // pass-through (pvW − chargeW while outputting) — subtract
                  // it or PV energy counts twice (validated 2026-09-13).
                  const pvHome = r.battOut > 0 ? Math.max(0, (r.pv ?? 0) - (r.battChg ?? 0)) : 0;
                  return [r.t, Math.max(0, r.battOut - pvHome)];
                })
              : s.key === "battChg"
                ? rows.map((r) => (r.battChg == null ? [r.t, null] : [r.t, -r.battChg]))
                : s.key === "home"
                  ? rows.map((r) =>
                      r.grid == null
                        ? [r.t, null]
                        // home = grid + inverter output (battOut; PV is inside
                        // it — never add pv on top, model validated 2026-09-13).
                        : [r.t, (r.grid ?? 0) + Math.max(r.battOut ?? 0, 0)],
                    )
                  : (s.key === "gridMin" || s.key === "gridMax") && !envelopeOn
                    ? rows.map((r) => [r.t, r.grid])
                    : rows.map((r) => [r.t, r[s.key]]),
        })),
      });
    }

    function updateStats(rows, bucketMs) {
      const grids = rows.map((r) => r.grid).filter((v) => v != null);
      const los = rows.map((r) => r.gridMin).filter((v) => v != null);
      const his = rows.map((r) => r.gridMax).filter((v) => v != null);
      setStats(
        grids.length
          ? {
              avg: Math.round(grids.reduce((a, b) => a + b, 0) / grids.length),
              min: Math.round(Math.min(...los)),
              max: Math.round(Math.max(...his)),
              bucketMs,
            }
          : null,
      );
    }

    async function fetchTimeseries(params) {
      try {
        const payload = await fetch(`/api/timeseries?${params}`).then((r) => r.json());
        return payload.ok ? payload : null;
      } catch {
        return null; // backend unreachable — keep old data
      }
    }

    async function loadRange(fromMs, toMs, viewMs = toMs - fromMs) {
      // `viewMs` = the window the user actually sees (may be narrower than
      // the padded fetch range) so resolution targets the visible span.
      const seq = ++fetchSeq;
      const payload = await fetchTimeseries(
        `from=${Math.round(fromMs)}&to=${Math.round(toMs)}&points=800&view=${Math.round(viewMs)}`,
      );
      if (!payload || seq !== fetchSeq) return; // a newer fetch superseded us
      rowsRef.rows = payload.data;
      rowsRef.bucketMs = payload.bucketMs;
      // Data and zoom are independent in ECharts: replacing series data does
      // not move the user's window — no restore hacks needed.
      applyRows(payload.data);
      updateStats(payload.data, payload.bucketMs);
    }

    // Refetch at a resolution matching the current window (debounced), with
    // padding on both sides so panning feels instant.
    function loadVisible() {
      const win = visibleWindow();
      if (!win) return;
      const [fromMs, toMs] = win;
      const pad = (toMs - fromMs) / 2;
      loadRange(fromMs - pad, toMs + pad, toMs - fromMs);
    }

    function scheduleLoad() {
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(loadVisible, 250);
    }

    chart.on("datazoom", () => {
      if (programmatic) return;
      scheduleLoad();
      // User zoomed/panned: highlight the matching preset, if any (2% slack
      // — the live edge slides the window slightly between refreshes).
      const win = visibleWindow();
      if (win) {
        const span = win[1] - win[0];
        const match = SHORTCUTS.find((s) => Math.abs(span - s.ms) / s.ms < 0.02);
        setActiveMs(match?.ms ?? null);
      }
    });

    // Span shortcut: fetch the span's data, then set the window by value —
    // exact, no clamping-to-data games.
    apiRef.current = {
      async setSpan(ms) {
        const to = Date.now();
        const from = to - ms;
        await loadRange(from, to);
        setWindow(from, to);
        setActiveMs(ms);
      },
    };

    // Initial view: last 24 h.
    apiRef.current.setSpan(24 * 3600 * 1000);

    // Keep the view fresh while watching the live edge: fetch only the NEW
    // points since the last bucket and append them, then slide the window
    // forward. Parked views in the past are left alone.
    const liveTimer = setInterval(async () => {
      if (liveBusy) return;
      const win = visibleWindow();
      if (!win) return;
      const [fromMs, toMs] = win;
      if (toMs < Date.now() - LIVE_EDGE_MS) return;
      liveBusy = true;
      try {
        const width = toMs - fromMs;
        const lastT = rowsRef.rows.length ? rowsRef.rows[rowsRef.rows.length - 1].t : fromMs;
        const payload = await fetchTimeseries(
          `from=${lastT + 1}&to=${Date.now()}&bucket=${rowsRef.bucketMs}`,
        );
        if (payload && payload.data.length) {
          // Merge by timestamp (dedupe), keeping ~1.5 windows of history —
          // robust against a full refetch landing while this tick was flying.
          const cutoff = Date.now() - width * 1.5;
          const byT = new Map();
          for (const r of rowsRef.rows) if (r.t >= cutoff) byT.set(r.t, r);
          for (const r of payload.data) byT.set(r.t, r);
          rowsRef.rows = [...byT.values()].sort((a, b) => a.t - b.t);
          applyRows(rowsRef.rows);
          updateStats(rowsRef.rows, rowsRef.bucketMs);
        }
        // The user may have panned away while the fetch was in flight —
        // only slide the window if the right edge is still at the live edge.
        const win2 = visibleWindow();
        if (win2 && win2[1] >= Date.now() - LIVE_EDGE_MS) {
          setWindow(Date.now() - width, Date.now());
        }
      } finally {
        liveBusy = false;
      }
    }, 5000);

    // Background tabs get their timers throttled (Chrome: ~1/min), so the
    // live window falls behind while hidden. On return, do an immediate full
    // refresh of the current window instead of crawling back 5 s at a time.
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleLoad();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(containerRef.current);

    return () => {
      clearInterval(liveTimer);
      clearTimeout(fetchTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      resizeObserver.disconnect();
      apiRef.current = null;
      chart.dispose();
    };
  }, []);

  return (
    <div>
      <div className="controls">
        {SHORTCUTS.map((s) => (
          <button
            key={s.label}
            className={activeMs === s.ms ? "span-active" : ""}
            onClick={() => apiRef.current?.setSpan(s.ms)}
          >
            {s.label}
          </button>
        ))}
        <button
          onClick={() => apiRef.current?.setSpan(24 * 3600 * 1000)}
          title="Back to the last 24 hours"
        >
          Reset
        </button>
        {stats && (
          <span className="muted" style={{ marginLeft: "auto" }}>
            avg {stats.avg} W · min {stats.min} W · max {stats.max} W ·{" "}
            {stats.bucketMs < 60000
              ? `${stats.bucketMs / 1000}s`
              : `${(stats.bucketMs / 60000).toFixed(1)}min`}{" "}
            resolution
          </span>
        )}
      </div>
      <div ref={containerRef} className="chart-box" />
      <p className="muted">drag to pan · scroll to zoom · drag the slider below the chart</p>
    </div>
  );
}
