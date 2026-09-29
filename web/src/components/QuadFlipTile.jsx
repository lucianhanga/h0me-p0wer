import { useRef, useState } from "react";

// Round-robin multi-face flip tile (2026-09-29, user request for the simple
// view's chart tiles — 4 faces: 12h / 24h / 1w / 1h, tapped through in
// cycle). A controlled wrapper: the PARENT owns the face index (it drives
// data loading); onFlip fires at the invisible 90° edge-on moment, so the
// content swaps mid-flip. Single-content swap (rotate out → swap → rotate
// in) instead of a real N-face prism — no fixed pixel dimensions needed,
// works at any width. Same >10px drag guard as FlipTile (swipe ≠ tap).
export default function QuadFlipTile({ title, faceLabel, onFlip, children }) {
  const [phase, setPhase] = useState("in"); // in | out | prep
  const busy = useRef(false);
  const downPos = useRef(null);

  const flip = () => {
    if (busy.current) return;
    busy.current = true;
    setPhase("out"); // rotate to edge-on
    setTimeout(() => {
      onFlip?.(); // swap face while invisible
      setPhase("prep"); // jump to the other edge WITHOUT animating
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          setPhase("in"); // animate back to flat
          setTimeout(() => {
            busy.current = false;
          }, 220);
        }),
      );
    }, 190);
  };

  return (
    <div className="quadflip">
      <button className="quadflip-title" onClick={flip} aria-live="polite">
        {title}
        {faceLabel && <span className="quadflip-face"> · {faceLabel} ⟳</span>}
      </button>
      <div
        className="quadflip-box"
        onPointerDown={(e) => (downPos.current = [e.clientX, e.clientY])}
        onClick={(e) => {
          if (downPos.current) {
            const [x, y] = downPos.current;
            downPos.current = null;
            if (Math.hypot(e.clientX - x, e.clientY - y) > 10) return; // drag, not tap
          }
          flip();
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            flip();
          }
        }}
      >
        <div className={`quadflip-inner qf-${phase}`}>{children}</div>
      </div>
    </div>
  );
}
