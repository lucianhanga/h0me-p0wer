import { sessionEndMs } from "../devices/sessionTracks.js";

export function summarizeTodaySessions(sessions, nowMs) {
  const byDevice = new Map();
  for (const session of sessions) {
    const current = byDevice.get(session.device) ?? {
      device: session.device,
      colorIdx: session.colorIdx,
      kwh: 0,
      sessionCount: 0,
      latest: null,
    };
    current.kwh += session.kwh;
    current.sessionCount += 1;
    if (!current.latest || session.start > current.latest.start) current.latest = session;
    byDevice.set(session.device, current);
  }
  return [...byDevice.values()]
    .map(({ latest, ...summary }) => ({
      ...summary,
      kwh: Math.round(summary.kwh * 100) / 100,
      running: latest.ongoing,
      activityTs: sessionEndMs(latest, nowMs),
      durationMin: Math.max(1, Math.round((sessionEndMs(latest, nowMs) - latest.start) / 60000)),
      latestStart: latest.start,
    }))
    .sort((a, b) => Number(b.running) - Number(a.running) || b.activityTs - a.activityTs || b.latestStart - a.latestStart)
    .map(({ latestStart, ...summary }) => summary);
}
