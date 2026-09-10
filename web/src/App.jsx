import { useState } from "react";
import LivePower from "./LivePower.jsx";
import FlowDiagram from "./FlowDiagram.jsx";
import TimeSeriesChart from "./TimeSeriesChart.jsx";
import SiteInfo from "./SiteInfo.jsx";
import Dashboard from "./dashboard/Dashboard.jsx";

const PAGES = [
  { key: "live", label: "Live" },
  { key: "dashboard", label: "Dashboard" },
];

export default function App() {
  const [page, setPage] = useState(() =>
    location.hash === "#dashboard" ? "dashboard" : "live",
  );

  function switchPage(key) {
    setPage(key);
    location.hash = key === "dashboard" ? "#dashboard" : "#live";
  }

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
      </header>
      <main>
        {page === "live" ? (
          <>
            <section>
              <h2>Live (Modbus TCP)</h2>
              <LivePower />
            </section>
            <section>
              <h2>Power flow</h2>
              <FlowDiagram />
            </section>
            <section>
              <h2>Power over time</h2>
              <TimeSeriesChart />
            </section>
            <section>
              <h2>Site &amp; devices (Anker cloud)</h2>
              <SiteInfo />
            </section>
          </>
        ) : (
          <Dashboard />
        )}
      </main>
    </div>
  );
}
