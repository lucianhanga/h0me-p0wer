import { useMemo, useState } from "react";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import { PLUG_COLORS } from "../plugs/PlugsTab.jsx";

// Devices tab (2026-10-23, user request — advanced view): usage-session
// history of the big consumers as a vertical timeline (prototype pick
// "M2", extended to ALL screens — phone and desktop render identically).
// Per day, time flows down a CENTERED line; sessions are blocks on it
// with a 3-line label (name / times·duration·kWh / avg·peak) in
// alternating side lanes that never collide (preferred lane blocked →
// other lane → slide below). Hour labels sit ON the line with a
// card-colored punch-through so lane text never touches them. Full
// values also in the hover tooltip. Sessions come from
// /api/big-consumers/sessions, which replays plug_samples through the
// same pause-tolerant state machine as the simple view's "Running now"
// (washer phase pauses never split a session). plug_samples retention
// (7 days) is the reach.

const DAY_MS = 86400000;
const SPANS = [
  { ms: 3 * DAY_MS, key: "devices.span3" },
  { ms: 7 * DAY_MS, key: "devices.span7" },
];

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDur = (a, b) => {
  const d = Math.max(1, Math.round((b - a) / 60000));
  return d >= 60 ? `${Math.floor(d / 60)}h ${String(d % 60).padStart(2, "0")}m` : `${d} min`;
};
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const minutesOf = (ts) => {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};

const MW = 420;
const CX = MW / 2; // timeline exactly centered — symmetric label lanes
const LANE_LABEL_H = 36;
const LANE_GAP = 6;

