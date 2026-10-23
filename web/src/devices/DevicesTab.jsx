import { useMemo, useState } from "react";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import { PLUG_COLORS } from "../plugs/PlugsTab.jsx";

// Devices tab (2026-10-23, user request — advanced view): usage-session
// history of the big consumers as a Gantt (the "B1" prototype choice):
// day strips × device rows, start–end times at the bar edges and kWh
// inside wide bars, full values (period · avg W · peak W · kWh) in the
// hover tooltip. Sessions come from /api/big-consumers/sessions, which
// replays plug_samples through the same pause-tolerant state machine as
// the simple view's "Running now" (so washer phase pauses never split a
// session). plug_samples retention (7 days) is the reach.

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

const W = 900;
const LEFT = 116;
const RIGHT = W - 16;
const ROW_H = 32;
const x = (m) => LEFT + (m / 1440) * (RIGHT - LEFT);

function Bar({ s, ry, color }) {
  const x1 = x(minutesOf(s.start));
  const x2 = s.ongoing ? x(1440) : x(minutesOf(s.end));
  const w = Math.max(5, x2 - x1);
  const title = [
    `${s.device}`,
    `${fmtTime(s.start)} – ${s.ongoing ? "…" : fmtTime(s.end)} (${fmtDur(s.start, s.end)})`,
    `avg ${s.avgW} W · peak ${s.peakW} W`,
    `${s.kwh.toFixed(2)} kWh`,
  ].join("\n");
  return (
    <g>
      <rect x={x1} y={ry + 3} width={w} height={26} rx={6} fill={color} opacity={0.88}>
        <title>{title}</title>
      </rect>
      {w > 120 ? (
        <>
          <text x={x1 + 6} y={ry + 20} fill="#0d1117" fontSize={9.5} fontWeight={700} pointerEvents="none">
            {fmtTime(s.start)}
          </text>
          <text x={x2 - 6} y={ry + 20} textAnchor="end" fill="#0d1117" fontSize={9.5} fontWeight={700} pointerEvents="none">
            {s.ongoing ? "…" : fmtTime(s.end)}
          </text>
          <text x={(x1 + x2) / 2} y={ry + 20} textAnchor="middle" fill="#0d1117" fontSize={10} fontWeight={800} pointerEvents="none">
            {s.kwh.toFixed(2)} kWh
          </text>
        </>
      ) : (
        <text x={x2 + 5} y={ry + 20} fill={color} fontSize={9.5} pointerEvents="none">
          {fmtTime(s.start)}–{s.ongoing ? "…" : fmtTime(s.end)} · {s.kwh.toFixed(2)} kWh
        </text>
      )}
    </g>
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

  // Device rows: every device with a session in the window, biggest energy
  // first; stable across days so the eye can track one appliance down the
  // strips.
  const devices = useMemo(() => {
    const kwh = new Map();
    for (const s of sessions) kwh.set(s.device, (kwh.get(s.device) ?? 0) + s.kwh);
    return [...kwh.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  }, [sessions]);
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
      {days.map(({ key, sessions: daySessions }) => {
        const stripH = 24 + devices.length * ROW_H + 6;
        return (
          <div key={key} className="card devices-day">
            <div className="devices-day-label muted">
              {new Date(`${key}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
            </div>
            <svg width="100%" viewBox={`0 0 ${W} ${stripH}`} role="img">
              {[0, 4, 8, 12, 16, 20, 24].map((h) => (
                <g key={h}>
                  <line x1={x(h * 60)} x2={x(h * 60)} y1={14} y2={14 + devices.length * ROW_H} stroke="#21262d" />
                  <text x={x(h * 60)} y={9} textAnchor="middle" className="axis" fontSize={10} fill="#6b7684">
                    {String(h).padStart(2, "0")}h
                  </text>
                </g>
              ))}
              {devices.map((dev, j) => (
                <g key={dev}>
                  <text x={LEFT - 10} y={14 + j * ROW_H + ROW_H / 2 + 4} textAnchor="end" fill={colorOf.get(dev)} fontSize={11}>
                    {dev}
                  </text>
                  {daySessions
                    .filter((s) => s.device === dev)
                    .map((s) => (
                      <Bar key={s.start} s={s} ry={14 + j * ROW_H} color={colorOf.get(dev)} />
                    ))}
                </g>
              ))}
            </svg>
          </div>
        );
      })}
      <p className="plug-note">{t("devices.note")}</p>
    </section>
  );
}
