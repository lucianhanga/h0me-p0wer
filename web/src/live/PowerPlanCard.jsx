import { useState } from "react";
import { usePolledResource } from "../usePolledResource.js";
import SectionTitle from "../components/SectionTitle.jsx";
import { useT } from "../i18n/LanguageProvider.jsx";

// Power Plan section: always expanded (2026-10-04, user request — "get rid
// of collapsable controls"). Shows the controller state; the output preset
// can be taken over from here, but handing it back is intentionally NOT
// offered in the UI (the /api/power-plan/disable endpoint still exists for
// that).
export default function PowerPlanCard() {
  const t = useT();
  // Same endpoint/cadence as the Strategy tab — see the matching comment
  // there.
  const { data: state, setData: setState } = usePolledResource("/api/power-plan", {
    intervalMs: 10000,
  });
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/power-plan/enable", { method: "POST" });
      const s = await r.json();
      if (!r.ok) throw new Error(s.error ?? `HTTP ${r.status}`);
      setState(s.data);
    } catch (err) {
      alert(t("powerplan.enableFailed", { message: err.message }));
    } finally {
      setBusy(false);
    }
  };

  const d = state?.lastDecision;
  return (
    <div className="power-plan">
      <SectionTitle>
        {t("powerplan.title")}
        {state?.enabled && <span className="badge ok">{t("powerplan.active")}</span>}
      </SectionTitle>
      <p className="muted">
        {state == null
          ? t("common.loading")
          : state.enabled
            ? t("powerplan.statusActive")
            : t("powerplan.statusOff")}
      </p>
      {state?.enabled && d && (
        <div className="cards">
          <div className="card">
            <div className="card-label">{t("powerplan.targetOutput")}</div>
            <div className="card-value">{d.targetW} W</div>
            <div className="card-label">
              {t("powerplan.presetValue", {
                preset: state.lastWrittenPower != null ? `${state.lastWrittenPower} W` : "—",
              })}
            </div>
          </div>
          <div className="card">
            <div className="card-label">{t("powerplan.decisionInputs")}</div>
            <div className="card-value" style={{ fontSize: "1rem" }}>
              {t("powerplan.inputs", { pv: d.pvW, house: d.demandW, soc: d.soc })}
            </div>
            <div className="card-label">
              {d.wrote ? t("powerplan.presetWritten", { reason: d.reason }) : d.reason}
              {state.lastWriteAt
                ? ` · ${t("powerplan.lastWrite", { time: new Date(state.lastWriteAt).toLocaleTimeString() })}`
                : ""}
            </div>
          </div>
        </div>
      )}
      {state && !state.enabled && (
        <button disabled={busy} onClick={enable}>
          {t("powerplan.takeOver")}
        </button>
      )}
      {state?.lastError && (
        <p className="muted">{t("powerplan.lastError", { error: state.lastError })}</p>
      )}
    </div>
  );
}
