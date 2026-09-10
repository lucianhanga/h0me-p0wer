import MiniChart, { miniBase } from "./MiniChart.jsx";
import { Tile } from "./Dashboard.jsx";

// Bar tile for kWh-per-period rows ({label, importKwh, exportKwh, and
// optionally disKwh/chgKwh for the battery). Import drawn positive, export
// negative, stacked on the same baseline; battery bars alongside.
export default function KwhBarsTile({ title, rows, formatLabel, sub }) {
  const hasBattery = rows.some((r) => (r.disKwh ?? 0) > 0 || (r.chgKwh ?? 0) > 0);
  const option = {
    ...miniBase,
    legend: {
      top: 0,
      textStyle: { color: "#8b98a5", fontSize: 10 },
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 6,
    },
    grid: { ...miniBase.grid, top: 22 },
    xAxis: {
      ...miniBase.xAxis,
      type: "category",
      data: rows.map((r) => formatLabel(r.label)),
    },
    yAxis: { ...miniBase.yAxis, type: "value" },
    series: [
      {
        name: "import",
        type: "bar",
        stack: "kwh",
        itemStyle: { color: "#f7a44f" },
        data: rows.map((r) => r.importKwh),
      },
      {
        name: "export",
        type: "bar",
        stack: "kwh",
        itemStyle: { color: "#5fce80" },
        data: rows.map((r) => -r.exportKwh),
      },
      ...(hasBattery
        ? [
            {
              name: "battery out",
              type: "bar",
              itemStyle: { color: "#c084fc" },
              data: rows.map((r) => r.disKwh ?? 0),
            },
            {
              name: "battery in",
              type: "bar",
              itemStyle: { color: "#7c5cb0" },
              data: rows.map((r) => -(r.chgKwh ?? 0)),
            },
          ]
        : []),
    ],
  };

  return (
    <Tile title={title} sub={sub}>
      <MiniChart option={option} />
    </Tile>
  );
}
