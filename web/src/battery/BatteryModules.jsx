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
// Progressive fill color (2026-09-29, user request): a CONTINUOUS hue
// sweep with SOC — hsl hue 4 (red, empty) → 140 (green, full) — replacing
// the 5-step class ramp (SEG_LEVELS). Applies to the module fills AND the
// energy-rain drops (via --rain-color).
const socHue = (soc) => 4 + Math.min(100, Math.max(0, soc ?? 0)) * 1.36;
const fillColor = (soc, lightness) => `hsl(${socHue(soc)} 75% ${lightness}%)`;

export default function BatteryModules({ live, constants, limits = {}, heroLvlClass, heroZoneLabel, single = false, mode = "idle", stacked = false, legend = true, heightPx = null, slotHeightPx = null }) {
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
  return (
    <div className={`batt-modules${stacked ? " stacked" : ""}`}>
      {/* The slot reserves the TALLEST stack's height and bottom-aligns the
          cylinder inside it (2026-09-29, user report: cylinders top-aligned
          on desktop) — margin-top:auto on the segment never engaged because
          the flex column had no free main-axis space. */}
      <div
        className="batt-seg-slot"
        style={stacked && slotHeightPx ? { height: `${slotHeightPx}px` } : undefined}
      >
        <div
          className="batt-seg"
          style={heightPx ? { height: `${heightPx}px` } : undefined}
          title={t("battery.modules.tip")}
        >
        {modules.map((m) => (
          <div key={m.key} className="batt-seg-mod" style={{ height: `${(m.kwh / totalKwh) * 100}%` }}>
            <div
              className="batt-seg-fill"
              style={{
                height: `${m.soc ?? 0}%`,
                ...(m.soc != null
                  ? { background: `linear-gradient(180deg, ${fillColor(m.soc, 55)}, ${fillColor(m.soc, 40)})` }
                  : {}),
              }}
            />
            <span className="batt-seg-soc">{m.soc != null ? `${m.soc} %` : "—"}</span>
            <span className="batt-seg-kwh">
              {storedOf(m) != null ? `${storedOf(m)} kWh` : ""}
            </span>
          </div>
        ))}
        {/* Energy-rain animation while charging/discharging (2026-09-29,
            user request — "something falling inside, in the same color as
            the battery load"; research convention: charging = particles
            flowing IN top-down, discharging = the mirror, drifting up and
            out). Fill-colored drops; replaces the old subtle streak.
            Below the segment labels (they keep z-index 1). */}
        {mode !== "idle" && (
          <div
            className={`batt-rain ${mode === "charging" ? "rain-in" : "rain-out"}`}
            style={{ "--rain-color": fillColor(live.soc ?? 50, 55) }}
          >
            <i />
            <i />
            <i />
            <i />
          </div>
        )}
        </div>
      </div>
      <div className="batt-modules-side">
        {stacked && live.name && <div className="batt-modules-title">{live.name}</div>}
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
                {m.tempC != null && ` · ${Math.round(m.tempC)} °C`}
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
