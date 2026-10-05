import { useState } from "react";

const DISMISSED_PREFIX = "hint-dismissed-";

// One-time dismissible explanation bubbles (2026-10-05, user request:
// "give him some bubble text with explanation what a feature does...
// useful stuff to navigate through the UI"). Each hint has a stable id;
// dismissing it is permanent per browser (localStorage) — this is meant
// as temporary onboarding, not a nag that keeps coming back once acted
// on. Placed once per SECTION (e.g. above a whole row of flip-tiles),
// not per individual tile — repeating the same explanation under every
// card in a row would be clutter, not help.
export default function Hint({ id, children }) {
  const key = DISMISSED_PREFIX + id;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(key) === "1");
  if (dismissed) return null;
  return (
    <div className="hint-bubble">
      <span className="hint-icon" aria-hidden="true">
        ⓘ
      </span>
      <span className="hint-text">{children}</span>
      <button
        type="button"
        className="hint-dismiss"
        aria-label="Dismiss"
        onClick={() => {
          localStorage.setItem(key, "1");
          setDismissed(true);
        }}
      >
        ×
      </button>
    </div>
  );
}
