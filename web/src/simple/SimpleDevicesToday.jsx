import { useEffect, useState } from "react";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import SectionTitle from "../components/SectionTitle.jsx";
import FlipTile from "../components/FlipTile.jsx";
import { PLUG_COLORS } from "../plugs/PlugsTab.jsx";
import { assignSessionTracks, dayHourFraction, dayStartMs, nextDayStartMs, recentDayStarts, sessionDayFractions, sessionEndMs, shortDeviceName } from "../devices/sessionTracks.js";

const W = 460;
const CHART_X = 112;
const CHART_W = 336;
const HOURS = [0, 6, 12, 18, 24];
const WEEK_MIN_DURATION_MS = 4 * 3600000;
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

function TodayTimeline({ sessions, nowMs, emptyLabel, title }) {
  const dayStart = dayStartMs(nowMs);
  const today = sessions.filter((s) => overlapsDay(s, dayStart, nowMs));
  if (!today.length) return <p className="muted simple-devices-empty">{emptyLabel}</p>;
  const { trackOf, count } = assignSessionTracks(today, nowMs);
  const height = 48 + count * 24;
  const seenLabels = new Set();
  return (
    <>
      <svg className="simple-devices-chart" viewBox={`0 0 ${W} ${height}`} role="img">
        <title>{title}</title>
        {HOURS.map((hour) => (
          <text key={hour} className="simple-devices-hour" x={CHART_X + dayHourFraction(hour, dayStart) * CHART_W} y={14} textAnchor={hour === 0 ? "start" : hour === 24 ? "end" : "middle"}>
            {String(hour).padStart(2, "0")}:00
          </text>
        ))}
        {today.map((session, i) => {
          const track = trackOf.get(session);
          const { start, end } = sessionDayFractions(session, dayStart, nowMs);
          const color = colorOf(session, i);
          const y = 28 + track * 24;
          const labelKey = `${track}-${session.device}`;
          const showLabel = !seenLabels.has(labelKey);
          seenLabels.add(labelKey);
          return (
            <g key={`${session.device}-${session.start}`}>
              {showLabel && (
                <text className="simple-devices-name" x={0} y={y + 11} fill={color}>
                  <title>{session.device}</title>
                  {shortDeviceName(session.device)}
                </text>
              )}
              <rect x={CHART_X + start * CHART_W} y={y} width={Math.max(2, (end - start) * CHART_W)} height={15} rx={5} fill={color}>
                <title>{tipOf(session, nowMs)}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <SessionTextSummary sessions={today} nowMs={nowMs} />
    </>
  );
}

function WeekTimeline({ sessions, nowMs, emptyLabel }) {
  return (
    <div className="simple-devices-week">
      {recentDayStarts(nowMs, 7).map((dayStart) => {
        const daySessions = sessions.filter((s) => overlapsDay(s, dayStart, nowMs));
        const { trackOf, count } = assignSessionTracks(daySessions, nowMs, WEEK_MIN_DURATION_MS);
        const label = new Date(dayStart).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
        const height = Math.max(58, count * 12 + 30);
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
                    const y = 8 + dayHourFraction(hour, dayStart) * (height - 30);
                    return <text key={hour} className="simple-devices-hour" x={CHART_X - 5} y={y + 3} textAnchor="end">{String(hour).padStart(2, "0")}:00</text>;
                  })}
                  <line x1={CHART_X - 2} x2={CHART_X - 2} y1={8} y2={height - 20} stroke="#444c56" strokeWidth={2} />
                  {daySessions.map((session, i) => {
                    const track = trackOf.get(session);
                    const { start, end } = sessionDayFractions(session, dayStart, nowMs);
                    const color = colorOf(session, i);
                    return (
                      <rect
                        key={`${session.device}-${session.start}`}
                        x={CHART_X + track * 10}
                        y={8 + start * (height - 30)}
                        width={6}
                        height={Math.max(4, (end - start) * (height - 30))}
                        rx={3}
                        fill={color}
                      >
                        <title>{tipOf(session, nowMs)}</title>
                      </rect>
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
