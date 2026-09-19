import { useEffect, useRef } from "react";
import echarts from "../echarts.js";

// Nothing-fancy today-so-far line for a Live tab tile's flip side: no zoom,
// no scroll, no legend — just the day's shape for that one metric
// (2026-09-19, user request: "just to simply visualize what is on front of
// the tiles for the day"). Same minimal-ECharts spirit as Dashboard's
// BackBars (animation off, transparent bg, muted axes).
export default function TodayMiniChart({ data, color, unit = "W", zeroLine = false }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!data?.length) return undefined;
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: { top: 6, right: 6, bottom: 2, left: 2, containLabel: true },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#1a2128",
        borderColor: "#2a3238",
        textStyle: { color: "#e8ecef", fontSize: 11 },
        axisPointer: { type: "line" },
        valueFormatter: (v) => (v == null ? "—" : `${Math.round(v)} ${unit}`),
      },
      xAxis: {
        type: "time",
        axisLabel: { color: "#8b98a5", fontSize: 9, hideOverlap: true },
        axisLine: { lineStyle: { color: "#2a3238" } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#8b98a5", fontSize: 9 },
        splitLine: { lineStyle: { color: "#2a323866" } },
      },
      series: [
        {
          type: "line",
          showSymbol: false,
          connectNulls: false,
          lineStyle: { color, width: 2 },
          areaStyle: { color, opacity: 0.12 },
          data,
          markLine: zeroLine
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { color: "#8b98a5", type: "dashed", width: 1 },
                label: { show: false },
                data: [{ yAxis: 0 }],
              }
            : undefined,
        },
      ],
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [data, color, unit, zeroLine]);

  if (!data?.length) return <p className="muted todaymini-empty">no data yet today</p>;
  return <div ref={ref} className="todaymini-chart" />;
}
