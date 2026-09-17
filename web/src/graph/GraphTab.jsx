import { useEffect, useRef, useState } from "react";
import echarts from "../echarts.js";
import UpdatedStamp from "../components/UpdatedStamp.jsx";

// Three focused graphs on Apache ECharts, each with its OWN window controls:
//   1. Home Power Usage — consumption coverage (Grid / PV→home / Battery↔home,
//      stacked, Home line on top)
//   2. Power Production — PV production and its split (→ battery / → home)
//   3. Battery — charging vs discharging
// Span buttons and zoom/pan are PER GRAPH (independent windows). No range
// sliders for now.
const SHORTCUTS = [
  { label: "1h", ms: 3600 * 1000 },
  { label: "6h", ms: 6 * 3600 * 1000 },
  { label: "12h", ms: 12 * 3600 * 1000 },
  { label: "24h", ms: 24 * 3600 * 1000 },
  { label: "7d", ms: 7 * 24 * 3600 * 1000 },
  { label: "30d", ms: 30 * 24 * 3600 * 1000 },
];

const LIVE_EDGE_MS = 2 * 60 * 1000; // consider "live" when right edge within 2 min of now

// Row derivations, validated 2026-09-13 (inverter output includes the PV
// pass-through; PV splits exactly into charge + pass-through).
const pvHomeOf = (r) => ((r.battOut ?? 0) > 0 ? Math.max(0, (r.pv ?? 0) - (r.battChg ?? 0)) : 0);
const pvBattOf = (r) => Math.min(r.pv ?? 0, r.battChg ?? 0);
// NET cells power: inverter out minus the PV pass-through, minus charge.
// A battery can't charge and discharge its cells at once — bucket averages
// over oscillating states must net, or the graphs show both at once
// (reported 2026-09-15: battery graph showed charging AND discharging).
const cellsNetOf = (r) => (r.battOut ?? 0) - pvHomeOf(r) - (r.battChg ?? 0);
const battCellsOf = (r) => Math.max(0, cellsNetOf(r)); // discharging cells
const battChgNetOf = (r) => Math.min(0, cellsNetOf(r)); // charging cells (neg)
const homeOf = (r) => (r.grid == null ? null : (r.grid ?? 0) + Math.max(r.battOut ?? 0, 0));

// Series per graph. `key` is either a raw row field or one of the derived
// names above; negated series render as sinks below zero.
const GRAPHS = [
  {
    title: "Home Power Usage",
    legend: ["Grid", "PV", "Battery out", "Home", "Grid range"],
    series: [
      { key: "gridMin", name: "Grid range", color: "#f7a44f44", width: 1, silent: true },
      { key: "gridMax", name: "Grid range", color: "#f7a44f44", width: 1, silent: true },
      { key: "grid", name: "Grid", color: "#f7a44f", width: 1, stack: "u" },
      { key: "pvHome", name: "PV", color: "#5fce80", width: 1, stack: "u" },
      { key: "battCells", name: "Battery out", color: "#c084fc", width: 1, stack: "u" },
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
      // Cells-net like G1: only one side can be nonzero (never both).
      { key: "battCells", name: "Discharging", color: "#c084fc", width: 1, area: true },
      { key: "battChgNeg", name: "Charging", color: "#8a63d2", width: 1, area: true },
    ],
  },
];

// "Home" is the only series that SUMS two independently-polled feeds: the
// fast local grid meter (~5 s) and the battery's own reported output, which
// can lag the real power flow by up to ~1 min (device + cloud relay — see
// power-plan.js's STEP_UP_HOLD_MS comment). A fast preset/strategy change
// shows up in the grid meter before the battery's OWN telemetry catches up,
// producing a momentary dip-then-bump that isn't a real consumption change
// (2026-09-17, user report — see AGENTS.md). A light 1-2-1 weighted moving
// average smooths that seam without blurring genuinely fast GRID transients
// (still shown raw via the separate Grid range envelope, untouched here) or
// the single-source battery/PV series (no cross-feed lag to smooth there).
function smoothHome(values) {
  return values.map((v, i) => {
    if (v == null) return v;
    const prev = values[i - 1];
    const next = values[i + 1];
    if (prev == null || next == null) return v;
    return Math.round(((prev + v * 2 + next) / 4) * 100) / 100;
  });
}

