import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";

export default function ProviderMeterSimple() {
  const t = useT();
  const { data: provider } = usePolledResource("/api/provider-meter", {
    intervalMs: 10000,
    keepLastGoodOnError: true,
    cacheTtlMs: 10000,
  });
  const { data: accuracy } = usePolledResource("/api/provider-meter/accuracy", {
    intervalMs: 60000,
    keepLastGoodOnError: true,
    cacheTtlMs: 60000,
  });
  if (!provider?.available) return null;
  const check = (accuracy ?? []).find((r) => r.available && r.key === "24h") ?? (accuracy ?? []).find((r) => r.available);
  return (
    <div className="card provider-meter-simple">
      <div className="provider-simple-head">
        <div className="plug-card-title">
          <span className="plug-name">{t("provider.title")}</span>
          <span className="plug-sub">{t("provider.official")}</span>
        </div>
        <div className="provider-odometer">
          <span>{t("provider.meterReading")}</span>
          <strong>{provider.importKwh.toFixed(3)} kWh</strong>
        </div>
      </div>
      <div className="provider-simple-metrics">
        <div className="provider-metric">
          <span>{t("provider.power")}</span>
          <strong>{provider.powerW != null ? `${Math.round(provider.powerW)} W` : "—"}</strong>
          <small>{t(`provider.source.${provider.powerSource}`)}</small>
        </div>
        <div className="provider-metric">
          <span>{t("provider.tracked")}</span>
          <strong>{provider.trackedImportKwh.toFixed(3)} kWh</strong>
          <small>{t("provider.sinceTracking")}</small>
        </div>
        {check && (
          <div className="provider-metric">
            <span>{t("provider.accuracy")}</span>
            <strong className={check.deviationKwh >= 0 ? "wx-c-grid" : "wx-c-pv"}>
              {check.deviationKwh >= 0 ? "+" : ""}{check.deviationKwh.toFixed(3)} kWh
            </strong>
            <small>{check.deviationPct != null ? `${check.deviationPct >= 0 ? "+" : ""}${check.deviationPct}%` : "—"}</small>
          </div>
        )}
      </div>
    </div>
  );
}
