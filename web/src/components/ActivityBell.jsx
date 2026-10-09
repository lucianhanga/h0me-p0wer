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
  // Watermark of what's been seen (persisted); prevSeenAt freezes the
  // watermark at panel-open time so entries stay highlighted in the panel.
  const [seenAt, setSeenAt] = useState(() => Number(localStorage.getItem(SEEN_KEY) ?? 0));
  const [prevSeenAt, setPrevSeenAt] = useState(0);

  const entries = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const unseen = entries.filter((e) => e.ts > seenAt).length;

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
