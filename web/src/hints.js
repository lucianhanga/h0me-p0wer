// Onboarding-hint state (2026-10-05, user request — anchored tooltip
// bubbles near each feature, shown one at a time at random moments,
// skipping ones already acknowledged, plus a global permanent opt-out).
// Plain localStorage + a tiny pub-sub, no React here — Hint.jsx is the
// only consumer.
const SEEN_PREFIX = "hint-seen-";
const HIDE_ALL_KEY = "hintsHidden";

export function hintsDisabled() {
  return localStorage.getItem(HIDE_ALL_KEY) === "1";
}

export function disableAllHints() {
  localStorage.setItem(HIDE_ALL_KEY, "1");
}

export function isHintSeen(id) {
  return localStorage.getItem(SEEN_PREFIX + id) === "1";
}

export function markHintSeen(id) {
  localStorage.setItem(SEEN_PREFIX + id, "1");
}

// Only one hint bubble on screen at a time (several can be ELIGIBLE on
// the same page — e.g. the header hint is mounted everywhere) — a module-
// level lock since the hints live in unrelated parts of the React tree
// with no shared parent to coordinate "whose turn is it" through.
let activeId = null;

export function claimHintSlot(id) {
  if (activeId && activeId !== id) return false;
  activeId = id;
  return true;
}

export function releaseHintSlot(id) {
  if (activeId === id) activeId = null;
}
