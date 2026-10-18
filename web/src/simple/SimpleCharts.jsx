import { useEffect, useMemo, useRef, useState } from "react";
import echarts from "../echarts.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import { robustCap, rowValue, tightAxisBounds } from "../graph/derive.js";
import { pvExpectedAt, toPvExpectedRows } from "../graph/pvExpected.js";
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
    series: [
      { key: "pv", nameKey: "graph.series.pvProduction", color: "#5fce80", area: true, width: 2 },
      { key: "pvForecast", nameKey: "graph.series.pvForecast", color: "#6bb8f5", width: 1, dashed: true },
    ],
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
// The extra "expected" face (weather forecast) exists only for the production tile.
const SPANS = [
  { key: "graph.span.12h", ms: 12 * 3600 * 1000 },
  { key: "graph.span.24h", ms: 24 * 3600 * 1000 },
  { key: "graph.span.7d", ms: 7 * 24 * 3600 * 1000 },
  { key: "graph.span.1h", ms: 3600 * 1000 },
  { key: "graph.span.6h", ms: 6 * 3600 * 1000 },
  { key: "graph.span.expected", ms: null },
];

// Default face (2026-10-04, user request: "make the default graphs in the
// simple view 6h resolution") — looked up by key rather than a hardcoded
// array index so it keeps pointing at 6h even if SPANS is reordered.
const DEFAULT_SPAN_IDX = SPANS.findIndex((s) => s.key === "graph.span.6h");

const REFRESH_MS = 60000;

function ChartCanvas({ def, rows, expectedOnly = false, expectedRows = [] }) {
  const ref = useRef(null);
  useEffect(() => {
    const sourceRows = expectedOnly ? expectedRows : rows;
    if (!sourceRows?.length) return undefined;
    const series = expectedOnly ? def.series.filter((s) => s.key === "pvForecast") : def.series;
    const seriesData = series.map((s) => {
      if (s.key === "pvForecast") {
        return expectedOnly
          ? sourceRows.map((r) => [r.t, r.pvForecast])
          : sourceRows.map((r) => [r.t, pvExpectedAt(expectedRows, r.t)]);
      }
      return sourceRows.map((r) => [r.t, rowValue(s.key, r)]);
    });
    // Tight y-axis around the data (2026-10-03, user request — same rule as
    // the Graph tab's power charts, INCLUDING the same outlier cap: a kettle
    // spike would otherwise stretch the glance view's axis exactly the way
    // it used to stretch the Graph tab's; here a capped spike simply
    // flat-tops silently, no "off-scale" note mechanism in this view). The
    // stacked charts' line series (home / pv) equals the stack top, so the
    // per-row max covers the stack.
    let dataMin = null;
    let dataMax = null;
    for (const d of seriesData) {
      for (const p of d) {
        const v = p[1];
        if (v == null || !Number.isFinite(v)) continue;
        dataMin = dataMin == null ? v : Math.min(dataMin, v);
        dataMax = dataMax == null ? v : Math.max(dataMax, v);
      }
    }
    const posCap = robustCap(seriesData.flatMap((d) => d.map((p) => p[1])));
    const negCap = robustCap(seriesData.flatMap((d) => d.map((p) => (p[1] != null ? -p[1] : null))));
    const tight = tightAxisBounds(negCap ? -negCap.cap : dataMin, posCap ? posCap.cap : dataMax);
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
        min: expectedOnly ? sourceRows[0].t : null,
        max: expectedOnly ? sourceRows[sourceRows.length - 1].t : null,
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
        min: tight?.min ?? null,
        max: tight?.max ?? null,
        axisLabel: { color: "#8b98a5", fontSize: 11, formatter: (v) => `${Math.round(v)} W` },
        splitLine: { lineStyle: { color: "#2a323866" } },
      },
      legend: { show: false }, // the title button carries the tile's identity
      series: series.map((s, si) => ({
        name: s.name,
        type: "line",
        showSymbol: false,
        connectNulls: false,
        stack: s.stack,
        lineStyle: { color: s.color, width: s.width ?? 1, type: s.dashed ? "dashed" : "solid" },
        itemStyle: { color: s.color },
        areaStyle: s.stack || s.area ? { color: `${s.color}44` } : undefined,
        emphasis: { disabled: true },
        data: seriesData[si],
      })),
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [def, rows, expectedOnly, expectedRows]);
  return <div ref={ref} className="chart-box-sm" />;
}

function SimpleChartTile({ def, expectedRows }) {
  const t = useT();
  const [spanIdx, setSpanIdx] = useState(DEFAULT_SPAN_IDX); // first face: 6h
  const [rows, setRows] = useState(null);
  const spans = def.titleKey === "graph.title.production" ? SPANS : SPANS.filter((s) => s.ms != null);
  const currentSpan = spans[spanIdx];
  const expectedOnly = currentSpan.ms == null;
  const spanMs = expectedOnly ? 24 * 3600 * 1000 : currentSpan.ms;
  // Memoized — a fresh {…def} object per render re-inited ECharts on every
  // WS push (2026-09-29 review: the dispose/init storm class the
  // TodayMiniChart fix established we must memoize for).
  const chartDef = useMemo(() => ({ ...def, spanMs }), [def, spanMs]);
  useEffect(() => {
    if (expectedOnly) return undefined;
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
  }, [spanMs, expectedOnly]);
  const hasData = expectedOnly ? expectedRows.length > 0 : rows?.length > 0;
  return (
    <section className="simple-chart">
      <QuadFlipTile
        title={def.title}
        faceLabel={t(currentSpan.key)}
        onFlip={() => setSpanIdx((i) => (i + 1) % spans.length)}
      >
        {hasData ? (
          <ChartCanvas def={chartDef} rows={rows} expectedOnly={expectedOnly} expectedRows={expectedRows} />
        ) : (
          <div className="chart-box-sm simple-chart-loading" />
        )}
      </QuadFlipTile>
    </section>
  );
}

export default function SimpleCharts() {
  const t = useT();
  const [expectedRows, setExpectedRows] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/pv/forecast")
      .then((r) => r.json())
      .then((payload) => {
        if (!cancelled && payload?.ok) setExpectedRows(toPvExpectedRows(payload));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
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
        <SimpleChartTile key={def.titleKey} def={def} expectedRows={expectedRows} />
      ))}
    </div>
  );
}
