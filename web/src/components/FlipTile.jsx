import { useState } from "react";

// Generic flippable tile: click/tap (or Enter/Space) flips it 180°.
// `children` render on the front; `back` on the back face (empty for now —
// per-tile back content is a future iteration). Style the front by giving
// the child your existing card/tile classes; the back renders as an empty
// card of the same size.
export default function FlipTile({ children, back = null, className = "" }) {
  const [flipped, setFlipped] = useState(false);
  const toggle = () => setFlipped((f) => !f);
  return (
    <div
      className={`flip-tile${flipped ? " flipped" : ""}${className ? ` ${className}` : ""}`}
      onClick={toggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <div className="flip-inner">
        <div className="flip-face flip-front">{children}</div>
        <div className="flip-face flip-back">{back}</div>
      </div>
    </div>
  );
}
