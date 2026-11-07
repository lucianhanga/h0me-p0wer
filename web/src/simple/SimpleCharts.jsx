import { useEffect, useMemo, useRef, useState } from "react";
import echarts from "../echarts.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import { robustCap, rowValue, tightAxisBounds } from "../graph/derive.js";
import { pvExpectedAt, toPvExpectedRows } from "../graph/pvExpected.js";
import QuadFlipTile from "../components/QuadFlipTile.jsx";
import { CHART_COLORS } from "../components/chartTheme.js";
import { capacityValueLabel, capacityYAxis, socLimitKwh } from "./batteryCapacity.js";

// Simple view's read-only charts: house consumption by source, total power
// production, battery charging/discharging, and combined stored capacity.
// The SAME power-series definitions as the Graph tab's first three charts —
// derivations shared via graph/derive.js — but deliberately interaction-free:
// no zoom/pan.
// Every tile is a round-robin flipper. Power tiles cycle
// 12h → 24h → 1w → 1h → 6h; capacity uses its own span list below.
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
  {
    titleKey: "graph.title.battCapacity",
    unit: "kWh",
    series: [
      { key: "battStoredKwh", nameKey: "graph.title.battCapacity", color: "#c084fc44", type: "bar" },
    ],
  },
];

// Face order per the user's spec: 12h, 24h, 3d, 1w, 1h, 6h — round robin.
// The extra "expected" face (weather forecast) exists only for the production tile.
const SPANS = [
  { key: "graph.span.12h", ms: 12 * 3600 * 1000 },
  { key: "graph.span.24h", ms: 24 * 3600 * 1000 },
  { key: "graph.span.3d", ms: 3 * 24 * 3600 * 1000 },
  { key: "graph.span.7d", ms: 7 * 24 * 3600 * 1000 },
  { key: "graph.span.1h", ms: 3600 * 1000 },
  { key: "graph.span.6h", ms: 6 * 3600 * 1000 },
  { key: "graph.span.expected", ms: null },
];

const CAPACITY_SPANS = [
  { key: "graph.span.24h", ms: 24 * 3600 * 1000 },
  { key: "graph.span.3d", ms: 3 * 24 * 3600 * 1000 },
  { key: "graph.span.7d", ms: 7 * 24 * 3600 * 1000 },
  { key: "graph.span.30d", ms: 30 * 24 * 3600 * 1000 },
  { key: "graph.span.full", ms: null, full: true },
];

// Default face (2026-10-04, user request: "make the default graphs in the
// simple view 6h resolution") — looked up by key rather than a hardcoded
// array index so it keeps pointing at 6h even if SPANS is reordered.
const DEFAULT_SPAN_IDX = SPANS.findIndex((s) => s.key === "graph.span.6h");

const REFRESH_MS = 60000;

