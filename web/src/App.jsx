import { useEffect, useState } from "react";
import LiveTab from "./live/LiveTab.jsx";
import GraphTab from "./graph/GraphTab.jsx";
import Dashboard from "./dashboard/Dashboard.jsx";
import WelcomeTab from "./welcome/WelcomeTab.jsx";

const PAGES = [
  { key: "welcome", label: "Welcome" },
  { key: "live", label: "Live" },
  { key: "graph", label: "Graph" },
  { key: "dashboard", label: "Dashboard" },
  { key: "history", label: "History" },
];

export default function App() {
  const [page, setPage] = useState(() =>
    PAGES.some((p) => p.key === location.hash.slice(1)) ? location.hash.slice(1) : "welcome",
  );

  function switchPage(key) {
    setPage(key);
    location.hash = `#${key}`;
  }

  // Browser back/forward changes the hash — follow it.
  useEffect(() => {
    const onHash = () =>
      setPage(
        PAGES.some((p) => p.key === location.hash.slice(1)) ? location.hash.slice(1) : "welcome",
      );
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Swipe left/right to switch tabs (phones). Gestures starting on
  // interactive surfaces are ignored — the graph's drag-to-pan and the
  // buttons keep working. Horizontal must dominate vertical (scrolling
  // stays untouched), threshold 60px.
  useEffect(() => {
    let startX = null;
    let startY = 0;
    const onStart = (e) => {
      if (e.target.closest(".chart-box, button, a, select, input")) {
        startX = null;
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onEnd = (e) => {
      if (startX == null) return;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      startX = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const i = PAGES.findIndex((p) => p.key === page);
      const next = (i + (dx < 0 ? 1 : -1) + PAGES.length) % PAGES.length;
      switchPage(PAGES[next].key);
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, [page]);

  return (
    <div className="app">
      <header>
        <h1>h0me-p0wer</h1>
        <nav>
          {PAGES.map((p) => (
            <button
              key={p.key}
              className={page === p.key ? "nav-active" : ""}
              onClick={() => switchPage(p.key)}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <span className="app-version">v{__APP_VERSION__}</span>
      </header>
      <main>
        {page === "welcome" ? (
          <WelcomeTab />
        ) : page === "live" ? (
          <LiveTab />
        ) : page === "graph" ? (
          <GraphTab />
        ) : page === "dashboard" ? (
          <Dashboard />
        ) : (
          <Placeholder name={page} />
        )}
      </main>
    </div>
  );
}

// Remaining parked tabs: old components live untouched in web/src/parked/,
// just not bundled.
function Placeholder({ name }) {
  return <p className="muted">{name} — coming soon</p>;
}
