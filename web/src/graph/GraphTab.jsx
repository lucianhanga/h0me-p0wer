import { useEffect, useRef, useState } from "react";
import echarts from "../echarts.js";

// Three focused graphs on Apache ECharts, one shared data manager:
//   1. Home Power Usage — consumption coverage (Grid / PV→home / Battery↔home,
//      stacked, Home line on top)
//   2. Power Production — PV production and its split (→ battery / → home)
//   3. Battery — charging vs discharging
// All three share the visible window: span buttons + zoom/pan on any chart
// move them together. No range sliders for now.
const SHORTCUTS = [
  { label: "1h", ms: 3600 * 1000 },
  { label: "6h", ms: 6 * 3600 * 1000 },
  { label: "24h", ms: 24 * 3600 * 1000 },
  { label: "7d", ms: 7 * 24 * 3600 * 1000 },
  { label: "30d", ms: 30 * 24 * 3600 * 1000 },
];

const LIVE_EDGE_MS = 2 * 60 * 1000; // consider "live" when right edge within 2 min of now

// Row derivations, validated 2026-09-13 (inverter output includes the PV
// pass-through; PV splits exactly into charge + pass-through).
const pvHomeOf = (r) => ((r.battOut ?? 0) > 0 ? Math.max(0, (r.pv ?? 0) - (r.battChg ?? 0)) : 0);
const pvBattOf = (r) => Math.min(r.pv ?? 0, r.battChg ?? 0);
const battCellsOf = (r) => Math.max(0, (r.battOut ?? 0) - pvHomeOf(r));
const homeOf = (r) => (r.grid == null ? null : (r.grid ?? 0) + Math.max(r.battOut ?? 0, 0));

// Series per graph. `key` is either a raw row field or one of the derived
// names above; negated series render as sinks below zero.
const GRAPHS = [
  {
    title: "Home Power Usage",
    legend: ["Grid", "PV", "Battery out", "Battery in", "Home", "Grid range"],
    series: [
      { key: "gridMin", name: "Grid range", color: "#f7a44f44", width: 1, silent: true },
      { key: "gridMax", name: "Grid range", color: "#f7a44f44", width: 1, silent: true },
      { key: "grid", name: "Grid", color: "#f7a44f", width: 1, stack: "u" },
      { key: "pvHome", name: "PV", color: "#5fce80", width: 1, stack: "u" },
      { key: "battCells", name: "Battery out", color: "#c084fc", width: 1, stack: "u" },
      { key: "battChgNeg", name: "Battery in", color: "#8a63d2", width: 1 },
      { key: "home", name: "Home", color: "#e8ecef", width: 2 },
    ],
  },
  {
    title: "Power Production",
    legend: ["PV production", "PV to battery", "PV to home"],
    series: [
      { key: "pvBatt", name: "PV to battery", color: "#3da568", width: 1, stack: "p" },
      { key: "pvHome", name: "PV to home", color: "#8ee3a8", width: 1, stack: "p" },
      { key: "pv", name: "PV production", color: "#5fce80", width: 2 },
    ],
  },
  {
    title: "Battery",
    legend: ["Discharging", "Charging"],
    series: [
      { key: "battOut", name: "Discharging", color: "#c084fc", width: 1, area: true },
      { key: "battChgNeg", name: "Charging", color: "#8a63d2", width: 1, area: true },
    ],
  },
];

function rowValue(key, r, envelopeOn) {
  switch (key) {
    case "pvHome":
      return pvHomeOf(r);
    case "pvBatt":
      return pvBattOf(r);
    case "battCells":
      return battCellsOf(r);
    case "battChgNeg":
      return r.battChg == null ? null : -r.battChg;
    case "home":
      return homeOf(r);
    case "gridMin":
    case "gridMax":
      return envelopeOn ? r[key] : r.grid;
    default:
      return r[key];
  }
}

