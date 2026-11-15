import { useEffect, useState } from "react";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import SectionTitle from "../components/SectionTitle.jsx";
import FlipTile from "../components/FlipTile.jsx";
import { PLUG_COLORS } from "../plugs/PlugsTab.jsx";
import { assignSessionTracks, dayHourFraction, dayStartMs, nextDayStartMs, recentDayStarts, sessionDayFractions, sessionEndMs } from "../devices/sessionTracks.js";

const W = 460;
const HOURS = [0, 6, 12, 18, 24];
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDur = (a, b) => {
  const minutes = Math.max(1, Math.round((b - a) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes} min`;
};
const colorOf = (session, i) => PLUG_COLORS[(session.colorIdx ?? i) % PLUG_COLORS.length];
const tipOf = (session, nowMs) => [
  session.device,
  `${fmtTime(session.start)} – ${session.ongoing ? "…" : fmtTime(session.end)} (${fmtDur(session.start, sessionEndMs(session, nowMs))})`,
  `${session.avgW} W avg · ${session.peakW} W peak · ${session.kwh.toFixed(2)} kWh`,
].join("\n");
const overlapsDay = (session, dayStart, nowMs) => {
  const dayEnd = nextDayStartMs(dayStart);
  return session.start < dayEnd && sessionEndMs(session, nowMs) > dayStart;
};

function SessionTextSummary({ sessions, nowMs }) {
  return (
    <ul className="visually-hidden">
      {sessions.map((session) => <li key={`${session.device}-${session.start}`}>{tipOf(session, nowMs)}</li>)}
    </ul>
  );
}

function DeviceLegend({ sessions }) {
  const devices = new Map();
  for (const session of sessions) {
    if (!devices.has(session.device)) devices.set(session.device, colorOf(session, devices.size));
  }
  return (
    <div className="simple-devices-legend">
      {[...devices].map(([device, color]) => (
        <span className="simple-devices-legend-item" key={device}>
          <span className="simple-devices-legend-dot" style={{ background: color }} aria-hidden="true" />
          {device}
        </span>
      ))}
    </div>
  );
}

function TodayTimeline({ sessions, nowMs, emptyLabel, title }) {
  const dayStart = dayStartMs(nowMs);
  const today = sessions.filter((s) => overlapsDay(s, dayStart, nowMs));
  const { trackOf, count } = assignSessionTracks(today, nowMs);
  return (
    <>
      <DeviceLegend sessions={today} />
      {!today.length ? <p className="muted simple-devices-empty">{emptyLabel}</p> : (
        <>
          <svg className="simple-devices-chart" viewBox={`0 0 ${W} ${32 + count * 17}`} role="img">
            <title>{title}</title>
            {HOURS.map((hour) => (
              <text key={hour} className="simple-devices-hour" x={dayHourFraction(hour, dayStart) * W} y={12} textAnchor={hour === 0 ? "start" : hour === 24 ? "end" : "middle"}>
                {String(hour).padStart(2, "0")}:00
              </text>
            ))}
            {today.map((session, i) => {
              const track = trackOf.get(session);
              const { start, end } = sessionDayFractions(session, dayStart, nowMs);
              const color = colorOf(session, i);
              const y = 22 + track * 17;
              return (
                <g key={`${session.device}-${session.start}`}>
                  <rect className="simple-devices-lane" x={0} y={y} width={W} height={13} rx={3} />
                  <rect x={start * W} y={y + 2} width={Math.max(2, (end - start) * W)} height={9} rx={3} fill={color}>
                    <title>{tipOf(session, nowMs)}</title>
                  </rect>
                </g>
              );
            })}
          </svg>
          <SessionTextSummary sessions={today} nowMs={nowMs} />
        </>
      )}
    </>
  );
}

function WeekTimeline({ sessions, nowMs, emptyLabel }) {
  return (
    <>
      <DeviceLegend sessions={sessions} />
      <div className="simple-devices-week">
        {recentDayStarts(nowMs, 7).map((dayStart) => {
          const daySessions = sessions.filter((s) => overlapsDay(s, dayStart, nowMs));
          const { trackOf, count } = assignSessionTracks(daySessions, nowMs);
          const label = new Date(dayStart).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
          const height = Math.max(44, count * 13 + 26);
          return (
            <div className="simple-devices-week-day" key={dayStart}>
              <div className="simple-devices-week-label muted">{label}</div>
              {!daySessions.length ? (
                <span className="simple-devices-week-empty muted">{emptyLabel}</span>
              ) : (
                <>
                  <svg className="simple-devices-chart" viewBox={`0 0 ${W} ${height}`} role="img">
                    <title>{label}</title>
                    {HOURS.map((hour) => {
                      const x = dayHourFraction(hour, dayStart) * W;
                      return <text key={hour} className="simple-devices-hour" x={x} y={12} textAnchor={hour === 0 ? "start" : hour === 24 ? "end" : "middle"}>{String(hour).padStart(2, "0")}:00</text>;
                    })}
                    {daySessions.map((session, i) => {
                      const track = trackOf.get(session);
                      const { start, end } = sessionDayFractions(session, dayStart, nowMs);
                      const color = colorOf(session, i);
                      const y = 20 + track * 13;
                      return (
                        <g key={`${session.device}-${session.start}`}>
                          <rect className="simple-devices-lane" x={0} y={y} width={W} height={13} rx={3} />
                          <rect x={start * W} y={y + 2} width={Math.max(2, (end - start) * W)} height={9} rx={3} fill={color}>
                            <title>{tipOf(session, nowMs)}</title>
                          </rect>
                        </g>
                      );
                    })}
                  </svg>
                  <SessionTextSummary sessions={daySessions} nowMs={nowMs} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function SimpleDevicesTodayContent({ fromMs, toMs }) {
  const t = useT();
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const { data } = usePolledResource(`/api/big-consumers/sessions?from=${fromMs}&to=${toMs}`, {
    intervalMs: 60000,
    keepLastGoodOnError: true,
    cacheTtlMs: 60000,
  });
  const sessions = data?.sessions ?? [];
  if (!sessions.length) return null;
  return (
    <>
      <SectionTitle>{t("nav.devices")}</SectionTitle>
      <FlipTile
        className="simple-devices-tile"
        back={(flipped) => flipped ? (
          <div className="card simple-devices-card">
            <div className="simple-devices-face-title">{t("devices.week")}</div>
            <WeekTimeline sessions={sessions} nowMs={nowMs} emptyLabel={t("devices.emptyDay")} />
          </div>
        ) : null}
      >
        <div className="card simple-devices-card">
          <div className="simple-devices-face-title">{t("devices.today")}</div>
          <TodayTimeline sessions={sessions} nowMs={nowMs} emptyLabel={t("devices.emptyDay")} title={t("devices.today")} />
        </div>
      </FlipTile>
    </>
  );
}

export default function SimpleDevicesToday() {
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 6);
  fromDate.setHours(0, 0, 0, 0);
  const today = new Date();
  const toDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  return <SimpleDevicesTodayContent key={dayStartMs(Date.now())} fromMs={fromDate.getTime()} toMs={toDate.getTime()} />;
}
