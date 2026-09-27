import { createContext, useCallback, useContext, useMemo, useState } from "react";

// View mode: "full" (the complete app) vs "simple" (one calm, glanceable
// screen — 2026-09-27, user request: "a toggle near the languages... hides
// complexity, keeps the important values, predominantly visual"). Persisted
// like the language choice.
const ViewContext = createContext(null);
const VIEW_STORAGE_KEY = "h0mep0wer.view";

function loadView() {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    return v === "simple" ? "simple" : "full";
  } catch {
    return "full";
  }
}

export function ViewProvider({ children }) {
  const [view, setViewState] = useState(loadView);
  const setView = useCallback((next) => {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      /* private mode — non-fatal */
    }
    setViewState(next);
  }, []);
  const value = useMemo(() => ({ view, setView, isSimple: view === "simple" }), [view, setView]);
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

export function useView() {
  const context = useContext(ViewContext);
  if (!context) throw new Error("useView must be used within a ViewProvider");
  return context;
}
