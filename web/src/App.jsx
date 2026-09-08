import LivePower from "./LivePower.jsx";
import TimeSeriesChart from "./TimeSeriesChart.jsx";
import SiteInfo from "./SiteInfo.jsx";

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>h0me-p0wer</h1>
        <span className="subtitle">Anker SOLIX Smart Meter Gen 2 — POC</span>
      </header>
      <main>
        <section>
          <h2>Live (Modbus TCP)</h2>
          <LivePower />
        </section>
        <section>
          <h2>Power over time</h2>
          <TimeSeriesChart />
        </section>
        <section>
          <h2>Site &amp; devices (Anker cloud)</h2>
          <SiteInfo />
        </section>
      </main>
    </div>
  );
}
