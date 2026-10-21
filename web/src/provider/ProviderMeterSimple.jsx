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
    <div className="card plug-card provider-meter-simple">
      <div className="plug-card-head">
        <div className="plug-card-title">
          <span className="plug-name">{t("provider.title")}</span>
          <span className="plug-sub">{t("provider.official")}</span>
        </div>
        <div className="plug-card-stats">
          <span className="plug-watts">
            {provider.powerW != null ? `${Math.round(provider.powerW)} W` : "—"}
          </span>
          <span className="plug-kwh">{provider.importKwh.toFixed(3)} kWh</span>
        </div>
      </div>
      <div className="src-rows">
        <div className="src-row">
          <span className="src-label">{t("provider.sourceLabel")}</span>
          <span className="src-value muted">{t(`provider.source.${provider.powerSource}`)}</span>
        </div>
        <div className="src-row">
          <span className="src-label">{t("provider.tracked")}</span>
          <span className="src-value">{provider.trackedImportKwh.toFixed(3)} kWh</span>
        </div>
        {check && (
          <div className="src-row">
            <span className="src-label">{t("provider.accuracy")}</span>
            <span className="src-value">
              {check.deviationKwh >= 0 ? "+" : ""}{check.deviationKwh.toFixed(3)} kWh · {check.deviationPct != null ? `${check.deviationPct >= 0 ? "+" : ""}${check.deviationPct}%` : "—"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
