import { useState } from "react";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";

// Azure backup card on the Strategy tab (2026-10-17, user request): last
// backup status, "back up now", and the blob list with its GFS tier
// (7 daily · 4 weekly · 12 monthly · 1/year). Restore is PIN-gated — it
// REPLACES the live DB and restarts the server (the browser reloads itself
// ~20 s later to meet the fresh process).
export default function BackupCard() {
  const t = useT();
  const { data, refresh } = usePolledResource("/api/backup/status", { intervalMs: 60000 });
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(null);

  async function backUpNow() {
    setBusy(true);
    try {
      const r = await fetch("/api/backup/now", { method: "POST" }).then((x) => x.json());
      if (!r.ok) window.alert(r.error ?? t("backup.failed"));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function restore(name) {
    if (!window.confirm(t("backup.restoreConfirm", { date: name.slice(11, 21) }))) return;
    let pin = sessionStorage.getItem("strategyPin");
    if (pin == null) {
      pin = window.prompt(t("pin.body"));
      if (pin == null) return;
    }
    setRestoring(name);
    try {
      const r = await fetch("/api/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, pin }),
      });
      const s = await r.json();
      if (r.status === 403) {
        sessionStorage.removeItem("strategyPin");
        window.alert(s.locked ? t("pin.locked") : t("pin.wrong"));
        return;
      }
      if (!r.ok || !s.ok) {
        window.alert(s.error ?? t("backup.failed"));
        return;
      }
      sessionStorage.setItem("strategyPin", pin);
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
