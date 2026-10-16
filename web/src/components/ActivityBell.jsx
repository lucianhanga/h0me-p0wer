import { useEffect, useMemo, useRef, useState } from "react";
import { usePolledResource } from "../usePolledResource.js";
import { useLiveStream } from "../useLiveStream.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import SpeakButton from "./SpeakButton.jsx";

// Activity log in the header (2026-09-27, user request — "some activity log
// where you log these major decisions and the user can see them and have
// them read loud... a new entry should somehow notify you"): a bell with an
// unread badge (watermark in localStorage), instant notification via the WS
// {type:"activity"} push (plus a 20 s poll baseline), and a panel where
// every entry renders in the selected language and is readable aloud.
const SEEN_KEY = "h0mep0wer.activitySeenAt";

export function activityText(t, entry) {
  const p = entry.params ?? {};
  switch (entry.kind) {
    case "meter":
      return t(`activity.meter.${p.state}`);
    case "mqtt":
      return t(`activity.mqtt.${p.state}`);
    case "native_mode":
      return t(`activity.nativeMode.${p.on ? "on" : "off"}`);
    case "manual_discharge":
      return t(`activity.manualDischarge.${p.on ? "on" : "off"}`);
    case "floor_guard":
      return t(`activity.floorGuard.${p.phase}`, p);
    case "gridCharge":
      return t(`activity.gridCharge.${p.state}`, p);
    default:
      return t(`activity.${entry.kind}`, p);
  }
}

export default function ActivityBell() {
  const t = useT();
  const { data, refresh } = usePolledResource("/api/activity?limit=50", { intervalMs: 20000 });
  const [open, setOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  // Selection for bulk delete (2026-10-16, user request — "select one, all,
  // then remove"): a checkbox per row, a select-all checkbox in the toolbar
  // (indeterminate when partial), delete-selected + clear-all with confirm.
  const [selected, setSelected] = useState(() => new Set());
  // Watermark of what's been seen (persisted); prevSeenAt freezes the
  // watermark at panel-open time so entries stay highlighted in the panel.
  const [seenAt, setSeenAt] = useState(() => Number(localStorage.getItem(SEEN_KEY) ?? 0));
  const [prevSeenAt, setPrevSeenAt] = useState(0);

  const entries = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const unseen = entries.filter((e) => e.ts > seenAt).length;

  // Drop selected ids that no longer exist (delete, another client, prune).
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(entries.map((e) => e.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

  const allSelected = entries.length > 0 && selected.size === entries.length;

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.id)));
  }

  async function deleteSelected() {
    if (!selected.size) return;
    if (!window.confirm(t("activity.confirmDeleteSelected", { n: selected.size }))) return;
    await fetch("/api/activity/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selected] }),
    });
    setSelected(new Set());
    refresh();
  }

  async function clearAll() {
    if (!window.confirm(t("activity.confirmClear"))) return;
    await fetch("/api/activity/clear", { method: "POST" });
    setSelected(new Set());
    refresh();
  }

  // Instant notification on WS push — the badge lights without the poll.
  const streamMsg = useLiveStream();
  useEffect(() => {
    if (streamMsg?.type !== "activity") return;
    refresh();
    setPulse(true);
    const timer = setTimeout(() => setPulse(false), 3000);
    return () => clearTimeout(timer);
  }, [streamMsg, refresh]);

  // Esc closes the panel (standard popover behavior).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function openPanel() {
    setPrevSeenAt(seenAt);
    const now = entries[0]?.ts ?? Date.now();
    setSeenAt(now);
    localStorage.setItem(SEEN_KEY, String(now));
    setOpen(true);
  }

  // Owner actions on a config-drift entry (2026-10-09): accept = the change
  // was mine, adopt it as the new baseline; revert = write the baseline
  // schedule back. Both are PIN-protected server-side; the PIN is shared
  // with the strategy gate's sessionStorage entry, asked once per session.
  async function driftAction(action) {
    let pin = sessionStorage.getItem("strategyPin");
    if (pin == null) {
      pin = window.prompt(t("pin.body"));
      if (pin == null) return;
    }
    const r = await fetch(`/api/security/drift/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const s = await r.json();
    if (r.status === 403) {
      sessionStorage.removeItem("strategyPin");
      window.alert(s.locked ? t("pin.locked") : t("pin.wrong"));
      return;
    }
    if (!r.ok || !s.ok) {
      window.alert(s.error ?? `HTTP ${r.status}`);
      return;
    }
    sessionStorage.setItem("strategyPin", pin);
    refresh();
  }

  return (
    <>
      <button
        className={`activity-bell${pulse ? " activity-bell-pulse" : ""}`}
        onClick={() => (open ? setOpen(false) : openPanel())}
        title={t("activity.panelTitle")}
        aria-label={t("activity.panelTitle")}
      >
        🔔
        {unseen > 0 && !open && <span className="activity-dot" />}
      </button>
      {open && (
        <div className="ask-backdrop" onClick={() => setOpen(false)}>
          <div className="ask-panel activity-panel card" onClick={(e) => e.stopPropagation()}>
            <button className="ask-close" onClick={() => setOpen(false)} aria-label={t("ask.close")}>
              ×
            </button>
            <h4>{t("activity.panelTitle")}</h4>
            {entries.length === 0 && <p className="muted">{t("common.noData")}</p>}
            {entries.length > 0 && (
              <div className="activity-toolbar">
                <label className="activity-select-all">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && !allSelected;
                    }}
                    onChange={toggleAll}
                  />
                  {t("activity.selectAll")}
                </label>
                <span className="activity-toolbar-actions">
                  <button
                    className="activity-delete-btn"
                    disabled={selected.size === 0}
                    onClick={deleteSelected}
                  >
                    {t("activity.deleteSelected", { n: selected.size })}
                  </button>
                  <button className="activity-delete-btn activity-clear-btn" onClick={clearAll}>
                    {t("activity.clearAll")}
                  </button>
                </span>
              </div>
            )}
            <div className="activity-list">
              {entries.map((e) => {
                const text = activityText(t, e);
                const d = new Date(e.ts);
                const sameDay = d.toDateString() === new Date().toDateString();
                const time = sameDay
                  ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                  : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
                return (
                  <div key={e.id} className={`activity-row${e.ts > prevSeenAt ? " activity-new" : ""}`}>
                    <input
                      type="checkbox"
                      className="activity-check"
                      checked={selected.has(e.id)}
                      onChange={() => toggleOne(e.id)}
                      aria-label={t("activity.selectRow")}
                    />
                    <span className="activity-time muted">{time}</span>
                    <span className="activity-text">
                      {text}
                      {e.kind === "config_drift" && (
                        <span className="drift-actions">
                          <button onClick={() => driftAction("accept")}>
                            {t("activity.drift.accept")}
                          </button>
                          {e.params?.field === "schedule" && (
                            <button onClick={() => driftAction("revert")}>
                              {t("activity.drift.revert")}
                            </button>
                          )}
                        </span>
                      )}
                    </span>
                    <SpeakButton id={`activity-${e.id}`} text={text} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
