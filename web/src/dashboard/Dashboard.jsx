import { useEffect, useState } from "react";

// Overview dashboard: consumption-by-source cards (today/week/month/year ×
// house/grid/battery/PV + €), all from the byPeriod block of a single
// /api/stats/overview call.
export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = () => {
      fetch("/api/stats/overview")
        .then((r) => r.json())
        .then((res) => {
          if (!res.ok) throw new Error(res.error);
          setStats(res.data);
        })
        .catch((e) => setError(String(e.message ?? e)));
    };
    load();
    const timer = setInterval(load, 60000); // tiles refresh once a minute
    return () => clearInterval(timer);
  }, []);

  if (error) return <div className="error-box">{error}</div>;
  if (!stats) return <p className="muted">loading…</p>;

  return (
    <div className="src-grid">
      <SourceCard title="Today" data={stats.byPeriod.today} />
      <SourceCard title="This week" data={stats.byPeriod.week} />
      <SourceCard title="This month" data={stats.byPeriod.month} />
      <SourceCard title="This year" data={stats.byPeriod.year} />
    </div>
  );
}

// Consumption-by-source card: house total on top, then the three sources
// with the same colors as the chart (grid/battery/PV). Grid € = spent,
// battery/PV € = saved (avoided grid import at the same tariff).
const SRC_ROWS = [
  { key: "gridKwh", eur: "gridEur", label: "Grid", color: "#f7a44f" },
  { key: "battKwh", eur: "battEur", label: "Battery", color: "#c084fc", saved: true },
  { key: "pvKwh", eur: "pvEur", label: "PV", color: "#5fce80", saved: true },
];

function SourceCard({ title, data }) {
  return (
    <div className="tile">
      <div className="tile-title">{title}</div>
      <div className="src-home">{data.homeKwh} kWh</div>
      <div className="src-rows">
        {SRC_ROWS.map((r) => (
          <div className="src-row" key={r.key}>
            <span className="src-dot" style={{ background: r.color }} />
            <span>{r.label}</span>
            <span className="src-value">
              {data[r.key]} kWh
              <span className="src-eur">
                · €{data[r.eur]}
                {r.saved ? " saved" : ""}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
