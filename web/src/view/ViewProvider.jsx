import { createContext, useCallback, useContext, useMemo, useState } from "react";

// View modes: "full" (the complete app), "simple" (one calm, glanceable
// screen — 2026-09-27), "artistic" (the house picture with the live flow
// drawn on it — 2026-10-03, user request). Persisted like the language.
const ViewContext = createContext(null);
const VIEW_STORAGE_KEY = "h0mep0wer.view";
const VIEWS = ["full", "simple", "artistic"];

function loadView() {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    if (VIEWS.includes(v)) return v;
    // Default is the SIMPLE view (2026-09-28, user request: "when you start
    // the app start it in the simple view") — an explicit stored choice
    // always wins; only a never-set preference lands on simple.
    return "simple";
  } catch {
    return "simple";
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
  const value = useMemo(
    () => ({ view, setView, isSimple: view === "simple", isArtistic: view === "artistic", views: VIEWS }),
    [view, setView],
  );
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

export function useView() {
  const context = useContext(ViewContext);
  if (!context) throw new Error("useView must be used within a ViewProvider");
  return context;
}
