import { usePolledResource } from "../usePolledResource.js";
import { useT, useLanguage } from "../i18n/LanguageProvider.jsx";

// AI day briefing — the simple view's FIRST section (2026-10-03, user
// request): greeting, forecasted weather (emojis), forecasted production
// for the installed capacity, and the expected house consumption split
// (grid / battery / end-of-day SOC). Generated once per day per language
// on the server (kv-cached by date), so this polls rarely — it only needs
// to appear once after mount or a language switch.
export default function DayBrief() {
  const t = useT();
  const { language } = useLanguage();
  const { data } = usePolledResource(`/api/daybrief?lang=${language}`, { intervalMs: 15 * 60 * 1000 });
  if (!data) return null; // generating (first request of the day) — no layout shift
  const u = data.usage ?? {};
  return (
    <section className="daybrief">
      <div className="daybrief-greeting">{data.greeting}</div>
      <div className="daybrief-weather">{data.weatherText}</div>
      <div className="daybrief-metrics">
        {data.forecastPvKwh != null && (
          <div className="daybrief-metric">
            <span className="daybrief-icon">☀️</span>
            <span className="daybrief-value wx-c-pv">≈ {data.forecastPvKwh} kWh</span>
            <span className="daybrief-label">
              {t("simple.brief.forecastPv", { kwp: data.peakKwp })}
            </span>
          </div>
        )}
        {u.houseKwh != null && (
          <div className="daybrief-metric">
            <span className="daybrief-icon">🏠</span>
            <span className="daybrief-value">≈ {u.houseKwh} kWh</span>
            <span className="daybrief-label">{t("simple.brief.houseTotal")}</span>
          </div>
        )}
        {u.gridKwh != null && (
          <div className="daybrief-metric">
            <span className="daybrief-icon">🔌</span>
            <span className="daybrief-value wx-c-grid">≈ {u.gridKwh} kWh</span>
            <span className="daybrief-label">{t("simple.brief.fromGrid")}</span>
          </div>
        )}
        {u.batteryKwh != null && (
          <div className="daybrief-metric">
            <span className="daybrief-icon">🔋</span>
            <span className="daybrief-value wx-c-batt">≈ {u.batteryKwh} kWh</span>
            <span className="daybrief-label">{t("simple.brief.fromBattery")}</span>
          </div>
        )}
        {u.batteryEndPct != null && (
          <div className="daybrief-metric">
            <span className="daybrief-icon">🌙</span>
            <span className="daybrief-value">≈ {u.batteryEndPct} %</span>
            <span className="daybrief-label">{t("simple.brief.batteryEnd")}</span>
          </div>
        )}
      </div>
      {data.note && <div className="daybrief-note muted">{data.note}</div>}
    </section>
  );
}
