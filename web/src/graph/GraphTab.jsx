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
    legend: ["Grid", "PV", "Battery out", "Home"],
    series: [
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

// Remembers each graph's selected span across tab switches — GraphTab
// unmounts when the user leaves the tab (see App.jsx's conditional render),
// so component state alone would reset to the 24h default every time they
// come back (user request 2026-09-20). Module-scoped: survives remounts,
// resets only on a full page reload.
const savedSpanMs = GRAPHS.map(() => null);

// Robust axis cap: a rare, narrow spike (a handful of points out of ~800)
// shouldn't set the whole chart's scale and flatten the normal range into a
// thin band near the bottom (screenshot report, 2026-09-21: a brief
// transient to ~2500 W squashed the usual ~200-800 W variation). The 98th
// percentile barely differs from the true max on a genuine sustained peak
// (many points near it stay in the top 2%), but excludes a narrow 1-2-point
// transient — so this self-corrects: an ordinary window is untouched
// (returns null, meaning "let the axis auto-scale as before"), only a real
// outlier gets capped. `values` must already be non-negative (callers pass
// `Math.abs()`'d magnitudes for a signed series' negative side).
//
// A spike only counts as an outlier when it beats the typical range by BOTH
// a ratio AND an absolute margin (2026-09-22, user rule: mostly ~100 W with
// one 1000 W -> outlier; mostly 0 W with one 100-200 W -> NOT an outlier).
// A percentile-only test breaks down exactly on a near-zero baseline
// (verified against live data: a window that's mostly 0 W with a brief
// legit 150 W got capped at 0 W, hiding the real values entirely), and a
// ratio-only test would cap e.g. 500 W baseline + 900 W peak, which is just
// normal house variation. Hence both tests.
const MIN_OUTLIER_DELTA_W = 300; // must be > the user's "100 or 200 over 0" case
const MIN_OUTLIER_RATIO = 2;
function robustCap(values) {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rawMax = sorted[sorted.length - 1];
  const p98 = sorted[Math.min(sorted.length - 1, Math.floor(0.98 * sorted.length))];
  const cap = Math.max(50, Math.ceil((p98 * 1.15) / 50) * 50);
  const isOutlier =
    rawMax > cap &&
    rawMax - p98 >= MIN_OUTLIER_DELTA_W &&
    (p98 <= 0 || rawMax >= p98 * MIN_OUTLIER_RATIO);
  return isOutlier ? { cap, rawMax } : null;
}

function rowValue(key, r) {
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
    default:
      return r[key];
  }
}