function rowValue(key, r, envelopeOn) {
  switch (key) {
    case "pvHome":
      return pvHomeOf(r);
    case "pvBatt":
      return pvBattOf(r);
    case "battCells":
      return battCellsOf(r);
    case "battChgNeg":
      return battChgNetOf(r);
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
  const apiRefs = useRef(GRAPHS.map(() => null)); // per-graph { setSpan(ms) }
  // Per-graph UI state: stats line + which span preset is highlighted.
  const [statsArr, setStatsArr] = useState(GRAPHS.map(() => null));
  const [activeArr, setActiveArr] = useState(GRAPHS.map(() => 24 * 3600 * 1000));
  const [lastLiveAt, setLastLiveAt] = useState(null); // last successful live tick

  useEffect(() => {
    // Height comes from CSS (.chart-box-sm, incl. landscape rule) so rotation
    // resizes via the ResizeObservers — no width/height at init (pinned-size
    // rotation bug 2026-09-12).
    const isPhone = window.matchMedia("(max-width: 600px)").matches;

    // Each graph is a self-contained unit: its own chart, rows, window,
    // fetch/load cycle and live tick. Nothing is shared between graphs.
    const units = GRAPHS.map((def, gi) => {
      const chart = echarts.init(containerRefs[gi].current, null, { renderer: "canvas" });
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

      let fetchTimer = null;
      let programmatic = false;
      let liveBusy = false;

      function visibleWindow() {
        const dz = chart.getOption().dataZoom?.[0];
        if (dz?.startValue != null && dz?.endValue != null) {
          return [Number(dz.startValue), Number(dz.endValue)];
        }
        return null;
      }

      function setWindow(fromMs, toMs) {
        programmatic = true;
        chart.dispatchAction({
          type: "dataZoom",
          startValue: Math.round(fromMs),
          endValue: Math.round(toMs),
        });
        programmatic = false;
      }

      const rowsRef = { rows: [], bucketMs: 5000 };
      let fetchSeq = 0;

      function applyRows(rows) {
        // Resolution-aware envelope: collapse to the mean above 5-min buckets.
        const envelopeOn = rowsRef.bucketMs <= 5 * 60 * 1000;
        const homeSmoothed = smoothHome(rows.map((r) => rowValue("home", r, envelopeOn)));
        chart.setOption({
          series: def.series.map((s) => ({
            name: s.name,
            data:
              s.key === "home"
                ? rows.map((r, i) => [r.t, homeSmoothed[i]])
                : rows.map((r) => [r.t, rowValue(s.key, r, envelopeOn)]),
          })),
        });
      }

      function updateStats(rows, bucketMs) {
        const grids = rows.map((r) => r.grid).filter((v) => v != null);
        const los = rows.map((r) => r.gridMin).filter((v) => v != null);
        const his = rows.map((r) => r.gridMax).filter((v) => v != null);
        setStatsArr((arr) =>
          arr.map((s, i) =>
            i === gi
              ? grids.length
                ? {
                    avg: Math.round(grids.reduce((a, b) => a + b, 0) / grids.length),
                    min: Math.round(Math.min(...los)),
                    max: Math.round(Math.max(...his)),
                    bucketMs,
                  }
                : null
              : s,
          ),
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
        if (!payload || seq !== fetchSeq) return;
        rowsRef.rows = payload.data;
        rowsRef.bucketMs = payload.bucketMs;
        applyRows(payload.data);
        updateStats(payload.data, payload.bucketMs);
      }

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
        const win = visibleWindow();
        if (win) {
          const span = win[1] - win[0];
          const match = SHORTCUTS.find((s) => Math.abs(span - s.ms) / s.ms < 0.02);
          setActiveArr((arr) => arr.map((a, i) => (i === gi ? (match?.ms ?? null) : a)));
        }
      });

      const unit = {
        async setSpan(ms) {
          const to = Date.now();
          const from = to - ms;
          await loadRange(from, to);
          setWindow(from, to);
          setActiveArr((arr) => arr.map((a, i) => (i === gi ? ms : a)));
        },
      };
      apiRefs.current[gi] = unit;

      // Initial view: last 24 h.
      unit.setSpan(24 * 3600 * 1000);

      // Keep the view fresh while watching the live edge.
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
          setLastLiveAt(Date.now());
          if (payload && payload.data.length) {
            const cutoff = Date.now() - width * 1.5;
            const byT = new Map();
            for (const r of rowsRef.rows) if (r.t >= cutoff) byT.set(r.t, r);
            for (const r of payload.data) byT.set(r.t, r);
            rowsRef.rows = [...byT.values()].sort((a, b) => a.t - b.t);
            applyRows(rowsRef.rows);
            updateStats(rowsRef.rows, rowsRef.bucketMs);
          }
          // Only slide the window if the right edge is still at the live edge.
          const win2 = visibleWindow();
          if (win2 && win2[1] >= Date.now() - LIVE_EDGE_MS) {
            setWindow(Date.now() - width, Date.now());
          }
        } finally {
          liveBusy = false;
        }
      }, 5000);

      const onVisible = () => {
        if (document.visibilityState === "visible") scheduleLoad();
      };
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onVisible);

      const resizeObserver = new ResizeObserver(() => chart.resize());
      resizeObserver.observe(containerRefs[gi].current);

      return {
        dispose() {
          clearInterval(liveTimer);
          clearTimeout(fetchTimer);
          document.removeEventListener("visibilitychange", onVisible);
          window.removeEventListener("focus", onVisible);
          resizeObserver.disconnect();
          chart.dispose();
        },
      };
    });

    return () => {
      for (const u of units) u.dispose();
      apiRefs.current = GRAPHS.map(() => null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <UpdatedStamp at={lastLiveAt} />
      {GRAPHS.map((def, i) => (
        <section key={def.title}>
          <h4>{def.title}</h4>
          <div className="controls">
            {SHORTCUTS.map((s) => (
              <button
                key={s.label}
                className={activeArr[i] === s.ms ? "span-active" : ""}
                onClick={() => apiRefs.current[i]?.setSpan(s.ms)}
              >
                {s.label}
              </button>
            ))}
            <button
              onClick={() => apiRefs.current[i]?.setSpan(24 * 3600 * 1000)}
              title="Back to the last 24 hours"
            >
              Reset
            </button>
            {statsArr[i] && (
              <span className="muted" style={{ marginLeft: "auto" }}>
                avg {statsArr[i].avg} W ·{" "}
                {statsArr[i].bucketMs < 60000
                  ? `${statsArr[i].bucketMs / 1000}s`
                  : `${(statsArr[i].bucketMs / 60000).toFixed(1)}min`}{" "}
                res
              </span>
            )}
          </div>
          <div ref={containerRefs[i]} className="chart-box-sm" />
        </section>
      ))}
      <p className="muted">drag to pan · scroll to zoom — each graph has its own window</p>
    </div>
  );
}
