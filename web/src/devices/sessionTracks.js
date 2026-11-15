export function sessionEndMs(session, nowMs) {
  return session.ongoing ? nowMs : session.end;
}

export function sessionGeometryMinutes(session, nowMs) {
  const startDay = new Date(session.start);
  const currentDay = new Date(nowMs);
  startDay.setHours(0, 0, 0, 0);
  currentDay.setHours(0, 0, 0, 0);
  if (session.ongoing && startDay.getTime() !== currentDay.getTime()) return 1440;
  const end = new Date(sessionEndMs(session, nowMs));
  return end.getHours() * 60 + end.getMinutes() + end.getSeconds() / 60;
}

export function dayStartMs(ts) {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function nextDayStartMs(ts) {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

export function dayHourFraction(hour, dayStart) {
  const dayEnd = nextDayStartMs(dayStart);
  const date = new Date(dayStart);
  const tick = hour === 24 ? dayEnd : new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour).getTime();
  return (tick - dayStart) / (dayEnd - dayStart);
}

export function shortDeviceName(name) {
  return name.length > 16 ? `${name.slice(0, 15)}…` : name;
}

export function recentDayStarts(nowMs, count) {
  const days = [];
  let cursor = dayStartMs(nowMs);
  for (let i = 0; i < count; i++) {
    days.push(cursor);
    const date = new Date(cursor);
    cursor = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1).getTime();
  }
  return days;
}

export function sessionDayFractions(session, dayStart, nowMs) {
  const dayEnd = nextDayStartMs(dayStart);
  const start = Math.max(session.start, dayStart);
  const end = Math.min(sessionEndMs(session, nowMs), dayEnd);
  return { start: (start - dayStart) / (dayEnd - dayStart), end: (end - dayStart) / (dayEnd - dayStart) };
}

export function sessionTrackX(track, count, center) {
  return center + (track - (count - 1) / 2) * 18;
}

export function sessionLabelAnchor(lane, count, center) {
  const outerTrack = lane === 0 ? count - 1 : 0;
  return sessionTrackX(outerTrack, count, center) + (lane === 0 ? 18 : -18);
}

export function assignSessionTracks(sessions, nowMs = Date.now(), minDurationMs = 0) {
  const trackOf = new Map();
  const ends = [];
  const ordered = [...sessions].sort((a, b) => a.start - b.start || sessionEndMs(a, nowMs) - sessionEndMs(b, nowMs));
  for (const session of ordered) {
    const effectiveEnd = Math.max(sessionEndMs(session, nowMs), session.start + minDurationMs);
    let track = ends.findIndex((end) => end <= session.start);
    if (track < 0) track = ends.length;
    ends[track] = effectiveEnd;
    trackOf.set(session, track);
  }
  return { trackOf, count: ends.length };
}
