import { useT } from "../i18n/LanguageProvider.jsx";
import { useTweenedWatts } from "../useTweenedValue.js";
import SectionTitle from "../components/SectionTitle.jsx";
import GradientMeter from "../components/GradientMeter.jsx";

// Simple view's per-string PV section (2026-10-04, user request: "visualize
// the PVs production individually... like a progress bar filled with the
// capacity they are already using and as text the percentage from the
// total"). Reuses the same flow.battery.pvUnits channels the Live tab's
// Details section lists — peakW is each port's configured peak watts,
// read server-side from the PV_PORT_W_<unit name> env var (see
// .env.example; given directly in watts, not panels × a constant, since a
// port can take 1-3 panels and panels get swapped for different-wattage
// ones over time). A port nobody configured shows its raw watts with no
// meter, rather than one against a guessed capacity.
// Card WIDTH is proportional to the port's own share of capacity
// (2026-10-04 follow-up — "show them proportionally based on the
// configured size"): a 1000 W port renders twice as wide as a 500 W one,
// via the --pv-weight custom property (styles.css turns it into
// flex-grow, with flex-basis: 0 making flex-grow act as a pure ratio —
// a custom property rather than inline flex-grow directly so the mobile
// media query can still cleanly override it). A port with no configured
// peakW falls back to a 500 W weight (a plausible single-panel default)
// so it doesn't collapse to a sliver next to configured neighbors.
const DEFAULT_WEIGHT_W = 500;

// GradientMeter is the shared segmented-gradient control (2026-10-04 —
// tried as one of four flip faces, then the user picked this one alone,
// since generalized into components/GradientMeter.jsx so the Live tab's
// Details section can reuse the same control for grid phases and PV
// channels: "use the same controls for PVs, and similar also for the
// phases").
function PvCard({ label, watts, peakW, weight, total }) {
  const w = useTweenedWatts(watts ?? 0);
  const pct = peakW > 0 ? Math.min(100, Math.round(((watts ?? 0) / peakW) * 100)) : null;
  return (
    <div className={`pv-slot${total ? " pv-slot-total" : ""}`} style={total ? undefined : { "--pv-weight": weight }}>
      <div className="pv-slot-label">
        <span>{label}</span>
        <span>
          {w} {pct != null ? `/ ${peakW} W · ${pct}%` : "W"}
        </span>
      </div>
      <GradientMeter value={watts} max={peakW} />
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
  // the sum instead of hiding the whole meter over one unconfigured port.
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
          <div key={u.sn} className="pv-unit-tile">
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
