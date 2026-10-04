import { useTweenedWatts } from "../../useTweenedValue.js";
import { useT } from "../../i18n/LanguageProvider.jsx";

// BASIC variant of the flow view (the current look): rounded-rect SVG
// nodes (PV top, Grid left, Home center, Battery right), animated dashed
// arcs in flow direction, tweened watt labels. Renders ONLY what
// model.js gives it — positions/shapes/animation live here, data
// semantics never do. An artistic variant would swap node/edge rendering
// (icons, richer visuals) against the same model.
const POS = {
  pv: { x: 220, y: 46 },
  grid: { x: 64, y: 152 },
  home: { x: 220, y: 152 },
  batt: { x: 376, y: 152 },
};

// Nodes 128×84 — bigger rectangles (2026-10-03, user request: "make the
// rectangles bigger... cover a bit more from the space"), still exactly
// edge to edge in the 440-wide viewBox.
const NODE_W = 128;
const NODE_H = 84;

function Node({ node }) {
  const p = POS[node.id];
  const w = useTweenedWatts(node.valueW ?? null);
  const hasValue = node.valueW != null || node.text != null;
  // Four possible rows (label / value / sub / contrib) in a 72px-tall node:
  // compact offsets when all four are present, looser otherwise (2026-10-03,
  // per-source contribution line added at the bottom). The contrib line is
  // ALWAYS at the same y (user request 2026-10-03 — same bottom position in
  // every rectangle, including the value-less Grid node).
  const compact = hasValue && node.sub && node.contrib;
  const labelY = compact ? p.y - 29 : hasValue ? p.y - 18 : node.contrib ? p.y - 8 : p.y + 4;
  const valueY = compact ? p.y - 10 : p.y + 3;
  const subY = compact ? p.y + 9 : p.y + 21;
  const contribY = p.y + 31;
  return (
    <g>
      <rect
        x={p.x - NODE_W / 2}
        y={p.y - NODE_H / 2}
        width={NODE_W}
        height={NODE_H}
        rx="9"
        fill="#1a2128"
        stroke={node.color}
        strokeOpacity="0.5"
      />
      <text x={p.x} y={labelY} textAnchor="middle" fill="#8b98a5" fontSize="12">
        {node.label}
      </text>
      {node.valueW != null && (
        <text x={p.x} y={valueY} textAnchor="middle" fill="#e8ecef" fontSize="14" fontWeight="600">
          {w} W
        </text>
      )}
      {node.text != null && (
        <text x={p.x} y={valueY} textAnchor="middle" fill="#e8ecef" fontSize="14" fontWeight="600">
          {node.text}
        </text>
      )}
      {node.sub && (
        <text x={p.x} y={subY} textAnchor="middle" fill="#8b98a5" fontSize="10">
          {node.sub}
        </text>
      )}
      {node.contrib && (
        <>
          {/* separator rule delimiting the contribution line (2026-10-03,
              user request) */}
          <line
            x1={p.x - NODE_W / 2 + 10}
            y1={p.y + 20}
            x2={p.x + NODE_W / 2 - 10}
            y2={p.y + 20}
            stroke="#2a3238"
            strokeWidth="1"
          />
          <text x={p.x} y={contribY} textAnchor="middle" fill={node.color} fontSize="10" fontWeight="600">
            {node.contrib}
          </text>
        </>
      )}
    </g>
  );
}

// Label geometry shared by EdgeLine and EdgeLabel — the two are rendered
// in different SVG layers (line beneath the nodes, label above them; see
// BasicVariant) so they need the same math without duplicating it.
function edgeLabelPos(a, b) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const vertical = a.x === b.x;
  const horizontal = a.y === b.y;
  // Diagonal edges (PV→Battery): the label used to sit ON the dashed line
  // (2026-09-29, user report: "the text is over the arc line, not clearly
  // visible") — offset it PERPENDICULAR to the arc (above the line) and
  // give every label a dark outline (paint-order stroke) so it stays
  // legible even when a line passes underneath.
  if (vertical) {
    return { x: mx + 8, y: my - 3, anchor: "start" };
  }
  if (horizontal) {
    return { x: mx, y: my - 8, anchor: "middle" };
  }
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let nx = -(b.y - a.y) / len;
  let ny = (b.x - a.x) / len;
  if (ny > 0) {
    nx = -nx;
    ny = -ny; // label above the line, never below
  }
  return { x: mx + nx * 12, y: my + ny * 12 + 4, anchor: "middle" };
}

function EdgeLine({ edge }) {
  const a = POS[edge.from];
  const b = POS[edge.to];
  const w = useTweenedWatts(edge.watts ?? 0); // arcs glide with the values
  if (w <= 0) {
    return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2a3238" strokeWidth="2" />;
  }
  return (
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
  );
}

// Labels sit on their own top layer, drawn after the node rectangles
// (2026-10-04, user report: "the arcs values you cannot properly see") —
// the gap between neighboring nodes is narrower than a "123 W" label, so
// when it was painted before the nodes the opaque node background clipped
// it. Painting labels last keeps them fully legible no matter how tight
// the layout gets (including scaled-down mobile widths).
function EdgeLabel({ edge }) {
  const a = POS[edge.from];
  const b = POS[edge.to];
  const w = useTweenedWatts(edge.watts ?? 0);
  if (w <= 0) return null;
  const { x, y, anchor } = edgeLabelPos(a, b);
  return (
    <text
      x={x}
      y={y}
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
  );
}

export default function BasicVariant({ model }) {
  const t = useT();
  return (
    <svg viewBox="0 0 440 260" className="flow-diagram" role="img" aria-label={t("flow.ariaLabel")}>
      {model.edges.map((e) => (
        <EdgeLine key={e.id} edge={e} />
      ))}
      {model.nodes.map((n) => (
        <Node key={n.id} node={n} />
      ))}
      {model.edges.map((e) => (
        <EdgeLabel key={e.id} edge={e} />
      ))}
    </svg>
  );
}
