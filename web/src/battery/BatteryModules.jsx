import { useT } from "../i18n/LanguageProvider.jsx";

// Upright segmented battery: one module per physical battery unit (main +
// expansion packs), stacked like the real hardware — solarbank (main unit)
// ON TOP, expansion battery(s) BELOW (user correction 2026-09-26: "the
// battery stack is first the solarbank and then the battery — this is how
// it's done in practice"); segment height ∝ capacity. Per-module SOC comes
// from MQTT only (main unit via 0405 a3, packs via 040a) — REST has no
// per-pack data. Modules show "—" until real per-module data arrives (an
// "≈ overall" estimate was tried for a day and rejected — identical fills
// looked fabricated). Extracted from BatteryTab.jsx 2026-09-27 so the
// simple view can render it standalone.
//
// Visual language (2026-09-28, user-provided reference pictures): a glass
// cylinder with a metallic terminal nub, each module a LIQUID fill rising
// from the bottom of its segment with a glossy surface ellipse, colored on
// the classic 5-step ramp (red → orange → yellow → lime → green) by THAT
// module's own SOC. While the unit charges/discharges, a soft light streak
// flows upward/downward through the fills (the reference's lightning arcs,
// extrapolated into an animation our flat style can carry).
// The fill paints the GRADIENT clipped at the fill level (2026-10-15,
// user request — "paint the battery with the gradient up to the level it
// is filled"): a red→orange→yellow→green→blue sweep over the usable
// window (min→max SOC), anchored to the SEGMENT — background-size is
// scaled by 100/soc with position:bottom, so a 45% fill shows red→yellow
// and a full one the whole sweep to blue. Below the min SOC the sweep
// stays red; above the max, blue.
const sweepGradient = (minPct, maxPct) => {
  const span = Math.max(1, maxPct - minPct);
  const hueAt = (t) => Math.round(4 + Math.min(1, Math.max(0, t)) * 206);
  // Lightness 45% → 36% → 29% (2026-10-15, two user requests: "reduce the
  // brightness by 20%" — the fills read too vivid at 45, then still at 36).
  const at = (socPct) => `hsl(${hueAt((socPct - minPct) / span)} 75% 29%)`;
  return (
    `linear-gradient(to top, ${at(0)} 0%, ${at(0)} ${minPct}%, ` +
    `${at(minPct + span * 0.25)} ${Math.round(minPct + span * 0.25)}%, ` +
    `${at(minPct + span * 0.5)} ${Math.round(minPct + span * 0.5)}%, ` +
    `${at(minPct + span * 0.75)} ${Math.round(minPct + span * 0.75)}%, ` +
    `${at(100)} 100%)`
  );
};

// Progressive fill color: a CONTINUOUS hue sweep with SOC (2026-09-29) —
// 2026-10-15, user request: extended to red → orange → yellow → green →
// BLUE, mapped over the USABLE window (empty = min SOC, full = max SOC —
// the account's 11/93 limits), not 0–100. hueDomain defaults to 0..100
// for callers without the account limits.
const socHue = (soc, minPct = 0, maxPct = 100) => {
  const span = Math.max(1, maxPct - minPct);
  const tt = Math.min(1, Math.max(0, ((soc ?? 0) - minPct) / span));
  return 4 + tt * 206; // hue 4 (red) → 210 (blue)
};
export const fillColor = (soc, lightness, minPct = 0, maxPct = 100) =>
  `hsl(${socHue(soc, minPct, maxPct)} 75% ${lightness}%)`;

export { sweepGradient };

