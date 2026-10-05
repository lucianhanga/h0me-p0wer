import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  hintsDisabled,
  isHintSeen,
  markHintSeen,
  disableAllHints,
  claimHintSlot,
  releaseHintSlot,
} from "../hints.js";
import { useT } from "../i18n/LanguageProvider.jsx";

// Anchored tooltip bubble (2026-10-05, user request — "bubbles near the
// feature", shown "randomly at random moments, the ones which the user
// did not see"). Positioned via `anchorRef` (a ref to the existing
// feature element — a button, a card, whatever) measured with
// getBoundingClientRect() and rendered through a portal at
// position:fixed — deliberately NOT a wrapping div around the anchor:
// several anchors here (header icon buttons with explicit flex `order`,
// FlipTile/SourceCard grid items) would have their layout broken by an
// extra DOM layer, so this stays fully decoupled from the anchor's own
// markup.
//
// Random delay + a shared one-at-a-time slot (hints.js) so multiple
// eligible hints on the same page don't all pop at once; a hint that
// loses the race reschedules itself rather than giving up. "Got it"
// marks this ONE hint seen — permanent, it won't be picked again.
// "Don't show tips" is the global kill switch from the user's own
// example — every hint, forever, until a future code change removes
// the feature (no UI to re-enable, matching that example).
const MIN_DELAY_MS = 4000;
const MAX_DELAY_MS = 25000;
const RETRY_DELAY_MS = 3000;
const MARGIN = 8;

export default function Hint({ id, tip, anchorRef, align = "end" }) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [rect, setRect] = useState(null);

  useEffect(() => {
    if (hintsDisabled() || isHintSeen(id)) return undefined;
    let cancelled = false;
    let timer;
    const attempt = () => {
      const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
      timer = setTimeout(() => {
        if (cancelled || hintsDisabled() || isHintSeen(id)) return;
        if (!claimHintSlot(id)) {
          timer = setTimeout(attempt, RETRY_DELAY_MS);
          return;
        }
        if (anchorRef.current) setRect(anchorRef.current.getBoundingClientRect());
        setVisible(true);
      }, delay);
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      releaseHintSlot(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!visible) return undefined;
    const update = () => anchorRef.current && setRect(anchorRef.current.getBoundingClientRect());
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible || !rect) return null;

  const close = () => {
    releaseHintSlot(id);
    setVisible(false);
  };
  const gotIt = () => {
    markHintSeen(id);
    close();
  };
  const dontShow = () => {
    disableAllHints();
    close();
  };

  const style = {
    position: "fixed",
    top: rect.bottom + MARGIN,
    ...(align === "end"
      ? { right: Math.max(MARGIN, window.innerWidth - rect.right) }
      : { left: Math.max(MARGIN, rect.left) }),
  };

  return createPortal(
    <div className={`hint-bubble hint-align-${align}`} style={style}>
      <div className="hint-text">{tip}</div>
      <div className="hint-actions">
        <button type="button" className="hint-skip" onClick={dontShow}>
          {t("hints.dontShow")}
        </button>
        <button type="button" className="hint-gotit" onClick={gotIt}>
          {t("hints.gotIt")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
