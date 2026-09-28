import { useEffect, useMemo, useRef, useState } from "react";
import echarts from "../echarts.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import { rowValue } from "../graph/derive.js";

// Simple view's three read-only charts (2026-09-28, user request): house
// consumption by source (grid / solar / battery, stacked + home line),
// total power production, battery charging/discharging. The SAME series
// definitions as the Graph tab's first three charts — derivations shared
// via graph/derive.js — but deliberately interaction-free: fixed trailing
// 24h window, no zoom/pan/span buttons, refreshed once a minute (this is
// the glance screen, not the analysis tool).
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

const REFRESH_MS = 60000;
const WINDOW_MS = 24 * 3600 * 1000;

function SimpleChart({ def, rows, title }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!rows?.length) return undefined;
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: { top: 30, right: 8, bottom: 24, left: 8, containLabel: true },
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
          formatter: (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        splitNumber: 3,
        axisLabel: { color: "#8b98a5", fontSize: 11, formatter: (v) => `${Math.round(v)} W` },
        splitLine: { lineStyle: { color: "#2a323866" } },
      },
      legend: {
        top: 0,
        left: 0,
        type: "scroll",
        textStyle: { color: "#8b98a5", fontSize: 11 },
        icon: "roundRect",
        itemWidth: 12,
        itemHeight: 8,
        inactiveColor: "#5a6672",
      },
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
  return (
    <section className="simple-chart">
      <h4>{title}</h4>
      <div ref={ref} className="chart-box-sm" />
    </section>
  );
}

export default function SimpleCharts() {
  const t = useT();
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const to = Date.now();
      fetch(`/api/timeseries?from=${to - WINDOW_MS}&to=${to}&points=600&view=${WINDOW_MS}`)
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
  }, []);
  // Resolve series names once per language (a fresh defs object re-inits
  // the charts — wanted on language change, not on every render).
  const defs = useMemo(
    () =>
      DEFS.map((d) => ({
        ...d,
        title: t(d.titleKey),
        series: d.series.map((s) => ({ ...s, name: t(s.nameKey) })),
      })),
    [t],
  );
  if (!rows?.length) return null;
  return (
    <div className="simple-charts">
      {defs.map((def) => (
        <SimpleChart key={def.titleKey} def={def} rows={rows} title={def.title} />
      ))}
    </div>
  );
}
