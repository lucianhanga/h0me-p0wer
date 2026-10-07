import { useEffect, useMemo, useRef, useState } from "react";
import echarts from "../echarts.js";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { useT } from "../i18n/LanguageProvider.jsx";
import { robustCap, rowValue, tightAxisBounds } from "./derive.js";
import { immutableBeforeMs, readCached, writeCached } from "../historyCache.js";
import { TEMP_COLD_MAX_C, TEMP_HOT_MIN_C } from "../tempLimits.js";

// Three focused graphs on Apache ECharts, each with its OWN window controls:
//   1. Home Power Usage — consumption coverage (Grid / PV→home / Battery↔home,
//      stacked, Home line on top)
//   2. Power Production — PV production and its split (→ battery / → home)
//   3. Battery — charging vs discharging
// Span buttons and zoom/pan are PER GRAPH (independent windows). No range
// sliders for now. Exported for the Plugs tab (2026-10-06) — its cards use
// the same resolution choices, don't fork the list.
export const SHORTCUTS = [
  { labelKey: "graph.span.1h", ms: 3600 * 1000 },
  { labelKey: "graph.span.6h", ms: 6 * 3600 * 1000 },
  { labelKey: "graph.span.12h", ms: 12 * 3600 * 1000 },
  { labelKey: "graph.span.24h", ms: 24 * 3600 * 1000 },
  { labelKey: "graph.span.7d", ms: 7 * 24 * 3600 * 1000 },
  { labelKey: "graph.span.30d", ms: 30 * 24 * 3600 * 1000 },
];

const LIVE_EDGE_MS = 2 * 60 * 1000; // consider "live" when right edge within 2 min of now

// Row derivations live in ./derive.js — shared with the simple view's
// charts (2026-09-28) so the two can never compute these differently.

// Series per graph. `key` is either a raw row field or one of the derived
// names above; negated series render as sinks below zero. titleKey/nameKey/
// legendKeys are resolved through t() at render time.
const GRAPHS = [
  {
    titleKey: "graph.title.home",
    legendKeys: [
      "graph.series.grid",
      "graph.series.pv",
      "graph.series.battOut",
      "graph.series.home",
      "graph.series.gridExport",
    ],
    series: [
      { key: "grid", nameKey: "graph.series.grid", color: "#f7a44f", width: 1, stack: "u" },
      { key: "pvHome", nameKey: "graph.series.pv", color: "#5fce80", width: 1, stack: "u" },
      { key: "battCells", nameKey: "graph.series.battOut", color: "#c084fc", width: 1, stack: "u" },
      { key: "home", nameKey: "graph.series.home", color: "#e8ecef", width: 2 },
      // Residual grid export below zero (2026-09-23, user request) — with
      // zero-export enforced, this is the honest small remainder that still
      // slips through. NOT stacked — a sink below zero like the Battery
      // chart's Charging series.
      { key: "gridExp", nameKey: "graph.series.gridExport", color: "#e5544b", width: 1 },
    ],
  },
  {
    titleKey: "graph.title.production",
    legendKeys: ["graph.series.pvProduction", "graph.series.pvToBattery", "graph.series.pvToHome"],
    series: [
      { key: "pvBatt", nameKey: "graph.series.pvToBattery", color: "#3da568", width: 1, stack: "p" },
      { key: "pvHome", nameKey: "graph.series.pvToHome", color: "#8ee3a8", width: 1, stack: "p" },
      { key: "pv", nameKey: "graph.series.pvProduction", color: "#5fce80", width: 2 },
    ],
  },
  {
    titleKey: "graph.title.battery",
    legendKeys: ["graph.series.discharging", "graph.series.charging"],
    series: [
      // Cells-net like G1: only one side can be nonzero (never both).
      { key: "battCells", nameKey: "graph.series.discharging", color: "#c084fc", width: 1, area: true },
      { key: "battChgNeg", nameKey: "graph.series.charging", color: "#8a63d2", width: 1, area: true },
    ],
  },
  {
    // Per-module temperature — EVERY battery + extension (2026-09-27): the
    // series are built dynamically from the site's module list (dynamicSeries
    // marks the bucket field prefix: temp__<sn>). REST-only units (SB4) have
    // no temperature channel — they just don't draw a line.
    titleKey: "graph.title.battTemp",
    unit: "°C",
    dynamicSeries: "temp",
    // Threshold lines at the shared comfort bounds (tempLimits.js —
    // 2026-10-02, user request: show the too-cold/too-hot limits ON the graph).
    tempLimits: true,
    series: [],
  },
  {
    // Per-module charge level (SOC %) — every battery + extension.
    titleKey: "graph.title.battSoc",
    unit: "%",
    dynamicSeries: "soc",
    series: [],
  },
];

