import { useState } from "react";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";

// Azure backup card on the Strategy tab (2026-10-17, user request): last
// backup status, "back up now", and the blob list with its GFS tier
// (7 daily · 4 weekly · 12 monthly · 1/year). Both manual actions share the
// Strategy PIN flow; restore also confirms before replacing the live DB.
export default function BackupCard() {
  const t = useT();
  const { data, refresh } = usePolledResource("/api/backup/status", { intervalMs: 60000 });
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(null);

  async function postWithPin(path, payload = {}) {
    let pin = sessionStorage.getItem("strategyPin");
    if (pin == null) {
      pin = window.prompt(t("pin.body"));
      if (pin == null) return null;
    }
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, pin }),
    });
    const s = await r.json();
    if (r.status === 403) {
      sessionStorage.removeItem("strategyPin");
      const wrong = `${t("pin.wrong")}${s.attemptsLeft != null ? ` — ${t("pin.attemptsLeft", { n: s.attemptsLeft })}` : ""}`;
      window.alert(s.locked ? t("pin.locked") : wrong);
      return null;
    }
    sessionStorage.setItem("strategyPin", pin);
    return { r, s };
  }

  async function backUpNow() {
    setBusy(true);
    try {
      const result = await postWithPin("/api/backup/now");
      if (!result) return;
      const { r, s } = result;
      if (!r.ok || !s.ok) window.alert(s.error ?? t("backup.failed"));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function restore(name) {
    if (!window.confirm(t("backup.restoreConfirm", { date: name.slice(11, 21) }))) return;
    setRestoring(name);
    try {
      const result = await postWithPin("/api/backup/restore", { name });
      if (!result) return;
      const { r, s } = result;
      if (!r.ok || !s.ok) {
        window.alert(s.error ?? t("backup.failed"));
        return;
      }
      window.alert(t("backup.restoreStarted"));
      setTimeout(() => window.location.reload(), 20000);
    } finally {
      setRestoring(null);
    }
  }

  if (!data) return null;
  if (!data.enabled) {
    return (
      <div className="card">
        <div className="card-label">{t("backup.title")}</div>
        <p className="muted">{t("backup.disabled")}</p>
      </div>
    );
  }
  const last = data.last;
  return (
    <div className="card">
      <div className="roi-bom-head">
        <div className="card-label" style={{ margin: 0 }}>{t("backup.title")}</div>
        <button className="roi-pdf-btn" disabled={busy} onClick={backUpNow}>
          {busy ? "…" : t("backup.now")}
        </button>
      </div>
      <p className="muted">
        {last
          ? t("backup.last", {
              date: new Date(last.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
              size: last.sizeMb,
            })
          : t("backup.never")}
      </p>
      <div className="src-rows">
        {(data.backups ?? []).map((b) => (
          <div className="src-row" key={b.name}>
            <span className="src-label">
              {b.name.slice(11, 21)}
              {b.tier && <span className={`badge ok backup-tier`}>{t(`backup.tier.${b.tier}`)}</span>}
            </span>
            <span className="src-value">
              <span className="muted">{b.sizeMb} MB</span>
              <button className="activity-delete-btn" disabled={restoring != null} onClick={() => restore(b.name)}>
                {restoring === b.name ? "…" : t("backup.restore")}
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
