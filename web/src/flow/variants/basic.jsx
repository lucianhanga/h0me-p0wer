import { useTweenedWatts } from "../../useTweenedValue.js";
import { useT } from "../../i18n/LanguageProvider.jsx";

// BASIC variant of the flow view (the current look): rounded-rect SVG
// nodes (PV top, Grid left, Battery right, Home bottom — a diamond),
// animated dashed arcs in flow direction, tweened watt labels. Renders
// ONLY what model.js gives it — positions/shapes/animation live here, data
// semantics never do. An artistic variant would swap node/edge rendering
// (icons, richer visuals) against the same model.
// Diamond layout (2026-10-04, user request: "make the diagram a diamond —
// PV top, Home bottom, Grid left, Battery right") — spreads the four nodes
// to the corners of a rhombus instead of the old T-shape, which lengthens
// every arc so the floating "123 W" labels clear the node rectangles
// instead of crowding the narrow gaps between them.
// Grid/Battery sit closer to center than their old ±150 offset (2026-10-04,
// user request: "make the rectangles a bit wider") — widening NODE_W while
// keeping their outer edges flush with the 440-wide viewBox (same 6px
// margin as before) means pulling the centers in so the wider boxes still
// fit. Everything here is viewBox units, not pixels, so it scales down
// cleanly on a phone exactly as it did before — only the proportions of
// the diamond changed, not the responsiveness.
const POS = {
  pv: { x: 220, y: 56 },
  grid: { x: 76, y: 182 },
  home: { x: 220, y: 308 },
  batt: { x: 364, y: 182 },
};

// Nodes 140×96 — bigger rectangles (2026-10-03, user request: "make the
// rectangles bigger... cover a bit more from the space"; grown again
// 2026-10-04, both taller for title/content breathing room and wider for
// more text room), still exactly edge to edge in the 440-wide viewBox.
const NODE_W = 140;
const NODE_H = 96;

function Node({ node }) {
  const p = POS[node.id];
  const w = useTweenedWatts(node.valueW ?? null);
  const hasValue = node.valueW != null || node.text != null;
  // Four possible rows (label / value / sub / contrib): compact offsets
  // when all four are present, looser otherwise (2026-10-03, per-source
  // contribution line added at the bottom). The contrib line is ALWAYS at
  // the same y (user request 2026-10-03 — same bottom position in every
  // rectangle, including the value-less Grid node).
  // Padding above the title and between the title and the rest of the
  // content (2026-10-04, user request: "put some space between the top
  // and the title and the title and the rest") — labelY sits further from
  // the top edge than the title text's own line-height, and valueY/subY
  // are spaced a bit looser below it than a tight stack would need.
  const compact = hasValue && node.sub && node.contrib;
  const labelY = compact ? p.y - 29 : hasValue ? p.y - 18 : node.contrib ? p.y - 8 : p.y + 4;
  const valueY = compact ? p.y - 7 : p.y + 5;
  const subY = compact ? p.y + 11 : p.y + 23;
  // A bit more air between the separator rule (y+22) and the percentage
  // text below it (2026-10-04, user request).
  const contribY = p.y + 37;
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
            y1={p.y + 22}
            x2={p.x + NODE_W / 2 - 10}
            y2={p.y + 22}
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
    <svg viewBox="0 0 440 364" className="flow-diagram" role="img" aria-label={t("flow.ariaLabel")}>
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
