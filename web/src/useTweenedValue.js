import { useEffect, useRef, useState } from "react";

// Tween a numeric display value toward its target (2026-09-23, user
// request after the APK analysis showed the Anker app's "fast" feel is
// presentation: real_time_curve_* widgets + Lottie animation over the
// same 3-5 s telemetry cadence we already have). Ease-out cubic over
// ~800 ms — shorter than the 1-3 s push cadence, so values glide instead
// of jumping. Snaps instantly for null/non-finite targets and under
// prefers-reduced-motion.
export function useTweenedValue(target, durationMs = 800) {
  const [display, setDisplay] = useState(target);
  const currentRef = useRef(target);
  const rafRef = useRef(null);

  useEffect(() => {
    if (target == null || !Number.isFinite(target)) {
      cancelAnimationFrame(rafRef.current);
      currentRef.current = target;
      setDisplay(target);
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = currentRef.current;
    if (reduce || from == null || !Number.isFinite(from) || from === target) {
      currentRef.current = target;
      setDisplay(target);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = from + (target - from) * eased;
      currentRef.current = v;
      setDisplay(v);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, durationMs]);

  return display;
}

// Watts are displayed as integers everywhere — rounded view of the tween.
export function useTweenedWatts(target, durationMs) {
  const v = useTweenedValue(target, durationMs);
  return v == null || !Number.isFinite(v) ? v : Math.round(v);
}
