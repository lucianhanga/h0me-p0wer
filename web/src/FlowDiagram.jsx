import { useEffect, useState } from "react";

// Live power-flow diagram (HA energy-dashboard / Anker app pattern):
// PV on top, Grid left, Home center, Battery right. Edges animate in the
// direction of flow and are labeled with live watts; idle edges fade out.
export default function FlowDiagram() {
  const [flow, setFlow] = useState(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/flow")
        .then((r) => r.json())
        .then((res) => res.ok && setFlow(res.data))
        .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  if (!flow) return <p className="muted">loading…</p>;

  const { grid, battery, pv, home } = flow;
  const battDischarge = battery?.discharge ?? 0;
  const battCharge = battery?.charge ?? 0;

  // Node positions (viewBox 440x260)
  const N = {
    pv: { x: 220, y: 30, label: "PV", sub: `${pv.production} W`, color: "#5fce80" },
    grid: {
      x: 55,
      y: 150,
      label: "Grid",
      sub:
        grid.import != null
          ? grid.import > 0
            ? `${grid.import} W`
            : `−${grid.export} W`
          : "—",
      color: "#f7a44f",
    },
    home: { x: 220, y: 150, label: "Home", sub: home.consumption != null ? `${home.consumption} W` : "—", color: "#e8ecef" },
    batt: {
      x: 385, y: 150,
      label: battery?.name ?? "Battery",
      sub: battery ? `${battery.soc}%` : "—",
      color: "#c084fc",
    },
  };

  // Edge: [from, to, watts, color, id, sourceTs] — sourceTs is the timestamp
  // of the data source feeding that edge (meter snapshot or battery reading).
  const edges = [
    [N.pv, N.home, pv.toHome, "#5fce80", "pv-home", pv.ts],
    [N.pv, N.batt, pv.toBattery, "#5fce80", "pv-batt", pv.ts],
    [N.grid, N.home, grid.import ?? 0, "#f7a44f", "grid-home", grid.ts],
    [N.home, N.grid, grid.export ?? 0, "#f7a44f", "home-grid", grid.ts],
    [N.batt, N.home, battDischarge, "#c084fc", "batt-home", battery?.ts],
    [N.home, N.batt, battCharge, "#c084fc", "home-batt", battery?.ts],
  ];

  return (
    <svg viewBox="0 0 440 260" className="flow-diagram" role="img" aria-label="power flow">
      {edges.map(([a, b, w, color, id, ts]) => (
        <Edge key={id} a={a} b={b} watts={w} color={color} ts={ts} />
      ))}
      {Object.values(N).map((n) => (
        <g key={n.label}>
          <rect
            x={n.x - 48}
            y={n.y - 26}
            width="96"
            height="52"
            rx="8"
            fill="#1a2128"
            stroke={n.color}
            strokeOpacity="0.5"
          />
          <text x={n.x} y={n.y - 4} textAnchor="middle" fill="#8b98a5" fontSize="12">
            {n.label}
          </text>
          <text x={n.x} y={n.y + 14} textAnchor="middle" fill="#e8ecef" fontSize="13" fontWeight="600">
            {n.sub}
          </text>
        </g>
      ))}
    </svg>
  );
}

function Edge({ a, b, watts, color, ts }) {
  if (!watts) {
    return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2a3238" strokeWidth="2" />;
  }
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const vertical = a.x === b.x;
  const updated = ts ? new Date(ts).toLocaleTimeString() : null;
  return (
    <g>
      <line
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke={color}
        strokeWidth="2.5"
        strokeDasharray="6 6"
        className="flow-edge-anim"
      />
      <text
        x={vertical ? mx + 8 : mx}
        y={vertical ? my - 3 : my - 8}
        fill={color}
        fontSize="12"
        fontWeight="600"
        textAnchor={vertical ? "start" : "middle"}
      >
        {Math.round(watts)} W
      </text>
      {updated && (
        <text
          x={vertical ? mx + 8 : mx}
          y={vertical ? my + 9 : my + 11}
          fill="#8b98a5"
          fontSize="8"
          textAnchor={vertical ? "start" : "middle"}
        >
          {updated}
        </text>
      )}
    </g>
  );
}
