import MiniChart, { miniBase } from "./MiniChart.jsx";
import { Tile } from "./Dashboard.jsx";

// Bar tile for kWh-per-period rows ({label, importKwh, exportKwh}).
// Import drawn positive, export negative, stacked on the same baseline.
export default function KwhBarsTile({ title, rows, formatLabel, sub }) {
  const option = {
    ...miniBase,
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
    ],
  };

  return (
    <Tile title={title} sub={sub}>
      <MiniChart option={option} />
    </Tile>
  );
}