function ChartCanvas({ def, rows, expectedOnly = false, expectedRows = [] }) {
  const t = useT();
  const ref = useRef(null);
  useEffect(() => {
    const sourceRows = expectedOnly ? expectedRows : rows;
    if (!sourceRows?.length) return undefined;
    const series = expectedOnly ? def.series.filter((s) => ["pv", "pvForecast"].includes(s.key)) : def.series;
    const seriesData = series.map((s) => {
      if (s.key === "pvForecast") {
        return expectedOnly
          ? expectedRows.map((r) => [r.t, r.pvForecast])
          : sourceRows.map((r) => [r.t, pvExpectedAt(expectedRows, r.t)]);
      }
      return (expectedOnly ? (rows ?? []) : sourceRows).map((r) => [r.t, rowValue(s.key, r)]);
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
    const yAxisBounds = def.unit === "kWh" ? capacityYAxis(def.capacityKwh, tight) : tight;
    const capacityLimits = def.unit === "kWh" && def.capacityKwh > 0
      ? [
          { pct: def.ceilPct, key: "max", color: "#6bb8f5", position: "insideEndBottom" },
          { pct: def.floorPct, key: "min", color: "#e5544b", position: "insideEndTop" },
        ]
          .map((limit) => ({
            yAxis: socLimitKwh(def.capacityKwh, limit.pct),
            lineStyle: { color: limit.color, type: "dotted", width: 1.5 },
            label: {
              color: limit.color,
              fontSize: 10,
              position: limit.position,
              formatter: t(`graph.socLimit.${limit.key}`, { pct: limit.pct }),
            },
          }))
          .filter((limit) => limit.yAxis != null)
      : [];
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: { top: 8, right: 8, bottom: 24, left: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        backgroundColor: CHART_COLORS.tooltipBg,
        borderColor: CHART_COLORS.border,
        textStyle: { color: CHART_COLORS.text, fontSize: 12 },
        valueFormatter: (v) => (def.unit === "kWh" ? capacityValueLabel(v, def.capacityKwh) : v == null ? "—" : `${Math.round(v)} W`),
      },
      xAxis: {
        type: "time",
        min: expectedOnly ? sourceRows[0].t : null,
        max: expectedOnly ? sourceRows[sourceRows.length - 1].t : null,
        axisLine: { lineStyle: { color: CHART_COLORS.border } },
        axisLabel: {
          color: CHART_COLORS.muted,
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
        min: yAxisBounds?.min ?? null,
        max: yAxisBounds?.max ?? null,
        axisLabel: {
          color: CHART_COLORS.muted,
          fontSize: 11,
          formatter: (v) => (def.unit === "kWh" ? `${v.toFixed(1)} kWh` : `${Math.round(v)} W`),
        },
        splitLine: { lineStyle: { color: CHART_COLORS.split } },
      },
      legend: { show: false }, // the title button carries the tile's identity
      series: series.map((s, si) => ({
        name: s.name,
        type: s.type ?? "line",
        showSymbol: false,
        connectNulls: false,
        stack: s.stack,
        lineStyle: { color: s.color, width: s.width ?? 1, type: s.dashed ? "dashed" : "solid" },
        itemStyle: { color: s.color },
        areaStyle: s.type !== "bar" && (s.stack || s.area) ? { color: `${s.color}44` } : undefined,
        barMaxWidth: s.type === "bar" ? 32 : undefined,
        emphasis: { disabled: true },
        data: seriesData[si],
        markLine: si === 0 && capacityLimits.length
          ? { silent: true, symbol: "none", animation: false, data: capacityLimits }
          : undefined,
      })),
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [def, rows, expectedOnly, expectedRows, t]);
  return <div ref={ref} className="chart-box-sm" />;
}

function SimpleChartTile({ def, expectedRows, capacityMeta }) {
  const t = useT();
  const isCapacity = def.titleKey === "graph.title.battCapacity";
  const [spanIdx, setSpanIdx] = useState(isCapacity ? 0 : DEFAULT_SPAN_IDX);
  const [rows, setRows] = useState(null);
  const [seriesCapacityKwh, setSeriesCapacityKwh] = useState(null);
  const spans = isCapacity
    ? CAPACITY_SPANS
    : def.titleKey === "graph.title.production"
      ? SPANS
      : SPANS.filter((s) => s.ms != null);
  const currentSpan = spans[spanIdx];
  const expectedOnly = currentSpan.key === "graph.span.expected";
  const fullHistory = currentSpan.full === true;
  const spanMs = expectedOnly ? 24 * 3600 * 1000 : currentSpan.ms ?? Infinity;
  // Memoized — a fresh {…def} object per render re-inited ECharts on every
  // WS push (2026-09-29 review: the dispose/init storm class the
  // TodayMiniChart fix established we must memoize for).
  const chartDef = useMemo(
    () => ({
      ...def,
      spanMs,
      ...(isCapacity ? capacityMeta : null),
      ...(isCapacity && seriesCapacityKwh > 0 ? { capacityKwh: seriesCapacityKwh } : null),
    }),
    [def, spanMs, isCapacity, capacityMeta, seriesCapacityKwh],
  );
  useEffect(() => {
    let cancelled = false;
    // Clear on span change — the previous face's data must not render under
    // the new face's label while the fetch is in flight (2026-09-29 review).
    setRows(null);
    const load = () => {
      const to = Date.now();
      const from = expectedOnly ? new Date().setHours(0, 0, 0, 0) : fullHistory ? 0 : to - spanMs;
      const viewMs = expectedOnly ? 24 * 3600 * 1000 : fullHistory ? 0 : spanMs;
      const bucket = isCapacity ? "&bucket=3600000" : "";
      const capacity = fullHistory ? "&capacity=full" : "";
      fetch(`/api/timeseries?from=${from}&to=${to}&points=600&view=${viewMs}${bucket}${capacity}`)
        .then((r) => r.json())
        .then((p) => {
          if (cancelled || !p?.ok) return;
          setRows(p.data);
          if (isCapacity) setSeriesCapacityKwh(p.batteryCapacityKwh > 0 ? p.batteryCapacityKwh : null);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [spanMs, expectedOnly, fullHistory]);
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
  const [capacityMeta, setCapacityMeta] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/pv/forecast")
        .then((r) => r.json())
        .then((payload) => {
          if (!cancelled && payload?.ok) setExpectedRows(toPvExpectedRows(payload));
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/battery/params")
      .then((r) => r.json())
      .then((payload) => {
        if (cancelled || !payload?.ok) return;
        const primary = payload.data.batteries?.[0] ?? payload.data;
        const config = primary.config ?? payload.data.config ?? {};
        setCapacityMeta({
          capacityKwh: primary.constants?.capacityKwh ?? null,
          floorPct: config.dischargeLowerLimitPct ?? 10,
          ceilPct: config.chargeUpperLimitPct ?? 100,
        });
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
        <SimpleChartTile key={def.titleKey} def={def} expectedRows={expectedRows} capacityMeta={capacityMeta} />
      ))}
    </div>
  );
}
