// Live power-flow diagram (HA energy-dashboard / Anker app pattern):
// PV on top, Grid left, Home center, Battery right. Edges animate in the
// direction of flow and are labeled with live watts; idle edges fade out.
// Data comes as a prop from LiveTab so the diagram and the tiles below it
// always show the SAME payload (no separate fetches drifting apart).
export default function FlowDiagram({ flow }) {
  if (!flow) return <p className="muted">loading…</p>;

  const { grid, battery, pv, home } = flow;
  const cells = battery?.cells ?? 0; // cells → house (Battery→Home arc)
  const gridCharge = battery?.gridCharge ?? 0; // grid → cells (Home→Battery arc, rare)
  // ONE arc between house and battery: the dominant direction only (the two
  // can briefly both read > 0 while PV splits at the DC bus — overlapping
  // opposite arcs looked wrong, reported 2026-09-14).
  const battToHome = cells >= gridCharge ? cells : 0;
  const homeToBatt = gridCharge > cells ? gridCharge : 0;
  const charging = (pv.toBattery ?? 0) + gridCharge > 0;
  const battState = battery
    ? charging
      ? ` ⚡ ${Math.round((pv.toBattery ?? 0) + gridCharge)} W`
      : cells > 0
        ? ` ⏏ ${Math.round(cells)} W`
        : ""
    : "";

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
            : grid.export > 0
              ? `−${grid.export} W`
              : "0 W" // deadbanded/balanced — never "−0 W"
          : "—",
      color: "#f7a44f",
    },
    home: { x: 220, y: 150, label: "Home", sub: home.consumption != null ? `${home.consumption} W` : "—", color: "#e8ecef" },
    batt: {
      x: 385, y: 150,
      label: battery?.name ?? "Battery",
      sub: battery ? `${battery.soc}%${battState}` : "—",
      color: "#c084fc",
    },
  };

  // Edge: [from, to, watts, color, id] — values only. Timestamps live at the
  // page level (all values update together from one call), sources are shown
  // there too. The four arcs (per the Anker app's flow view): PV→Battery
  // (loading), PV→Home (inverter pass-through), Battery→Home (cells,
  // unloading), Grid→Home (+ Home→Grid on export, Home→Battery if
  // grid-charging).
  const edges = [
    [N.pv, N.batt, pv.toBattery ?? 0, "#5fce80", "pv-batt"],
    [N.pv, N.home, pv.toHome ?? 0, "#5fce80", "pv-home"],
    [N.grid, N.home, grid.import ?? 0, "#f7a44f", "grid-home"],
    [N.home, N.grid, grid.export ?? 0, "#f7a44f", "home-grid"],
    [N.batt, N.home, battToHome, "#c084fc", "batt-home"],
    [N.home, N.batt, homeToBatt, "#c084fc", "home-batt"],
  ];

  return (
    <svg viewBox="0 0 440 260" className="flow-diagram" role="img" aria-label="power flow">
      {edges.map(([a, b, w, color, id]) => (
        <Edge key={id} a={a} b={b} watts={w} color={color} />
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

function Edge({ a, b, watts, color }) {
  if (!watts) {
    return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2a3238" strokeWidth="2" />;
  }
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const vertical = a.x === b.x;
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
    </g>
  );
}