export default function BatteryModules({ live, constants, limits = {}, heroLvlClass, heroZoneLabel, single = false, mode = "idle", stacked = false, legend = true, legendTemps = true, showName = true, heightPx = null, slotHeightPx = null, pxPerKwh = null, hueDomain = null }) {
  const t = useT();
  // stacked (simple view, 2026-09-28): cylinder on top, ALL texts (unit
  // name, hero %, kWh, per-module legend) centered underneath — units sit
  // side by side, one column each.
  // single: the aggregate system card renders ONE segment for the whole
  // system — its "modules" are the member units, shown on their own cards.
  const packs = single ? 0 : (constants?.expansionPacks ?? 0);
  const modules = packs
    ? [
        {
          key: "main",
          name: t("battery.modules.mainUnit"),
          kwh: constants.baseCapacityKwh,
          soc: live.mainSoc ?? null,
          tempC: live.temperatureC ?? null,
          soh: null,
        },
        ...Array.from({ length: packs }, (_, i) => {
          const exp = live.expansions?.[i] ?? null;
          return {
            key: `exp${i}`,
            name: t("battery.modules.expansion", { n: i + 1 }),
            kwh: constants.expansionPackKwh,
            soc: exp?.soc ?? null,
            tempC: exp?.temperatureC ?? null,
            soh: exp?.soh ?? null,
          };
        }),
      ]
    : [
        {
          key: "unit",
          name: live.name ?? t("battery.modules.mainUnit"),
          kwh: constants?.capacityKwh ?? 1,
          soc: live.soc ?? null,
          tempC: live.temperatureC ?? null,
          soh: null,
        },
      ];
  const totalKwh = modules.reduce((a, m) => a + m.kwh, 0) || 1;
  const storedOf = (m) => (m.soc != null ? Math.round(((m.soc / 100) * m.kwh) * 100) / 100 : null);
  const anyUnknown = modules.some((m) => m.soc == null);
  // Shared capacity scale (2026-10-15, user request — "the extension has to
  // be the same size for solarbank-4 and solarbank-2; I want symmetry"):
  // when the parent passes pxPerKwh (the tallest stack's height ÷ the
  // largest capacity), EVERY kWh renders at the same pixel height across
  // all cards — a 5 kWh pack reads identically in both. The cylinder's own
  // height then IS the unit's capacity (a 15 kWh stack is taller than a
  // 6.6 kWh one); the slot reserves the tallest stack and bottom-aligns.
  const cylHeightPx = pxPerKwh ? Math.round(totalKwh * pxPerKwh) : heightPx;
  const [hueMin, hueMax] = hueDomain ? [hueDomain.minPct ?? 0, hueDomain.maxPct ?? 100] : [0, 100];
  const sweep = sweepGradient(hueMin, hueMax);
  return (
    <div className={`batt-modules${stacked ? " stacked" : ""}`}>
      {/* The slot reserves the TALLEST stack's height and bottom-aligns the
          cylinder inside it (2026-09-29, user report: cylinders top-aligned
          on desktop) — margin-top:auto on the segment never engaged because
          the flex column had no free main-axis space. */}
      <div
        className="batt-seg-slot"
        style={slotHeightPx ? { minHeight: `${slotHeightPx}px` } : undefined}
      >
        <div
          className="batt-seg"
          style={cylHeightPx ? { height: `${cylHeightPx}px` } : undefined}
          title={t("battery.modules.tip")}
        >
        {modules.map((m) => (
          <div
            key={m.key}
            className="batt-seg-mod"
            style={{ height: pxPerKwh ? `${Math.round(m.kwh * pxPerKwh)}px` : `${(m.kwh / totalKwh) * 100}%` }}
          >
            <div
              className="batt-seg-fill"
              style={{
                height: `${m.soc ?? 0}%`,
                ...(m.soc != null
                  ? {
                      background: sweep,
                      // Anchor the sweep to the SEGMENT: the fill box is
                      // soc% of it, so scale the background by 100/soc and
                      // pin it to the bottom — the visible fill always shows
                      // the gradient's lower portion.
                      backgroundSize: `100% ${(100 / Math.max(m.soc ?? 0, 2)) * 100}%`,
                      backgroundPosition: "bottom",
                    }
                  : {}),
              }}
            />
            <span className="batt-seg-soc">{m.soc != null ? `${m.soc} %` : "—"}</span>
            <span className="batt-seg-kwh">
              {storedOf(m) != null ? `${storedOf(m)} kWh` : ""}
            </span>
          </div>
        ))}
        {/* Energy animation while charging/discharging (2026-10-04,
            replaces the old falling-drops "rain" — user picked the
            "layered double-surge" pulse + bubbles design after a few
            rounds of options, then corrected the direction: "when the
            battery is charging the direction should be down for both
            bubbles and waves" — charging pours in top → bottom, growing
            as it goes; discharging is the mirror, rising bottom → top
            and shrinking as it leaves). Two offset glow bands travel the
            full cylinder plus small bubbles riding the same direction.
            Bubbles run the WHOLE tube height, not just the current
            liquid level ("shown also outside of the charged area").
            Below the segment labels (they keep z-index 1). */}
        {mode !== "idle" && (
          <div
            className={`batt-energy ${mode === "charging" ? "charging" : "discharging"}`}
            style={{ "--energy-color": fillColor(live.soc ?? 50, 44, hueMin, hueMax) }}
          >
            <span className="batt-pulse" />
            <span className="batt-pulse slow" />
            <i className="batt-bubble" />
            <i className="batt-bubble" />
            <i className="batt-bubble" />
            <i className="batt-bubble" />
            <i className="batt-bubble" />
          </div>
        )}
        </div>
      </div>
      <div className="batt-modules-side">
        {/* The name rides at the TOP of the flip-tile card instead
            (2026-10-16, user request — "put the name of the banks on top of
            the tile") — SimpleHome renders it there and passes
            showName={false}. */}
        {stacked && showName && live.name && <div className="batt-modules-title">{live.name}</div>}
        <div className="batt-modules-hero">
          <span className="batt-gauge-pct">
            {live.soc ?? 0} %{heroZoneLabel && <span className={`batt-gauge-zone ${heroLvlClass}`}>{heroZoneLabel}</span>}
          </span>
          <span className="batt-gauge-kwh">
            {live.storedKwh != null && constants?.capacityKwh != null
              ? t("battery.storedKwh", { stored: live.storedKwh, total: constants.capacityKwh })
              : t("battery.capacityNa")}
          </span>
          {(limits.minPct != null || limits.maxPct != null) && (
            <span className="batt-modules-limits muted">
              {limits.minPct != null && t("battery.gauge.min", { pct: limits.minPct })}
              {limits.floorPct != null &&
                limits.floorPct !== limits.minPct &&
                ` · ${t("battery.gauge.floor", { pct: limits.floorPct })}`}
              {limits.maxPct != null && ` · ${t("battery.gauge.max", { pct: limits.maxPct })}`}
            </span>
          )}
        </div>
        {legend && (
        <div className="batt-modules-legend">
          {modules.map((m) => (
            <div key={m.key} className="batt-modules-row">
              <span className="batt-modules-name">{m.name}</span>
              <span className="batt-modules-detail">
                {/*  between a number and its unit — the line may wrap
                    at the " · " separators but never split "100 %". */}
                {storedOf(m) != null ? `${storedOf(m)} / ${m.kwh} kWh` : `${m.kwh} kWh`} ·{" "}
                {m.soc != null ? `${m.soc} %` : "—"}
                {m.soh != null && ` · SOH ${m.soh} %`}
                {/* legendTemps=false on the flip FRONT (2026-10-16, user
                    request: "without the temperatures"). */}
                {legendTemps && m.tempC != null && ` · ${Math.round(m.tempC)} °C`}
              </span>
            </div>
          ))}
          {anyUnknown && (
            <div className="batt-modules-note muted">
              {t("battery.modules.mqttNote")}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
