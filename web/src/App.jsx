import { useEffect, useState } from "react";
import LiveTab from "./live/LiveTab.jsx";

const PAGES = [
  { key: "live", label: "Live" },
  { key: "graph", label: "Graph" },
  { key: "dashboard", label: "Dashboard" },
  { key: "history", label: "History" },
];

export default function App() {
  const [page, setPage] = useState(() =>
    PAGES.some((p) => p.key === location.hash.slice(1)) ? location.hash.slice(1) : "live",
  );

  function switchPage(key) {
    setPage(key);
    location.hash = `#${key}`;
  }

  // Browser back/forward changes the hash — follow it.
  useEffect(() => {
    const onHash = () =>
      setPage(
        PAGES.some((p) => p.key === location.hash.slice(1)) ? location.hash.slice(1) : "live",
      );
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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
      <main>{page === "live" ? <LiveTab /> : <Placeholder name={page} />}</main>
    </div>
  );
}

// Parked tabs: content intentionally left out for now (previous components
// live untouched in web/src/parked/, just not bundled).
function Placeholder({ name }) {
  return <p className="muted">{name} — coming soon</p>;
}
