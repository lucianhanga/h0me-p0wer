import { useEffect, useRef } from "react";
import echarts from "../echarts.js";

// Shared tiny ECharts wrapper for dashboard tiles. Takes a full option
// object; re-renders when it changes.
export default function MiniChart({ option, height = 140 }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    const chart = echarts.init(ref.current, null, {
      renderer: "canvas",
      width: ref.current.clientWidth,
      height,
    });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [height]);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}

// Common mini-chart option fragments (dark theme, no chrome).
export const miniBase = {
  animation: false,
  backgroundColor: "transparent",
  grid: { top: 8, right: 4, bottom: 20, left: 4, containLabel: true },
  xAxis: {
    axisLine: { lineStyle: { color: "#2a3238" } },
    axisLabel: { color: "#8b98a5", fontSize: 10 },
    splitLine: { show: false },
    axisTick: { show: false },
  },
  yAxis: {
    axisLabel: { show: false },
    splitLine: { show: false },
  },
};
