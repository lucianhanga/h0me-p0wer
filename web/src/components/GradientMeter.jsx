const SEGMENTS = 28;
const HALF = SEGMENTS / 2;

// `log` scaling (2026-10-04, grid phases — "most of the time the values
// will be under 500w" against a -2500/+2500 W scale, so a linear fill
// left most everyday readings pinned near the center). Standard VU-meter
// technique: map the raw value through a log curve to 0..1 first, then
// feed that into the otherwise-linear segment bar (confirmed against
// current practice — meters consistently normalize level to a log/dB
// scale before driving a linear widget, rather than trying to make the
// widget itself non-linear). log1p keeps 0 W at 0% with no singularity.
// KNEE_FRACTION sets the curve's reference point as a fraction of `max`
// (~30 W at a 2500 W scale) — small values below it still move the bar
// a lot per watt; values well above it compress together near the end.
const LOG_KNEE_FRACTION = 0.012;
function scalePct(magnitude, max, log) {
  if (!log) return Math.min(100, Math.round((magnitude / max) * 100));
  const ref = max * LOG_KNEE_FRACTION;
  const pct = Math.log1p(magnitude / ref) / Math.log1p(max / ref);
  return Math.min(100, Math.round(pct * 100));
}

// Segmented gradient meter (2026-10-04) — shared control behind the simple
// view's Solar Strings AND the Live tab's Details section (grid phases +
// PV channels, user request: "use the same controls for PVs, and similar
// also for the phases"). The row's own background carries the gradient;
// each segment is either transparent (lit — reveals the gradient at its
// own position) or a translucent dark wash (unlit — a dim tint of that
// position's color, like an LED's diffuser when off).
//
// `value` can be negative (grid phases: import vs export, "take care
// that they can be also negative") — the gradient swaps to green→blue→
// white instead of green→yellow→orange→red ("in case of negative values
// use the colors green->blue->white"), magnitude still scaled against the
// same `max`. Renders nothing when value or max is missing/non-positive —
// no bar is better than one against a guessed capacity.
//
// `bidirectional` (2026-10-04 follow-up, grid phases only — "consider a
// center which is 0 in the middle... negative values fill in... from the
// middle to the left... positive values fill in... from the middle to the
// right"): a diverging meter instead of a single left-to-right bar — a
// center 0 marker, positive values fill rightward (green→yellow→red,
// same as the single-direction positive scheme), negative values fill
// leftward (green→blue→white). Each half gets its own HALF-sized segment
// budget scaled against the same `max`, so the two halves stay visually
// comparable.
//
// `labels` (2026-10-04 follow-up, grid phases + PVs — "write them with
// small letters at the ends of the bars" / "the max W for the PVs", then
// "put on top of the bar, aligned right with the bar... left with the
// bar for the ones from the left... smaller font"): a small-type row
// above the bar, each limit aligned over the end it describes — both
// ends for `bidirectional` (-max / +max), just the right end otherwise
// (0 at the left is implicit).
//
// `log` (2026-10-04 follow-up, grid phases only — see LOG_KNEE_FRACTION
// above): scales magnitude through the log curve instead of linearly.
export default function GradientMeter({ value, max, bidirectional = false, labels = false, log = false }) {
  if (value == null || !(max > 0)) return null;

  if (bidirectional) {
    const posPct = value > 0 ? scalePct(value, max, log) : 0;
    const negPct = value < 0 ? scalePct(Math.abs(value), max, log) : 0;
    const litPos = Math.round((posPct / 100) * HALF);
    const litNeg = Math.round((negPct / 100) * HALF);
    const bar = (
      <div className="gradient-meter bidirectional">
        <div className="gradient-meter-half negative-half">
          {Array.from({ length: HALF }, (_, i) => {
            // i=0 is the far (most negative) edge, i=HALF-1 sits at the
            // center — lit segments grow outward FROM the center, so
            // distance-from-center (not i itself) drives the threshold.
            const distFromCenter = HALF - 1 - i;
            return <div key={i} className={`gradient-meter-seg${distFromCenter < litNeg ? " on" : ""}`} />;
          })}
        </div>
        <div className="gradient-meter-center" />
        <div className="gradient-meter-half positive-half">
          {Array.from({ length: HALF }, (_, i) => (
            <div key={i} className={`gradient-meter-seg${i < litPos ? " on" : ""}`} />
          ))}
        </div>
      </div>
    );
    if (!labels) return bar;
    return (
      <div className="gradient-meter-row">
        <div className="gradient-meter-labels">
          <span className="gradient-meter-limit">-{max} W</span>
          <span className="gradient-meter-limit">+{max} W</span>
        </div>
        {bar}
      </div>
    );
  }

  const negative = value < 0;
  const pct = Math.min(100, Math.round((Math.abs(value) / max) * 100));
  const lit = Math.round((pct / 100) * SEGMENTS);
  const bar = (
    <div className={`gradient-meter${negative ? " negative" : ""}`}>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <div key={i} className={`gradient-meter-seg${i < lit ? " on" : ""}`} />
      ))}
    </div>
  );
  if (!labels) return bar;
  return (
    <div className="gradient-meter-row">
      <div className="gradient-meter-labels right-only">
        <span className="gradient-meter-limit">{max} W</span>
      </div>
      {bar}
    </div>
  );
}