// Palette for the dynamic per-module series (one color per module, in the
// module list's order — unit 1, unit 2, then expansions).
const MODULE_COLORS = ["#5fce80", "#c084fc", "#6bb8f5", "#f7a44f", "#e5544b", "#8ee3a8"];

// Remembers each graph's selected span across tab switches — GraphTab
// unmounts when the user leaves the tab (see App.jsx's conditional render),
// so component state alone would reset to the 24h default every time they
// come back (user request 2026-09-20). Module-scoped: survives remounts,
// resets only on a full page reload.
const savedSpanMs = GRAPHS.map(() => null);

// robustCap() lives in derive.js (shared with the simple view's
// charts since 2026-10-03) — the comment history moved with it.

export default function GraphTab() {
  const t = useT();
  // The physical module list (every solarbank + expansion pack, keyed by
  // physical SN) for the two dynamic per-module charts — fetched once from
  // /api/battery/params (the same place the Strategy tab's cards read).
  const [modules, setModules] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/battery/params")
      .then((r) => r.json())
      .then((res) => {
        if (cancelled || !res.ok) return;
        const list = (res.data.batteries ?? [])
          .filter((b) => b.member && b.live?.sn)
          .flatMap((b) => [
            { sn: b.live.sn, name: b.live.name ?? b.live.sn },
            ...(b.live.expansions ?? [])
              .filter((e) => e.sn)
              .map((e, i) => ({ sn: e.sn, name: `${b.live.name ?? b.live.sn} ext ${i + 1}` })),
          ]);
        setModules(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // Per-phase view for the Home Power Usage graph (2026-09-27, long-standing
  // ideas item): the timeseries rows already carry l1/l2/l3 — this toggle
  // swaps G1's source series (grid/PV/battery/home) for the three phase
  // lines. The phases are SIGNED (the single-phase inverter feeds L1 while
  // the loads sit on L3 — that's also why the meter's net jitters).
  const [phasesOn, setPhasesOn] = useState(false);
  // Resolved (translated) graph definitions — re-resolved on language change,
  // which also re-inits the charts below so legend/series names follow.
  const graphs = useMemo(
    () =>
      GRAPHS.map((def, gi) => {
        const dynamic = def.dynamicSeries
          ? modules
              .map((m, i) => ({
                key: `${def.dynamicSeries}__${m.sn}`,
                name: m.name,
                color: MODULE_COLORS[i % MODULE_COLORS.length],
                width: 2,
              }))
              // Outside temperature as context on the battery-temperature
              // chart (2026-09-28, user request) — hourly Open-Meteo at the
              // HOME_ADDRESS location, merged into timeseries buckets
              // server-side. Dashed neutral grey so it reads as a reference
              // line, not a fifth module. All-null (no HOME_ADDRESS
              // configured / fetch failed) just draws nothing.
              .concat(
                def.dynamicSeries === "temp"
                  ? [
                      {
                        key: "outsideTempC",
                        name: t("graph.series.outsideTemp"),
                        color: "#90a4ae",
                        width: 1,
                        dashed: true,
                      },
                    ]
                  : [],
              )
          : null;
        return {
          ...def,
          title: t(def.titleKey),
          legend:
            gi === 0 && phasesOn
              ? ["L1", "L2", "L3"]
              : dynamic
                ? dynamic.map((d) => d.name)
                : def.legendKeys.map((k) => t(k)),
          series:
            gi === 0 && phasesOn
              ? [
                  { key: "l1", name: "L1", color: "#f7a44f", width: 2 },
                  { key: "l2", name: "L2", color: "#5fce80", width: 2 },
                  { key: "l3", name: "L3", color: "#c084fc", width: 2 },
                ]
              : dynamic ?? def.series.map((s) => ({ ...s, name: t(s.nameKey) })),
          avgKey: dynamic ? dynamic[0]?.key : def.avgKey,
          unit: def.unit ?? "W",
        };
      }),
    [t, phasesOn, modules],
  );
  const containerRefs = graphs.map(() => useRef(null));
  const apiRefs = useRef(graphs.map(() => null)); // per-graph { setSpan(ms) }
  // Per-graph UI state: stats line + which span preset is highlighted.
  const [statsArr, setStatsArr] = useState(graphs.map(() => null));
  // Per-graph "an outlier is being clipped off the top/bottom of this
  // view" note — see robustCap().
  const [clippedArr, setClippedArr] = useState(graphs.map(() => null));
  const [activeArr, setActiveArr] = useState(() =>
    graphs.map((_, i) => savedSpanMs[i] ?? 24 * 3600 * 1000),
  );
  const [lastLiveAt, setLastLiveAt] = useState(null); // last successful live tick

  useEffect(() => {
    // Height comes from CSS (.chart-box-sm, incl. landscape rule) so rotation
    // resizes via the ResizeObservers — no width/height at init (pinned-size
    // rotation bug 2026-09-12).
    const isPhone = window.matchMedia("(max-width: 600px)").matches;

    // Each graph is a self-contained unit: its own chart, rows, window,
    // fetch/load cycle and live tick. Nothing is shared between graphs.
    const units = graphs.map((def, gi) => {
      const chart = echarts.init(containerRefs[gi].current, null, { renderer: "canvas" });
      chart.setOption({
        animation: false,
        backgroundColor: "transparent",
        grid: isPhone
          ? { top: 34, right: 2, bottom: 26, left: 2, containLabel: false }
          : { top: 22, right: 60, bottom: 26, left: 10, containLabel: true },
        tooltip: {
          trigger: "axis",
          valueFormatter: (v) => (v == null ? "—" : `${Math.round(v)} ${def.unit ?? "W"}`),
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
            formatter: (v) => `${Math.round(v)} ${def.unit ?? "W"}`,
            inside: isPhone,
          },
          splitLine: { lineStyle: { color: "#2a323866" } },
        },
        // Inside zoom only — no range sliders for now.
        // preventDefaultMouseMove: false (2026-10-07, user report from the
        // Consume tab): the inside-zoom roam controller otherwise
        // preventDefaults touchmove-as-mousemove, so a vertical swipe over
        // ANY chart showed the tooltip but never scrolled the page.
        dataZoom: [{ type: "inside", xAxisIndex: 0, filterMode: "none", preventDefaultMouseMove: false }],
        series: def.series.map((s, si) => ({
          name: s.name,
          type: "line",
          showSymbol: false,
          connectNulls: false,
          silent: !!s.silent,
          stack: s.stack,
          lineStyle: { color: s.color, width: s.width, type: s.dashed ? "dashed" : "solid" },
          itemStyle: { color: s.color },
          areaStyle: s.stack || s.area ? { color: `${s.color}44` } : undefined,
          emphasis: { disabled: true },
          // Comfort-bound threshold lines on the temperature chart (attached
          // to its first series): cold limit at 3 °C (charging may be
          // limited), hot limit at 35 °C (lifetime/performance risk) — the
          // SAME bounds the simple view's ⚠ chips use (tempLimits.js).
          markLine:
            def.tempLimits && si === 0
              ? {
                  silent: true,
                  symbol: "none",
                  animation: false,
                  data: [
                    {
                      yAxis: TEMP_COLD_MAX_C,
                      lineStyle: { color: "#6bb8f5", type: "dashed", width: 1 },
                      label: {
                        color: "#6bb8f5",
                        fontSize: 10,
                        position: "insideEndBottom",
                        formatter: t("graph.tempLimit.cold", { t: TEMP_COLD_MAX_C }),
                      },
                    },
                    {
                      yAxis: TEMP_HOT_MIN_C,
                      lineStyle: { color: "#e5544b", type: "dashed", width: 1 },
                      label: {
                        color: "#e5544b",
                        fontSize: 10,
                        position: "insideEndTop",
                        formatter: t("graph.tempLimit.hot", { t: TEMP_HOT_MIN_C }),
                      },
                    },
                  ],
                }
              : undefined,
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
        const seriesData = def.series.map((s) =>
          s.key === "home"
            ? rows.map((r, i) => [r.t, homeSeries[i]])
            : rows.map((r) => [r.t, rowValue(s.key, r)]),
        );

        // Robust axis scaling (see robustCap()) — per-graph "envelope": the
        // per-row max/min across the graph's series (for the stacked charts
        // the home/pv line IS the stack top, so the max covers the stack).
        // Battery is signed, so its positive (discharge) and negative
        // (charge) sides are capped independently.
        // ONLY the three POWER graphs (2026-09-30, user report): the cap ran
        // on the °C/% module charts too, computing a ~610 W battery-cells
        // cap and stretching the axes to 300 °C / 300 % (plus a nonsense
        // "peak 610 W (off-scale)" note). Module charts get fixed sane
        // caps instead — a battery never exceeds 60 °C or 100 %.
        const isModuleChart = gi >= 3;
        const posEnv = rows.map((_, i) => {
          let m = null;
          for (const d of seriesData) {
            const v = d[i][1];
            if (v != null && Number.isFinite(v)) m = m == null ? v : Math.max(m, v);
          }
          return m;
        });
        const negEnv = rows.map((_, i) => {
          let m = null;
          for (const d of seriesData) {
            const v = d[i][1];
            if (v != null && Number.isFinite(v)) m = m == null ? v : Math.min(m, v);
          }
          return m;
        });
        const envOf = (arr) => arr.filter((v) => v != null && Number.isFinite(v));
        const posCap = isModuleChart ? null : robustCap(posEnv);
        // Negative-side capping for ALL power graphs now (2026-10-03 — was
        // Battery-only): a brief export/charge blip stretches the axis floor
        // the same way a spike stretches the top (the 12h screenshot that
        // triggered the tight-axis request had a −1000 W floor from a few
        // export buckets over a 200-800 W night).
        const negCap = isModuleChart ? null : robustCap(negEnv.map((v) => -(v ?? 0)));
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

        // Tight axis bounds for the power graphs (2026-10-03, user request:
        // "make the Y range as small as possible to accommodate the values")
        // — the 2026-09-20 always-include-zero default wasted most of the
        // chart height on typical windows. Capped extrema win over raw ones.
        const posVals = envOf(posEnv);
        const negVals = envOf(negEnv);
        const tight = isModuleChart
          ? null
          : tightAxisBounds(
              negCap ? -negCap.cap : negVals.length ? Math.min(...negVals) : null,
              posCap ? posCap.cap : posVals.length ? Math.max(...posVals) : null,
            );

        chart.setOption({
          yAxis: {
            // Temperature: FIXED −10…+50 °C (2026-10-02, user request —
            // the comfort-bound lines at 3/35 °C need a stable scale to
            // read against); SOC is exactly 0..100.
            max: isModuleChart ? (def.unit === "°C" ? 50 : 100) : (tight?.max ?? null),
            min: isModuleChart ? (def.unit === "°C" ? -10 : 0) : (tight?.min ?? null),
          },
          series: def.series.map((s, si) => ({
            name: s.name,
            data: seriesData[si],
          })),
        });
      }

      function updateStats(rows, bucketMs) {
        // Per-graph average (2026-09-27): was hardcoded to the grid series
        // for every graph — meaningless on the °C/% module tiles ("avg
        // 201 °C"). Power graphs keep the grid average as before; the
        // module tiles average their own first series via avgKey.
        const vals = rows.map((r) => rowValue(def.avgKey ?? "grid", r)).filter((v) => v != null);
        setStatsArr((arr) =>
          arr.map((s, i) =>
            i === gi
              ? vals.length
                ? {
                    avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
                    bucketMs,
                  }
                : null
              : s,
          ),
        );
      }

      // Browser cache for immutable history windows (2026-10-01, user
      // request): a window is cached only when its end lies before
      // yesterday 00:00 local — today/yesterday still get rewritten by the
      // cloud sync loop. Live-edge windows never hit the cache.
      async function fetchTimeseries(params) {
        const url = `/api/timeseries?${params}`;
        const toMs = Number(new URLSearchParams(params).get("to"));
        const immutable = Number.isFinite(toMs) && toMs < immutableBeforeMs();
        if (immutable) {
          const hit = readCached(url);
          if (hit) return hit;
        }
        try {
          const payload = await fetch(url).then((r) => r.json());
          if (payload.ok && immutable) writeCached(url, payload);
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
      apiRefs.current = graphs.map(() => null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphs]);

  return (
    <div>
      <UpdatedStamp at={lastLiveAt} />
      {graphs.map((def, i) => (
        <section key={def.titleKey}>
          <h4>{def.title}</h4>
          <div className="controls">
            {SHORTCUTS.map((s) => (
              <button
                key={s.labelKey}
                className={activeArr[i] === s.ms ? "span-active" : ""}
                onClick={() => apiRefs.current[i]?.setSpan(s.ms)}
              >
                {t(s.labelKey)}
              </button>
            ))}
            {i === 0 && (
              <button
                className={phasesOn ? "span-active" : ""}
                onClick={() => setPhasesOn((v) => !v)}
                title={t("graph.phasesTip")}
              >
                {t("graph.phases")}
              </button>
            )}
            <button
              onClick={() => apiRefs.current[i]?.setSpan(24 * 3600 * 1000)}
              title={t("graph.resetTitle")}
            >
              {t("graph.reset")}
            </button>
            {statsArr[i] && (
              <span className="muted" style={{ marginLeft: "auto" }}>
                {t("graph.avgRes", {
                  avg: statsArr[i].avg,
                  unit: graphs[i].unit ?? "W",
                  res:
                    statsArr[i].bucketMs < 60000
                      ? `${statsArr[i].bucketMs / 1000}s`
                      : `${(statsArr[i].bucketMs / 60000).toFixed(1)}min`,
                })}
              </span>
            )}
            {clippedArr[i] && (
              <span
                className="muted"
                style={{ marginLeft: statsArr[i] ? 8 : "auto" }}
                title={t("graph.offScaleTitle")}
              >
                {t("graph.offScalePeak", {
                  peaks: [clippedArr[i].high, clippedArr[i].low]
                    .filter((v) => v != null)
                    .map((v) => `${v} W`)
                    .join(" / "),
                })}
              </span>
            )}
          </div>
          <div ref={containerRefs[i]} className="chart-box-sm" />
        </section>
      ))}
      <p className="muted">{t("graph.hint")}</p>
    </div>
  );
}
