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
  grid: { x: 84, y: 182 },
  home: { x: 220, y: 308 },
  batt: { x: 356, y: 182 },
};

// Nodes 156×96 — bigger rectangles (2026-10-03, user request: "make the
// rectangles bigger... cover a bit more from the space"; grown again
// 2026-10-04 for title/content breathing room, and wider twice more the
// same day for visual weight), still exactly edge to edge in the 440-wide
// viewBox — all in viewBox units, so it scales down cleanly on a phone
// exactly as before; only the diamond's proportions changed.
const NODE_W = 156;
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

// Where a diagonal arc touches each rectangle (2026-10-04, user request:
// "make the arc from PV to Battery start from the middle of the left side
// to the middle of the top side of the battery rectangle... follow the
// same pattern for all of them" — confirmed as the side FACING the other
// node, not literally "left", since that broke down for the other arcs).
// The "pole" nodes (PV/Home, top/bottom of the diamond) attach via their
// LEFT/RIGHT side; the "side" nodes (Grid/Battery, left/right of the
// diamond) attach via their TOP/BOTTOM side — e.g. PV's right side meets
// Battery's top side. This shortens every diagonal arc down to just the
// gap between the two rectangles (centers are hidden behind the nodes
// anyway), which also pulls each arc's floating label into that same gap
// instead of the wider center-to-center span — exactly the "numbers
// centered between the rectangles, not overlapping the arc" ask, as a
// side effect of edgeLabelPos's existing perpendicular-offset math.
// PV↔Home is intentionally excluded (user: "keep it as it is") — it stays
// a straight center-to-center line, handled by the "vertical" case below.
function edgeAnchor(id, partnerId) {
  const p = POS[id];
  if (id === "pv" && partnerId === "batt") return { x: p.x + NODE_W / 2, y: p.y };
  if (id === "batt" && partnerId === "pv") return { x: p.x, y: p.y - NODE_H / 2 };
  if (id === "grid" && partnerId === "home") return { x: p.x, y: p.y + NODE_H / 2 };
  if (id === "home" && partnerId === "grid") return { x: p.x - NODE_W / 2, y: p.y };
  if (id === "batt" && partnerId === "home") return { x: p.x, y: p.y + NODE_H / 2 };
  if (id === "home" && partnerId === "batt") return { x: p.x + NODE_W / 2, y: p.y };
  return p; // pv↔home: unchanged center-to-center
}

// Label geometry shared by EdgeLine and EdgeLabel — the two are rendered
// in different SVG layers (line beneath the nodes, label above them; see
// BasicVariant) so they need the same math without duplicating it.
function edgeLabelPos(a, b) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const vertical = a.x === b.x;
  const horizontal = a.y === b.y;
  // Diagonal edges: the label used to sit ON the dashed line (2026-09-29,
  // user report: "the text is over the arc line, not clearly visible"),
  // then a perpendicular offset mostly fixed that — but once the arcs
  // shortened to side-midpoint attachments (2026-10-04) the segments got
  // short/steep enough that a 12px perpendicular nudge no longer cleared
  // the label's own width, so it started clipping the arc again
  // (2026-10-04, user report: "the arches title are overlapping the
  // arches"). Diagonal arcs on the right half of the diamond (PV→Battery,
  // Battery→Home) now anchor "start" and sit purely to the RIGHT of the
  // line; the one on the left half (Grid→Home) anchors "end" and sits
  // purely to the LEFT — a horizontal offset, not perpendicular, so the
  // label's full width (which reads horizontally) never swings back over
  // a steep diagonal the way a perpendicular offset could.
  if (vertical) {
    return { x: mx + 8, y: my - 3, anchor: "start" };
  }
  if (horizontal) {
    return { x: mx, y: my - 8, anchor: "middle" };
  }
  const onRight = mx >= POS.pv.x; // diamond's vertical axis (pv.x === home.x)
  return onRight ? { x: mx + 14, y: my + 4, anchor: "start" } : { x: mx - 14, y: my + 4, anchor: "end" };
}

function EdgeLine({ edge }) {
  const a = edgeAnchor(edge.from, edge.to);
  const b = edgeAnchor(edge.to, edge.from);
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
  const a = edgeAnchor(edge.from, edge.to);
  const b = edgeAnchor(edge.to, edge.from);
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
