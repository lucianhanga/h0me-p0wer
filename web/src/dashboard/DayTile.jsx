import MiniChart, { miniBase } from "./MiniChart.jsx";
import { Tile } from "./Dashboard.jsx";

// Day overview: today's kWh totals + 30-min power profile.
export default function DayTile({ stats }) {
  const option = {
    ...miniBase,
    xAxis: {
      ...miniBase.xAxis,
      type: "time",
      axisLabel: {
        ...miniBase.xAxis.axisLabel,
        formatter: (ts) =>
          new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      },
    },
    yAxis: { ...miniBase.yAxis, type: "value" },
    series: [
      {
        type: "line",
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: "#f7a44f", width: 1.5 },
        areaStyle: { color: "#f7a44f22" },
        data: stats.profile.map((p) => [p.t, p.power]),
      },
      {
        name: "Battery",
        type: "line",
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: "#c084fc", width: 1.5 },
        data: stats.profile.map((p) => [p.t, p.batt ?? null]),
      },
    ],
  };

  return (
    <Tile
      title="Day overview"
      sub={`import ${stats.today.importKwh} kWh · export ${stats.today.exportKwh} kWh · coverage ${stats.today.coverage}%`}
    >
      <MiniChart option={option} />
    </Tile>
  );
}
