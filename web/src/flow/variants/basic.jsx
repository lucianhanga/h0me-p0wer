import { useTweenedWatts } from "../../useTweenedValue.js";
import { useT } from "../../i18n/LanguageProvider.jsx";

// BASIC variant of the flow view (the current look): rounded-rect SVG
// nodes (PV top, Grid left, Home center, Battery right), animated dashed
// arcs in flow direction, tweened watt labels. Renders ONLY what
// model.js gives it — positions/shapes/animation live here, data
// semantics never do. An artistic variant would swap node/edge rendering
// (icons, richer visuals) against the same model.
const POS = {
  pv: { x: 220, y: 30 },
  grid: { x: 55, y: 150 },
  home: { x: 220, y: 150 },
  batt: { x: 385, y: 150 },
};

function Node({ node }) {
  const p = POS[node.id];
  const w = useTweenedWatts(node.valueW ?? null);
  const hasValue = node.valueW != null || node.text != null;
  return (
    <g>
      <rect
        x={p.x - 48}
        y={p.y - 28}
        width="96"
        height="60"
        rx="8"
        fill="#1a2128"
        stroke={node.color}
        strokeOpacity="0.5"
      />
      <text x={p.x} y={hasValue ? p.y - 16 : p.y + 4} textAnchor="middle" fill="#8b98a5" fontSize="12">
        {node.label}
      </text>
      {node.valueW != null && (
        <text x={p.x} y={p.y + 2} textAnchor="middle" fill="#e8ecef" fontSize="13" fontWeight="600">
          {w} W
        </text>
      )}
      {node.text != null && (
        <text x={p.x} y={p.y + 2} textAnchor="middle" fill="#e8ecef" fontSize="13" fontWeight="600">
          {node.text}
        </text>
      )}
      {node.sub && (
        <text x={p.x} y={p.y + 18} textAnchor="middle" fill="#8b98a5" fontSize="10">
          {node.sub}
        </text>
      )}
    </g>
  );
}

function Edge({ edge }) {
  const a = POS[edge.from];
  const b = POS[edge.to];
  const w = useTweenedWatts(edge.watts ?? 0); // arcs glide with the values
  if (w <= 0) {
    return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2a3238" strokeWidth="2" />;
  }
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const vertical = a.x === b.x;
  const horizontal = a.y === b.y;
  // Diagonal edges (PV→Battery): the label used to sit ON the dashed line
  // (2026-09-29, user report: "the text is over the arc line, not clearly
  // visible") — offset it PERPENDICULAR to the arc (above the line) and
  // give every label a dark outline (paint-order stroke) so it stays
  // legible even when a line passes underneath.
  let lx, ly, anchor;
  if (vertical) {
    lx = mx + 8;
    ly = my - 3;
    anchor = "start";
  } else if (horizontal) {
    lx = mx;
    ly = my - 8;
    anchor = "middle";
  } else {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    if (ny > 0) {
      nx = -nx;
      ny = -ny; // label above the line, never below
    }
    lx = mx + nx * 12;
    ly = my + ny * 12 + 4;
    anchor = "middle";
  }
  return (
    <g>
      <line
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke={edge.color}
        strokeWidth="2.5"
        strokeDasharray="6 6"
        className="flow-edge-anim"
      />
      <text
        x={lx}
        y={ly}
        fill={edge.color}
        fontSize="12"
        fontWeight="600"
        textAnchor={anchor}
        paintOrder="stroke"
        stroke="#10161b"
        strokeWidth="3"
      >
        {w} W
      </text>
    </g>
  );
}

export default function BasicVariant({ model }) {
  const t = useT();
  return (
    <svg viewBox="0 0 440 260" className="flow-diagram" role="img" aria-label={t("flow.ariaLabel")}>
      {model.edges.map((e) => (
        <Edge key={e.id} edge={e} />
      ))}
      {model.nodes.map((n) => (
        <Node key={n.id} node={n} />
      ))}
    </svg>
  );
}
