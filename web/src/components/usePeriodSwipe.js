import { useRef } from "react";

export function usePeriodSwipe(go) {
  const swipeStart = useRef(null);

  const onTouchStart = (e) => {
    if (e.target.closest("button")) return;
    swipeStart.current = [e.touches[0].clientX, e.touches[0].clientY];
  };

  const onTouchEnd = (e) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start[0];
    const dy = e.changedTouches[0].clientY - start[1];
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    go(dx < 0 ? 1 : -1);
  };

  return { onTouchStart, onTouchEnd };
}