export default function GraphTab() {
  const containerRefs = GRAPHS.map(() => useRef(null));
  const apiRefs = useRef(GRAPHS.map(() => null)); // per-graph { setSpan(ms) }
  // Per-graph UI state: stats line + which span preset is highlighted.
  const [statsArr, setStatsArr] = useState(GRAPHS.map(() => null));
  // Per-graph "an outlier is being clipped off the top/bottom of this
  // view" note — see robustCap().
  const [clippedArr, setClippedArr] = useState(GRAPHS.map(() => null));
  const [activeArr, setActiveArr] = useState(() =>
    GRAPHS.map((_, i) => savedSpanMs[i] ?? 24 * 3600 * 1000),
  );
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
              const start = Number(win?.startValue);
              const end = Number(win?.endValue);
              const spanMs = Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
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
          // No `scale: true` — these are stacked-area charts (Home Power
          // Usage, Power Production), where a floor above zero clips the
          // bottom of the first stacked layer and visually inflates the
          // layers above it relative to it (reported 2026-09-20: 1h/6h
          // zoom floored at ~300 W made PV/Battery look far bigger than
          // Grid even though Grid was the larger share). Leaving min/max
          // unset uses ECharts' default "nice round number, zero included"
          // axis instead — same fix, plus round tick labels for free (the
          // scale-mode axis exposed the raw data extremum, e.g. "2453 W").
          // The signed Battery graph still extends below zero as needed.
          splitNumber: 3, // fewer gridlines/labels — keeps it readable at a glance
          axisLabel: {
            color: "#8b98a5",
            fontSize: 11,
            formatter: (v) => `${Math.round(v)} W`,
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
        const start = Number(dz?.startValue);
        const end = Number(dz?.endValue);
        // A stray zoom/pan gesture on an axis with no data extent yet (e.g.
        // right after the tab mounts, before the first load resolves) can
        // hand back NaN start/endValue. Treating that as "no window" — rather
        // than a real [NaN, x] range — stops it from reaching loadRange/the
        // live tick, which would otherwise poll from=NaN forever (2026-09-20).
        return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
      }

      function setWindow(fromMs, toMs) {
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
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
        // The "Grid range" min/max envelope series was REMOVED entirely
        // (2026-09-23, third spike report): with 1 s sampling it amplified
        // every compressor-inrush sample into a needle at every span, and
        // neither threshold-hiding (12h/24h) nor second-extreme trimming
        // (1-3-sample spikes survived) made it calm — the user wants the
        // Anker app's presentation, which shows no sub-minute detail. The
        // mean series already carries real sustained transients (kettle,
        // appliances); gridMin/gridMax stay in the API payload.
        // Home is the RAW sum grid + batteryOut (2026-09-22, user report:
        // "house consumption is not consistent with the grid spikes").
        // smoothHome()'s 1-2-1 average (added 2026-09-17 for the ~1 min
        // cross-feed lag of that era) was dampening REAL appliance spikes
        // by 15-25% now that grid samples at 1 s and battery telemetry
        // arrives every 3 s while watching — the cross-feed artifact it
        // was built to hide is down to 1-2 buckets, far smaller than the
        // real transients it was eating. Exact sum = consistent by
        // construction.
        const homeSeries = rows.map((r) => rowValue("home", r));

        // Robust axis scaling (see robustCap()) — per-graph "envelope": the
        // one series whose height actually determines how tall the chart
        // needs to be. Battery is signed, so its positive (discharge) and
        // negative (charge) sides are capped independently.
        const posCap =
          gi === 0
            ? robustCap(homeSeries)
            : gi === 1
              ? robustCap(rows.map((r) => r.pv))
              : robustCap(rows.map((r) => battCellsOf(r)));
        const negCap = gi === 2 ? robustCap(rows.map((r) => -battChgNetOf(r))) : null;
        setClippedArr((arr) =>
          arr.map((c, i) =>
            i === gi
              ? posCap || negCap
                ? {
                    high: posCap ? Math.round(posCap.rawMax) : null,
                    low: negCap ? -Math.round(negCap.rawMax) : null,
                  }
                : null
              : c,
          ),
        );

        chart.setOption({
          yAxis: {
            max: posCap ? posCap.cap : null,
            min: negCap ? -negCap.cap : null,
          },
          series: def.series.map((s) => ({
            name: s.name,
            data:
              s.key === "home"
                ? rows.map((r, i) => [r.t, homeSeries[i]])
                : rows.map((r) => [r.t, rowValue(s.key, r)]),
          })),
        });
      }

      function updateStats(rows, bucketMs) {
        const grids = rows.map((r) => r.grid).filter((v) => v != null);
        setStatsArr((arr) =>
          arr.map((s, i) =>
            i === gi
              ? grids.length
                ? {
                    avg: Math.round(grids.reduce((a, b) => a + b, 0) / grids.length),
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
          if (match) savedSpanMs[gi] = match.ms;
          setActiveArr((arr) => arr.map((a, i) => (i === gi ? (match?.ms ?? null) : a)));
        }
      });

      const unit = {
        async setSpan(ms) {
          savedSpanMs[gi] = ms;
          const to = Date.now();
          const from = to - ms;
          await loadRange(from, to);
          setWindow(from, to);
          setActiveArr((arr) => arr.map((a, i) => (i === gi ? ms : a)));
        },
      };
      apiRefs.current[gi] = unit;

      // Initial view: the span this graph was last showing, else 24h.
      unit.setSpan(savedSpanMs[gi] ?? 24 * 3600 * 1000);

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
            {clippedArr[i] && (
              <span
                className="muted"
                style={{ marginLeft: statsArr[i] ? 8 : "auto" }}
                title="A brief spike is taller than this view's scale — the line is clipped at the top/bottom so normal variation stays readable."
              >
                · peak{" "}
                {[clippedArr[i].high, clippedArr[i].low]
                  .filter((v) => v != null)
                  .map((v) => `${v} W`)
                  .join(" / ")}{" "}
                (off-scale)
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
