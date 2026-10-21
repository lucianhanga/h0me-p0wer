import { useEffect, useRef } from "react";
import echarts from "../echarts.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import { CHART_COLORS } from "../components/chartTheme.js";

// Nothing-fancy today-so-far line(s) for a Live tab tile's flip side: no
// zoom, no scroll, no legend — just the day's shape for that tile's metric
// (2026-09-19, user request: "just to simply visualize what is on front of
// the tiles for the day"). Same minimal-ECharts spirit as Dashboard's
// BackBars (animation off, transparent bg, muted axes).
//
// `lines`: one entry per series, e.g. a single metric (Grid, PV, House) is
// one line; the Battery tile — which shows two distinct directions,
// discharging and charging — passes two, each with its own color, rather
// than one signed line where the direction was only distinguishable by
// which side of zero it fell on (2026-09-19, same-day follow-up: "show
// both load and unload").
export default function TodayMiniChart({ lines, unit = "W", zeroLine = false }) {
  const t = useT();
  const ref = useRef(null);
  const hasData = lines?.some((l) => l.data?.length);

  useEffect(() => {
    if (!hasData) return undefined;
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: { top: 6, right: 6, bottom: 2, left: 2, containLabel: true },
      tooltip: {
        trigger: "axis",
        backgroundColor: CHART_COLORS.tooltipBg,
        borderColor: CHART_COLORS.border,
        textStyle: { color: CHART_COLORS.text, fontSize: 11 },
        axisPointer: { type: "line" },
        valueFormatter: (v) => (v == null ? "—" : `${Math.round(v)} ${unit}`),
      },
      xAxis: {
        type: "time",
        axisLabel: { color: CHART_COLORS.muted, fontSize: 9, hideOverlap: true },
        axisLine: { lineStyle: { color: CHART_COLORS.border } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: CHART_COLORS.muted, fontSize: 9 },
        splitLine: { lineStyle: { color: CHART_COLORS.split } },
      },
      series: lines.map(({ data, color, name }, i) => ({
        name,
        type: "line",
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color, width: 2 },
        areaStyle: { color, opacity: 0.12 },
        data,
        markLine:
          zeroLine && i === 0
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { color: CHART_COLORS.muted, type: "dashed", width: 1 },
                label: { show: false },
                data: [{ yAxis: 0 }],
              }
            : undefined,
      })),
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [lines, unit, zeroLine, hasData]);

  if (!hasData) return <p className="muted todaymini-empty">{t("live.noDataToday")}</p>;
  return <div ref={ref} className="todaymini-chart" />;
}
