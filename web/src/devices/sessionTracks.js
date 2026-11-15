export function sessionTrackX(track, count, center) {
  return center + (track - (count - 1) / 2) * 18;
}

export function sessionLabelAnchor(lane, count, center) {
  const outerTrack = lane === 0 ? count - 1 : 0;
  return sessionTrackX(outerTrack, count, center) + (lane === 0 ? 18 : -18);
}

export function assignSessionTracks(sessions) {
  const trackOf = new Map();
  const ends = [];
  const ordered = [...sessions].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const session of ordered) {
    let track = ends.findIndex((end) => end <= session.start);
    if (track < 0) track = ends.length;
    ends[track] = session.end;
    trackOf.set(session, track);
  }
  return { trackOf, count: ends.length };
}