function DayTimeline({ dayLabelText, sessions, colorOf, emptyLabel }) {
  const minS = sessions.length ? Math.min(...sessions.map((s) => minutesOf(s.start))) - 45 : 0;
  const maxE = sessions.length ? Math.max(...sessions.map((s) => (s.ongoing ? 1440 : minutesOf(s.end)))) + 30 : 0;
  const H = Math.max(200, (maxE - minS) * 1.1);
  const y = (m) => 26 + ((m - minS) / (maxE - minS)) * (H - 40);
  const lanes = [{ bottom: -1e9 }, { bottom: -1e9 }]; // 0 = right, 1 = left
  const placed = [...sessions]
    .sort((a, b) => a.start - b.start)
    .map((s, i) => {
      const midY = (y(minutesOf(s.start)) + y(s.ongoing ? 1440 : minutesOf(s.end))) / 2;
      let top = midY - LANE_LABEL_H / 2;
      let lane = i % 2;
      if (lanes[lane].bottom + LANE_GAP > top) {
        const other = 1 - lane;
        if (lanes[other].bottom + LANE_GAP <= top) lane = other;
        else {
          lane = lanes[0].bottom <= lanes[1].bottom ? 0 : 1;
          top = lanes[lane].bottom + LANE_GAP; // both blocked — slide down
        }
      }
      lanes[lane].bottom = top + LANE_LABEL_H;
      return { s, top, lane };
    });
  const tipOf = (s) =>
    [
      s.device,
      `${fmtTime(s.start)} – ${s.ongoing ? "…" : fmtTime(s.end)} (${fmtDur(s.start, s.end)})`,
      `avg ${s.avgW} W · peak ${s.peakW} W · ${s.kwh.toFixed(2)} kWh`,
    ].join("\n");
  return (
    <div className="card devices-day">
      <div className="devices-day-label muted">{dayLabelText}</div>
      {!sessions.length && <p className="muted" style={{ margin: "2px 0", fontSize: 12 }}>{emptyLabel}</p>}
      {sessions.length > 0 && (
        <svg width="100%" viewBox={`0 0 ${MW} ${H}`} role="img">
          {Array.from(
            { length: Math.floor(maxE / 60) - Math.ceil(minS / 60) + 1 },
            (_, k) => Math.ceil(minS / 60) + k,
          ).map((h) => (
            // Hour labels sit ON the centered line: a card-colored rect
            // punches a hole in the line so the label stays readable and —
            // more importantly — no lane text can ever overlap an hour
            // label (they live on the axis, not in the lanes).
            <g key={h}>
              <rect x={CX - 18} y={y(h * 60) - 6} width={36} height={12} rx={4} fill="#1a2128" />
              <text x={CX} y={y(h * 60) + 3.5} textAnchor="middle" fill="#6b7684" fontSize={9}>
                {String(h).padStart(2, "0")}:00
              </text>
            </g>
          ))}
          <line x1={CX} x2={CX} y1={24} y2={H - 12} stroke="#444c56" strokeWidth={4} strokeLinecap="round" />
          {placed.map(({ s, top, lane }) => {
            const y1 = y(minutesOf(s.start));
            const y2 = y(s.ongoing ? 1440 : minutesOf(s.end));
            const color = colorOf.get(s.device);
            const tx = lane === 0 ? CX + 18 : CX - 18;
            const anchor = lane === 0 ? "start" : "end";
            const title = tipOf(s);
            return (
              <g key={s.start}>
                <rect x={CX - 8} y={y1} width={16} height={Math.max(6, y2 - y1)} rx={7} fill={color} opacity={0.92}>
                  <title>{title}</title>
                </rect>
                <text x={tx} y={top + 9} textAnchor={anchor} fill={color} fontSize={11.5} fontWeight={600}>
                  <title>{title}</title>
                  {s.device}
                </text>
                <text x={tx} y={top + 22} textAnchor={anchor} fill="#8b98a5" fontSize={9.5}>
                  {fmtTime(s.start)}–{s.ongoing ? "…" : fmtTime(s.end)} · {fmtDur(s.start, s.end)} · {s.kwh.toFixed(2)} kWh
                </text>
                <text x={tx} y={top + 34} textAnchor={anchor} fill="#6b7684" fontSize={9}>
                  avg {s.avgW} W · peak {s.peakW} W
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}


export default function DevicesTab() {
  const t = useT();
  const [spanMs, setSpanMs] = useState(SPANS[0].ms);
  const [from, to] = useMemo(() => {
    const end = Math.ceil(Date.now() / 300000) * 300000;
    return [end - spanMs, end];
  }, [spanMs]);
  const { data } = usePolledResource(`/api/big-consumers/sessions?from=${from}&to=${to}`, {
    intervalMs: 60000,
    keepLastGoodOnError: true,
    cacheTtlMs: 60000,
  });
  const sessions = data?.sessions ?? [];

  const colorOf = useMemo(() => {
    const m = new Map();
    for (const s of sessions) {
      if (!m.has(s.device)) m.set(s.device, PLUG_COLORS[(s.colorIdx ?? m.size) % PLUG_COLORS.length]);
    }
    return m;
  }, [sessions]);

  // One strip per LOCAL day in the window, oldest first.
  const days = useMemo(() => {
    const out = [];
    const first = new Date(from);
    first.setHours(0, 0, 0, 0);
    for (let d = first.getTime(); d < to; d += DAY_MS) out.push(dayKey(d));
    return out.map((key) => ({
      key,
      sessions: sessions.filter((s) => dayKey(s.start) === key),
    }));
  }, [from, to, sessions]);

  const dayLabelText = (key) =>
    new Date(`${key}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  return (
    <section>
      <div className="controls" style={{ marginBottom: 8 }}>
        {SPANS.map((s) => (
          <button
            key={s.ms}
            className={spanMs === s.ms ? "nav-active" : ""}
            onClick={() => setSpanMs(s.ms)}
          >
            {t(s.key)}
          </button>
        ))}
      </div>
      {data && !sessions.length && <p className="muted">{t("devices.empty")}</p>}
      {days.map(({ key, sessions: daySessions }) => (
        <DayTimeline
          key={key}
          dayLabelText={dayLabelText(key)}
          sessions={daySessions}
          colorOf={colorOf}
          emptyLabel={t("devices.emptyDay")}
        />
      ))}
      <p className="plug-note">{t("devices.note")}</p>
    </section>
  );
}
