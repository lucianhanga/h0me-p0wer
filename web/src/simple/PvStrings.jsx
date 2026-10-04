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
function PvSlotBar({ channel }) {
  const w = useTweenedWatts(channel.watts ?? 0);
  const pct = channel.peakW > 0 ? Math.min(100, Math.round(((channel.watts ?? 0) / channel.peakW) * 100)) : null;
  return (
    <div className="pv-slot">
      <div className="pv-slot-label">
        <span>{channel.name}</span>
        <span>
          {w} W{pct != null ? ` · ${pct}%` : ""}
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
                <PvSlotBar key={c.n} channel={c} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