export default function GraphTab() {
  const containerRefs = GRAPHS.map(() => useRef(null));
  const apiRef = useRef(null); // { setSpan(ms) } for the span buttons
  const [stats, setStats] = useState(null); // {avg, min, max, bucketMs}
  const [activeMs, setActiveMs] = useState(24 * 3600 * 1000);

  useEffect(() => {
    // Height comes from CSS (.chart-box-sm, incl. landscape rule) so rotation
    // resizes via the ResizeObservers — no width/height at init (pinned-size
    // rotation bug 2026-09-12).
    const isPhone = window.matchMedia("(max-width: 600px)").matches;
    const charts = GRAPHS.map((def, i) => {
      const chart = echarts.init(containerRefs[i].current, null, { renderer: "canvas" });
      chart.setOption({
        animation: false,
        backgroundColor: "transparent",
        grid: isPhone
          ? { top: 34, right: 2, bottom: 26, left: 2, containLabel: false }
          : { top: 22, right: 60, bottom: 26, left: 10, containLabel: true },
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
            hideOverlap: true,
            formatter: (ts) => {
              const d = new Date(ts);
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
            inside: isPhone,
          },
          splitLine: { lineStyle: { color: "#2a323866" } },
        },
        // Inside zoom only — no range sliders for now.
        dataZoom: [{ type: "inside", xAxisIndex: 0, filterMode: "none" }],
        series: def.series.map((s) => ({
          name: s.name,
          type: "line",
          showSymbol: false,
          connectNulls: false,
          silent: !!s.silent,
          stack: s.stack,
          lineStyle: { color: s.color, width: s.width },
          itemStyle: { color: s.color },
          areaStyle: s.stack || s.area ? { color: `${s.color}44` } : undefined,
          emphasis: { disabled: true },
          data: [],
        })),
        legend: {
          top: 0,
          left: 0,
          type: "scroll",
          textStyle: { color: "#8b98a5", fontSize: 11 },
          icon: "roundRect",
          itemWidth: 12,
          itemHeight: 8,
          inactiveColor: "#5a6672",
          data: def.legend,
          selected: Object.fromEntries(def.legend.map((n) => [n, true])),
        },
      });
      return chart;
    });

    let fetchTimer = null;
    let programmatic = false; // true while we shift the window programmatically
    let liveBusy = false; // skip overlapping live ticks

    // Current visible window in ms (absolute values; null before first zoom).
    function visibleWindow() {
      const dz = charts[0].getOption().dataZoom?.[0];
      if (dz?.startValue != null && dz?.endValue != null) {
        return [Number(dz.startValue), Number(dz.endValue)];
      }
      return null;
    }

    function setWindow(fromMs, toMs) {
      programmatic = true; // don't let our own shift trigger a full refetch
      for (const chart of charts) {
        chart.dispatchAction({
          type: "dataZoom",
          startValue: Math.round(fromMs),
          endValue: Math.round(toMs),
        });
      }
      programmatic = false;
    }

    // Current rows are kept in JS so live updates can append a few points
    // instead of replacing the whole dataset (which caused visible flicker).
    const rowsRef = { rows: [], bucketMs: 5000 };
    let fetchSeq = 0; // stale-response guard: only the newest fetch may apply

    function applyRows(rows) {
      // Resolution-aware envelope (best practice): per-bucket min/max is
      // informative at fine zoom but renders as unrepresentative needles at
      // coarse buckets. Above 5 min buckets it collapses to the mean.
      const envelopeOn = rowsRef.bucketMs <= 5 * 60 * 1000;
      charts.forEach((chart, i) => {
        chart.setOption({
          series: GRAPHS[i].series.map((s) => ({
            name: s.name,
            data: rows.map((r) => [r.t, rowValue(s.key, r, envelopeOn)]),
          })),
        });
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
      const seq = ++fetchSeq;
      const payload = await fetchTimeseries(
        `from=${Math.round(fromMs)}&to=${Math.round(toMs)}&points=800&view=${Math.round(viewMs)}`,
      );
      if (!payload || seq !== fetchSeq) return; // a newer fetch superseded us
      rowsRef.rows = payload.data;
      rowsRef.bucketMs = payload.bucketMs;
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

    // Zoom/pan on ANY chart moves all three together.
    for (const chart of charts) {
      chart.on("datazoom", () => {
        if (programmatic) return;
        scheduleLoad();
        const win = visibleWindow();
        if (win) {
          setWindow(win[0], win[1]);
          const span = win[1] - win[0];
          const match = SHORTCUTS.find((s) => Math.abs(span - s.ms) / s.ms < 0.02);
          setActiveMs(match?.ms ?? null);
        }
      });
    }

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

    const resizeObserver = new ResizeObserver(() => charts.forEach((c) => c.resize()));
    for (const ref of containerRefs) resizeObserver.observe(ref.current);

    return () => {
      clearInterval(liveTimer);
      clearTimeout(fetchTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      resizeObserver.disconnect();
      apiRef.current = null;
      for (const chart of charts) chart.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      {GRAPHS.map((def, i) => (
        <section key={def.title}>
          <h4>{def.title}</h4>
          <div ref={containerRefs[i]} className="chart-box-sm" />
        </section>
      ))}
      <p className="muted">drag to pan · scroll to zoom — all three graphs move together</p>
    </div>
  );
}
