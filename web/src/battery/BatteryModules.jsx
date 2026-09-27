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
export default function BatteryModules({ live, constants, limits = {}, heroLvlClass, heroZoneLabel }) {
  const t = useT();
  const packs = constants?.expansionPacks ?? 0;
  if (!packs) return null;
  const modules = [
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
  ];
  const totalKwh = modules.reduce((a, m) => a + m.kwh, 0);
  const lvlOf = (soc) =>
    soc == null ? null : soc > 90 ? "lvl-full" : soc > 50 ? "lvl-high" : soc >= 20 ? "lvl-mid" : "lvl-low";
  const anyUnknown = modules.some((m) => m.soc == null);
  return (
    <div className="batt-modules">
      <div className="batt-seg" title={t("battery.modules.tip")}>
        {modules.map((m) => (
          <div key={m.key} className="batt-seg-mod" style={{ height: `${(m.kwh / totalKwh) * 100}%` }}>
            <div className={`batt-seg-fill ${lvlOf(m.soc) ?? ""}`} style={{ height: `${m.soc ?? 0}%` }} />
            <span className="batt-seg-soc">{m.soc != null ? `${m.soc} %` : "—"}</span>
          </div>
        ))}
      </div>
      <div className="batt-modules-side">
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
        <div className="batt-modules-legend">
          {modules.map((m) => (
            <div key={m.key} className="batt-modules-row">
              <span className="batt-modules-name">{m.name}</span>
              <span className="batt-modules-detail">
                {m.kwh} kWh · {m.soc != null ? `${m.soc} %` : "—"}
                {m.soh != null && ` · SOH ${m.soh} %`}
                {m.tempC != null && ` · ${Math.round(m.tempC)} °C`}
              </span>
            </div>
          ))}
          {anyUnknown && (
            <div className="batt-modules-note muted">
              {t("battery.modules.mqttNote")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
