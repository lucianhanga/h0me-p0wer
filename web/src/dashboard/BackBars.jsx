import { useEffect, useRef } from "react";
import echarts from "../echarts.js";

// Stacked per-bucket kWh bars (grid/battery/PV) for a tile's flip side.
// Hover/touch a bar for that bucket's split (ECharts axis tooltip).
export default function BackBars({ rows, formatLabel }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!rows?.length) return undefined;
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: { top: 8, right: 4, bottom: 4, left: 4, containLabel: true },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#1a2128",
        borderColor: "#2a3238",
        textStyle: { color: "#e8ecef", fontSize: 11 },
        valueFormatter: (v) => `${v} kWh`,
      },
      xAxis: {
        type: "category",
        data: rows.map((r) => formatLabel(r.label)),
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
        { name: "Grid", type: "bar", stack: "s", itemStyle: { color: "#f7a44f" }, data: rows.map((r) => r.grid) },
        { name: "Battery", type: "bar", stack: "s", itemStyle: { color: "#c084fc" }, data: rows.map((r) => r.batt) },
        { name: "PV", type: "bar", stack: "s", itemStyle: { color: "#5fce80" }, data: rows.map((r) => r.pv) },
      ],
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [rows, formatLabel]);

  return <div ref={ref} className="back-bars" />;
}
