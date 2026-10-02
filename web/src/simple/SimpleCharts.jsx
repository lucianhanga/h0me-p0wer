import { useEffect, useMemo, useRef, useState } from "react";
import echarts from "../echarts.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import { rowValue } from "../graph/derive.js";
import QuadFlipTile from "../components/QuadFlipTile.jsx";

// Simple view's three read-only charts (2026-09-28, user request): house
// consumption by source (grid / solar / battery, stacked + home line),
// total power production, battery charging/discharging. The SAME series
// definitions as the Graph tab's first three charts — derivations shared
// via graph/derive.js — but deliberately interaction-free: no zoom/pan.
// 2026-09-29 (user request): each tile is a round-robin flipper — tap the
// title (or the tile) to cycle 12h → 24h → 1w → 1h → 6h (6h added
// 2026-10-02, user request).
const DEFS = [
  {
    titleKey: "graph.title.home",
    series: [
      { key: "grid", nameKey: "graph.series.grid", color: "#f7a44f", stack: "u" },
      { key: "pvHome", nameKey: "graph.series.pv", color: "#5fce80", stack: "u" },
      { key: "battCells", nameKey: "graph.series.battOut", color: "#c084fc", stack: "u" },
      { key: "home", nameKey: "graph.series.home", color: "#e8ecef", width: 2 },
    ],
  },
  {
    titleKey: "graph.title.production",
    series: [{ key: "pv", nameKey: "graph.series.pvProduction", color: "#5fce80", area: true, width: 2 }],
  },
  {
    titleKey: "graph.title.battery",
    series: [
      { key: "battCells", nameKey: "graph.series.discharging", color: "#c084fc", area: true },
      { key: "battChgNeg", nameKey: "graph.series.charging", color: "#8a63d2", area: true },
    ],
  },
];

// Face order per the user's spec: 12h, 24h, 1w, 1h, 6h — round robin.
const SPANS = [
  { key: "graph.span.12h", ms: 12 * 3600 * 1000 },
  { key: "graph.span.24h", ms: 24 * 3600 * 1000 },
  { key: "graph.span.7d", ms: 7 * 24 * 3600 * 1000 },
  { key: "graph.span.1h", ms: 3600 * 1000 },
  { key: "graph.span.6h", ms: 6 * 3600 * 1000 },
];

const REFRESH_MS = 60000;

function ChartCanvas({ def, rows }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!rows?.length) return undefined;
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: { top: 8, right: 8, bottom: 24, left: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#1a2128",
        borderColor: "#2a3238",
        textStyle: { color: "#e8ecef", fontSize: 12 },
        valueFormatter: (v) => (v == null ? "—" : `${Math.round(v)} W`),
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
            // Day+time labels once the window spans more than a day (7d face).
            return def.spanMs > 24 * 3600 * 1000
              ? d.toLocaleDateString([], { day: "numeric", month: "short" }) +
                  " " +
                  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          },
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        splitNumber: 3,
        axisLabel: { color: "#8b98a5", fontSize: 11, formatter: (v) => `${Math.round(v)} W` },
        splitLine: { lineStyle: { color: "#2a323866" } },
      },
      legend: { show: false }, // the title button carries the tile's identity
      series: def.series.map((s) => ({
        name: s.name,
        type: "line",
        showSymbol: false,
        connectNulls: false,
        stack: s.stack,
        lineStyle: { color: s.color, width: s.width ?? 1 },
        itemStyle: { color: s.color },
        areaStyle: s.stack || s.area ? { color: `${s.color}44` } : undefined,
        emphasis: { disabled: true },
        data: rows.map((r) => [r.t, rowValue(s.key, r)]),
      })),
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [def, rows]);
  return <div ref={ref} className="chart-box-sm" />;
}

function SimpleChartTile({ def }) {
  const t = useT();
  const [spanIdx, setSpanIdx] = useState(0); // first face: 12h
  const [rows, setRows] = useState(null);
  const spanMs = SPANS[spanIdx].ms;
  // Memoized — a fresh {…def} object per render re-inited ECharts on every
  // WS push (2026-09-29 review: the dispose/init storm class the
  // TodayMiniChart fix established we must memoize for).
  const chartDef = useMemo(() => ({ ...def, spanMs }), [def, spanMs]);
  useEffect(() => {
    let cancelled = false;
    // Clear on span change — the previous face's data must not render under
    // the new face's label while the fetch is in flight (2026-09-29 review).
    setRows(null);
    const load = () => {
      const to = Date.now();
      fetch(`/api/timeseries?from=${to - spanMs}&to=${to}&points=600&view=${spanMs}`)
        .then((r) => r.json())
        .then((p) => {
          if (!cancelled && p?.ok) setRows(p.data);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [spanMs]);
  return (
    <section className="simple-chart">
      <QuadFlipTile
        title={def.title}
        faceLabel={t(SPANS[spanIdx].key)}
        onFlip={() => setSpanIdx((i) => (i + 1) % SPANS.length)}
      >
        {rows?.length ? (
          <ChartCanvas def={chartDef} rows={rows} />
        ) : (
          <div className="chart-box-sm simple-chart-loading" />
        )}
      </QuadFlipTile>
    </section>
  );
}

export default function SimpleCharts() {
  const t = useT();
  // Resolve titles/series names once per language.
  const defs = useMemo(
    () =>
      DEFS.map((d) => ({
        ...d,
        title: t(d.titleKey),
        series: d.series.map((s) => ({ ...s, name: t(s.nameKey) })),
      })),
    [t],
  );
  return (
    <div className="simple-charts">
      {defs.map((def) => (
        <SimpleChartTile key={def.titleKey} def={def} />
      ))}
    </div>
  );
}
