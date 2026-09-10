import { useEffect, useRef, useState } from "react";
import echarts from "./echarts.js";

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
  // by local 5 s samples, gridLo/gridHi show the real per-bucket fluctuation;
  // cloud-only history stays a flat line. Not in the legend, always on.
  { key: "gridHi", color: "#f7a44f44", width: 1, silent: true },
  { key: "gridLo", color: "#f7a44f44", width: 1, silent: true },
  // Phases as a stacked area: the top of the stack IS the cumulative total
  // (stacked areas are the standard for part-to-whole power views). Toggled
  // via the ECharts legend, hidden by default.
  { key: "l1", name: "L1", color: "#4f8ef7", width: 1, stack: "ph" },
  { key: "l2", name: "L2", color: "#7ab0ff", width: 1, stack: "ph" },
  { key: "l3", name: "L3", color: "#b3ccff", width: 1, stack: "ph" },
  { key: "grid", name: "Grid total", color: "#f7a44f", width: 2, area: true },
  { key: "solar", name: "Solar", color: "#5fce80", width: 1 },
];

const SHORTCUTS = [
  { label: "1h", ms: 3600 * 1000 },
  { label: "6h", ms: 6 * 3600 * 1000 },
  { label: "24h", ms: 24 * 3600 * 1000 },
  { label: "7d", ms: 7 * 24 * 3600 * 1000 },
  { label: "30d", ms: 30 * 24 * 3600 * 1000 },
];

const LIVE_EDGE_MS = 2 * 60 * 1000; // consider "live" when right edge within 2 min of now

export default function TimeSeriesChart() {
  const containerRef = useRef(null);
  const apiRef = useRef(null); // { setSpan(ms) } for the span buttons
  const [stats, setStats] = useState(null); // {avg, min, max, bucketMs}

  useEffect(() => {
    // Smaller chart + scrollable legend on phones; touch pinch/drag zoom is
    // built into ECharts' inside dataZoom, nothing extra needed there.
    const isPhone = window.matchMedia("(max-width: 600px)").matches;
    const chartHeight = isPhone ? 240 : 340;
    const chart = echarts.init(containerRef.current, null, {
      renderer: "canvas",
      width: containerRef.current.clientWidth,
      height: chartHeight,
    });

    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: {
        top: isPhone ? 44 : 28, // legend wraps to two rows on phones
        right: isPhone ? 44 : 60,
        bottom: 40,
        left: 10,
        containLabel: true,
      },
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
          formatter: (ts) => new Date(ts).toLocaleTimeString(),
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        position: "right",
        axisLabel: { color: "#8b98a5", fontSize: 11, formatter: (v) => `${v} W` },
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
        showSymbol: false,
        connectNulls: false,
        silent: !!s.silent,
        stack: s.stack,
        lineStyle: { color: s.color, width: s.width },
        itemStyle: { color: s.color },
        areaStyle: s.area || s.stack ? { color: `${s.color}${s.stack ? "44" : "22"}` } : undefined,
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
        data: ["L1", "L2", "L3", "Grid total", "Solar"],
        // Phases off by default; clicking legend entries toggles them, and
        // the phase stack always sums to the cumulative total.
        selected: { L1: false, L2: false, L3: false, "Grid total": true, Solar: true },
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

    function applyRows(rows) {
      chart.setOption({
        series: SERIES.map((s) => ({
          name: s.name ?? s.key,
          data: rows.map((r) => [r.t, r[s.key]]),
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
      const payload = await fetchTimeseries(
        `from=${Math.round(fromMs)}&to=${Math.round(toMs)}&points=800&view=${Math.round(viewMs)}`,
      );
      if (!payload) return;
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
      if (!programmatic) scheduleLoad();
    });

    // Span shortcut: fetch the span's data, then set the window by value —
    // exact, no clamping-to-data games.
    apiRef.current = {
      async setSpan(ms) {
        const to = Date.now();
        const from = to - ms;
        await loadRange(from, to);
        setWindow(from, to);
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
          // Replace any partial tail bucket, keep ~1.5 windows of history.
          const cutoff = Date.now() - width * 1.5;
          rowsRef.rows = rowsRef.rows
            .filter((r) => r.t < payload.data[0].t && r.t >= cutoff)
            .concat(payload.data);
          applyRows(rowsRef.rows);
          updateStats(rowsRef.rows, rowsRef.bucketMs);
        }
        setWindow(Date.now() - width, Date.now());
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
          <button key={s.label} onClick={() => apiRef.current?.setSpan(s.ms)}>
            {s.label}
          </button>
        ))}
        <button onClick={() => apiRef.current?.setSpan(3600 * 1000)} title="Back to the last hour">
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
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: window.matchMedia("(max-width: 600px)").matches ? 240 : 340,
        }}
      />
      <p className="muted">drag to pan · scroll to zoom · drag the slider below the chart</p>
    </div>
  );
}
