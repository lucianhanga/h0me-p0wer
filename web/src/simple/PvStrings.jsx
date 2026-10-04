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
// Card WIDTH is proportional to the port's own share of capacity too
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

// Shared label+track+fill markup for both an individual port's bar and the
// section-wide total bar below — only the outer wrapper (proportional
// width vs. full width) differs between the two call sites.
function PvBarContent({ label, watts, peakW }) {
  const w = useTweenedWatts(watts ?? 0);
  const pct = peakW > 0 ? Math.min(100, Math.round(((watts ?? 0) / peakW) * 100)) : null;
  return (
    <>
      <div className="pv-slot-label">
        <span>{label}</span>
        <span>
          {w} {pct != null ? `/ ${peakW} W · ${pct}%` : "W"}
        </span>
      </div>
      <div className="pv-slot-track">
        <div className="pv-slot-fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
    </>
  );
}

function PvSlotBar({ channel, weight }) {
  return (
    <div className="pv-slot" style={{ "--pv-weight": weight }}>
      <PvBarContent label={channel.name} watts={channel.watts} peakW={channel.peakW} />
    </div>
  );
}

// Total bar (2026-10-04, user request: "also add on top of [the ports] an
// indication of the total also like a progress bar") — sums every
// connected port's live watts and, for the percentage, every connected
// port's configured peakW. A port with no configured capacity still adds
// its watts to the headline number (it's real production) but is left out
// of the percentage/bar math — same "don't guess a capacity" rule as the
// individual cards, just applied to the sum instead of hiding the whole
// bar over one unconfigured port.
function PvTotalBar({ label, channels }) {
  const totalWatts = channels.reduce((sum, c) => sum + (c.watts ?? 0), 0);
  const configured = channels.filter((c) => c.peakW > 0);
  const totalPeakW = configured.length ? configured.reduce((sum, c) => sum + c.peakW, 0) : null;
  return (
    <div className="pv-slot pv-slot-total">
      <PvBarContent label={label} watts={totalWatts} peakW={totalPeakW} />
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
  const allChannels = groups.flatMap((u) => u.channels);
  return (
    <>
      <SectionTitle>{t("simple.pvStrings")}</SectionTitle>
      <PvTotalBar label={t("simple.pvTotal")} channels={allChannels} />
      <div className="pv-slot-groups">
        {groups.map((u) => (
          <div key={u.sn}>
            {groups.length > 1 && <p className="pv-unit-label muted">{u.name}</p>}
            <div className="pv-slot-grid">
              {u.channels.map((c) => (
                <PvSlotBar key={c.n} channel={c} weight={c.peakW > 0 ? c.peakW : DEFAULT_WEIGHT_W} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
