import { usePolledResource } from "../usePolledResource.js";
import { useT, useLanguage } from "../i18n/LanguageProvider.jsx";
import Glyph, { weatherGlyphName } from "../components/Glyph.jsx";

// AI day briefing — the simple view's FIRST section (2026-10-03, user
// request): greeting, forecasted weather, forecasted production for the
// installed capacity, and the expected house consumption split (grid /
// battery / end-of-day SOC). Generated once per day per language on the
// server (kv-cached by date). Icons are abstract stroke glyphs (Glyph.jsx)
// — no emoji (user request: "more spartan, more abstract").
export default function DayBrief() {
  const t = useT();
  const { language } = useLanguage();
  const { data } = usePolledResource(`/api/daybrief?lang=${language}`, { intervalMs: 15 * 60 * 1000 });
  if (!data) return null; // generating (first request of the day) — no layout shift
  const u = data.usage ?? {};
  const metrics = [
    data.forecastPvKwh != null && {
      icon: "sun",
      value: `≈ ${data.forecastPvKwh} kWh`,
      cls: "wx-c-pv",
      label: t("simple.brief.forecastPv", { kwp: data.peakKwp }),
    },
    u.houseKwh != null && { icon: "home", value: `≈ ${u.houseKwh} kWh`, cls: "", label: t("simple.brief.houseTotal") },
    u.gridKwh != null && { icon: "grid", value: `≈ ${u.gridKwh} kWh`, cls: "wx-c-grid", label: t("simple.brief.fromGrid") },
    u.batteryKwh != null && {
      icon: "battery",
      value: `≈ ${u.batteryKwh} kWh`,
      cls: "wx-c-batt",
      label: t("simple.brief.fromBattery"),
    },
    u.batteryEndPct != null && {
      icon: "moon",
      value: `≈ ${u.batteryEndPct} %`,
      cls: "",
      label: t("simple.brief.batteryEnd"),
    },
  ].filter(Boolean);
  return (
    <section className="daybrief">
      <div className="daybrief-greeting">{data.greeting}</div>
      <div className="daybrief-weather">
        <Glyph name={weatherGlyphName(data.weatherCode)} size={16} className="daybrief-weather-icon" />
        <span>{data.weatherText}</span>
      </div>
      <div className="daybrief-metrics">
        {metrics.map((m) => (
          <div className="daybrief-metric" key={m.icon}>
            <Glyph name={m.icon} size={19} className={`daybrief-icon ${m.cls}`} />
            <span className={`daybrief-value ${m.cls}`}>{m.value}</span>
            <span className="daybrief-label">{m.label}</span>
          </div>
        ))}
      </div>
      {data.note && <div className="daybrief-note muted">{data.note}</div>}
    </section>
  );
}
