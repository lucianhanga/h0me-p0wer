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
// meter, rather than one against a guessed capacity.
// One line per port (2026-10-04 follow-up: "show them each in one line") —
// label, value, and meter share a single row instead of stacking in a
// card. Meter LENGTH is proportional to the port's own share of capacity
// (carried over from the earlier "proportional based on configured size"
// request): each port's bar is scaled against the largest configured port
// in the whole section, so a 1000 W port's bar runs twice as long as a
// 500 W one. A port with no configured peakW falls back to a 500 W weight
// (a plausible single-panel default) for that scaling, same as before.
const DEFAULT_WEIGHT_W = 500;
const LED_COUNT = 16;

// Segmented LED meter (2026-10-04 — tried as one of four flip faces, then
// the user picked this one alone: "the Segmented LED meter with the color
// gradients from the Zone gradient but ... following one color into
// another"). The row itself carries the green→amber→red gradient as its
// OWN background, unbroken; each segment is either transparent (lit —
// reveals the gradient at its own position) or a faded/visible gray
// (unlit — "show faded out the segments which are not filled in yet",
// 2026-10-04 follow-up; near-black was almost invisible against the
// page). A lit segment's color comes from WHERE it sits along the row,
// not a fixed on-color — the same smooth, no-hard-stop blend the
// zone-gradient style had, just read off in blocks.
function PvRow({ label, watts, peakW, barPct, total }) {
  const w = useTweenedWatts(watts ?? 0);
  const pct = peakW > 0 ? Math.min(100, Math.round(((watts ?? 0) / peakW) * 100)) : null;
  const lit = Math.round(((pct ?? 0) / 100) * LED_COUNT);
  return (
    <div className={`pv-row${total ? " pv-row-total" : ""}`}>
      <span className="pv-row-text">
        <span className="pv-row-name">{label}</span>{" "}
        <span className="pv-row-value">
          {w} {pct != null ? `/ ${peakW} W · ${pct}%` : "W"}
        </span>
      </span>
      <div className="pv-row-bar-wrap">
        <div className="pv-led-row" style={{ width: `${barPct}%` }}>
          {Array.from({ length: LED_COUNT }, (_, i) => (
            <div key={i} className={`pv-led${i < lit ? " on" : ""}`} />
          ))}
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
  const allChannels = groups.flatMap((u) => u.channels);
  const maxWeight = Math.max(...allChannels.map((c) => (c.peakW > 0 ? c.peakW : DEFAULT_WEIGHT_W)));
  // Total: sums every connected port's watts; the percentage only counts
  // ports with a configured peakW (2026-10-04, user request: "add on top
  // an indication of the total also like a progress bar") — same
  // "don't guess a capacity" rule as the individual rows, applied to the
  // sum instead of hiding the whole meter over one unconfigured port.
  const totalWatts = allChannels.reduce((sum, c) => sum + (c.watts ?? 0), 0);
  const configured = allChannels.filter((c) => c.peakW > 0);
  const totalPeakW = configured.length ? configured.reduce((sum, c) => sum + c.peakW, 0) : null;
  return (
    <>
      <SectionTitle>{t("simple.pvStrings")}</SectionTitle>
      <PvRow label={t("simple.pvTotal")} watts={totalWatts} peakW={totalPeakW} barPct={100} total />
      <div className="pv-rows">
        {groups.map((u) => (
          <div key={u.sn}>
            {groups.length > 1 && <p className="pv-unit-label muted">{u.name}</p>}
            {u.channels.map((c) => {
              const weight = c.peakW > 0 ? c.peakW : DEFAULT_WEIGHT_W;
              return (
                <PvRow
                  key={c.n}
                  label={c.name}
                  watts={c.watts}
                  peakW={c.peakW}
                  barPct={(weight / maxWeight) * 100}
                />
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
