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

function PvSlotBar({ channel, weight }) {
  const w = useTweenedWatts(channel.watts ?? 0);
  const pct = channel.peakW > 0 ? Math.min(100, Math.round(((channel.watts ?? 0) / channel.peakW) * 100)) : null;
  return (
    <div className="pv-slot" style={{ "--pv-weight": weight }}>
      <div className="pv-slot-label">
        <span>{channel.name}</span>
        <span>
          {w} {pct != null ? `/ ${channel.peakW} W · ${pct}%` : "W"}
        </span>
      </div>
      <div className="pv-slot-track">
        <div className="pv-slot-fill" style={{ width: `${pct ?? 0}%` }} />
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
  return (
    <>
      <SectionTitle>{t("simple.pvStrings")}</SectionTitle>
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
