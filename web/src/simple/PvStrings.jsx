import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/LanguageProvider.jsx";
import { useTweenedWatts } from "../useTweenedValue.js";
import SectionTitle from "../components/SectionTitle.jsx";

// Simple view's per-string PV section (2026-10-04, user request: "visualize
// the PVs production individually... like a progress bar filled with the
// capacity they are already using and as text the percentage from the
// total"). Reuses the same flow.battery.pvUnits channels the Live tab's
// Details section lists — peakW is each port's configured peak watts,
// read server-side from the PV_PORT_W_<unit name> env var (see
// .env.example; given directly in watts, not panels × a constant, since a
// port can take 1-3 panels and panels get swapped for different-wattage
// ones over time). A port nobody configured shows its raw watts with no
// bar, rather than a bar against a guessed capacity.
// Card WIDTH is proportional to the port's own share of capacity
// (2026-10-04 follow-up — "show them proportionally based on the
// configured size"): a 1000 W port renders twice as wide as a 500 W one,
// via the --pv-weight custom property (styles.css turns it into
// flex-grow, with flex-basis: 0 making flex-grow act as a pure ratio —
// a custom property rather than inline flex-grow directly so the mobile
// media query can still cleanly override it back to stacked/equal-width).
// A port with no configured peakW falls back to a 500 W weight (a
// plausible single-panel default) so it doesn't collapse to a sliver next
// to configured neighbors.
const DEFAULT_WEIGHT_W = 500;

// ---- the four visualization faces (2026-10-04, user request: "make it
// like an invisible tile which when flipped get different visualizations")
// — each takes just the computed percentage (0-100, or null when the port
// has no configured capacity) and renders the graphic only; the label row
// stays static outside the flip so text never distorts mid-rotation. ----

function FaceShimmer({ pct }) {
  return (
    <div className="pv-viz-track">
      <div className="pv-viz-fill pv-viz-fill-shimmer" style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
}

const LED_COUNT = 16;
function FaceLed({ pct }) {
  const lit = Math.round(((pct ?? 0) / 100) * LED_COUNT);
  return (
    <div className="pv-viz-led-row">
      {Array.from({ length: LED_COUNT }, (_, i) => (
        <div key={i} className={`pv-viz-led${i < lit ? " on" : ""}`} />
      ))}
    </div>
  );
}

// Zone gradient — the default face (2026-10-04 follow-up: "make this one
// the default one and make it thinner like the minimal + shimmer sweep").
// The fill's own background sweeps green → amber → red with NO hard
// stops ("make the colors gradients slowly flowing one color in another
// not abrupt") — a lightly-loaded port reads mostly green, one pushed
// toward its configured capacity shows amber/red right at the fill edge.
function FaceZone({ pct }) {
  return (
    <div className="pv-viz-track">
      <div className="pv-viz-fill pv-viz-fill-zone" style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
}

function FaceRing({ pct }) {
  const size = 36;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - (pct ?? 0) / 100);
  const cx = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="pv-viz-ring">
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="#0d1114" strokeWidth={stroke} />
      {pct != null && (
        <circle
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          stroke="#5fce80"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={off}
          transform={`rotate(-90 ${cx} ${cx})`}
        />
      )}
      <text x={cx} y={cx} textAnchor="middle" dominantBaseline="middle" className="pv-viz-ring-text">
        {pct != null ? `${pct}%` : "—"}
      </text>
    </svg>
  );
}

const FACES = [
  { key: "shimmer", Face: FaceShimmer },
  { key: "led", Face: FaceLed },
  { key: "zone", Face: FaceZone },
  { key: "ring", Face: FaceRing },
];
const DEFAULT_FACE_IDX = FACES.findIndex((f) => f.key === "zone");

// One card, used for both an individual port and the section total. Tap
// anywhere on the card to cycle its visualization — each card flips
// independently, keeping its own face across live data updates. Same
// edge-on rotate mechanic as components/QuadFlipTile.jsx, duplicated
// rather than reused: that component assumes a title bar above its box,
// which would double up with this card's own label row.
function PvCard({ label, watts, peakW, weight, total }) {
  const w = useTweenedWatts(watts ?? 0);
  const pct = peakW > 0 ? Math.min(100, Math.round(((watts ?? 0) / peakW) * 100)) : null;
  const [faceIdx, setFaceIdx] = useState(DEFAULT_FACE_IDX);
  const [phase, setPhase] = useState("in"); // in | out | prep
  const busy = useRef(false);
  const downPos = useRef(null);
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn, ms) => timers.current.push(setTimeout(fn, ms));

  const flip = () => {
    if (busy.current) return;
    busy.current = true;
    setPhase("out"); // rotate to edge-on
    later(() => {
      setFaceIdx((i) => (i + 1) % FACES.length); // swap face while invisible
      setPhase("prep"); // jump to the other edge WITHOUT animating
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          setPhase("in"); // animate back to flat
          later(() => {
            busy.current = false;
          }, 220);
        }),
      );
    }, 190);
  };

  const Face = FACES[faceIdx].Face;
  return (
    <div
      className={`pv-slot${total ? " pv-slot-total" : ""}`}
      style={total ? undefined : { "--pv-weight": weight }}
      onPointerDown={(e) => (downPos.current = [e.clientX, e.clientY])}
      onClick={(e) => {
        if (downPos.current) {
          const [x, y] = downPos.current;
          downPos.current = null;
          if (Math.hypot(e.clientX - x, e.clientY - y) > 10) return; // drag, not tap
        }
        flip();
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          flip();
        }
      }}
    >
      <div className="pv-slot-label">
        <span>{label}</span>
        <span>
          {w} {pct != null ? `/ ${peakW} W · ${pct}%` : "W"}
        </span>
      </div>
      <div className="pv-viz-box">
        <div className={`quadflip-inner qf-${phase}`}>
          <Face pct={pct} />
        </div>
      </div>
    </div>
  );
}

export default function PvStrings({ flow }) {
  const t = useT();
  const units = flow?.battery?.pvUnits ?? [];
  const groups = units
    .map((u) => ({ ...u, channels: u.channels.filter((c) => c.connected) }))
    .filter((u) => u.channels.length > 0);
  if (!groups.length) return null;
  // Total: sums every connected port's watts; the percentage only counts
  // ports with a configured peakW (2026-10-04, user request: "add on top
  // an indication of the total also like a progress bar") — same
  // "don't guess a capacity" rule as the individual cards, applied to
  // the sum instead of hiding the whole bar over one unconfigured port.
  const allChannels = groups.flatMap((u) => u.channels);
  const totalWatts = allChannels.reduce((sum, c) => sum + (c.watts ?? 0), 0);
  const configured = allChannels.filter((c) => c.peakW > 0);
  const totalPeakW = configured.length ? configured.reduce((sum, c) => sum + c.peakW, 0) : null;
  return (
    <>
      <SectionTitle>{t("simple.pvStrings")}</SectionTitle>
      <PvCard label={t("simple.pvTotal")} watts={totalWatts} peakW={totalPeakW} total />
      <div className="pv-slot-groups">
        {groups.map((u) => (
          <div key={u.sn}>
            {groups.length > 1 && <p className="pv-unit-label muted">{u.name}</p>}
            <div className="pv-slot-grid">
              {u.channels.map((c) => (
                <PvCard
                  key={c.n}
                  label={c.name}
                  watts={c.watts}
                  peakW={c.peakW}
                  weight={c.peakW > 0 ? c.peakW : DEFAULT_WEIGHT_W}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
