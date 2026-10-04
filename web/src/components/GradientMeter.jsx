const SEGMENTS = 28;

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
export default function GradientMeter({ value, max }) {
  if (value == null || !(max > 0)) return null;
  const negative = value < 0;
  const pct = Math.min(100, Math.round((Math.abs(value) / max) * 100));
  const lit = Math.round((pct / 100) * SEGMENTS);
  return (
    <div className={`gradient-meter${negative ? " negative" : ""}`}>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <div key={i} className={`gradient-meter-seg${i < lit ? " on" : ""}`} />
      ))}
    </div>
  );
}
