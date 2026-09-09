import { useEffect, useState } from "react";
import DayTile from "./DayTile.jsx";
import KwhBarsTile from "./KwhBarsTile.jsx";

// Overview dashboard: totals tiles + period overviews, all from a single
// /api/stats/overview call (plus /api/live for the current power tile).
export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [live, setLive] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = () => {
      fetch("/api/stats/overview")
        .then((r) => r.json())
        .then((res) => {
          if (!res.ok) throw new Error(res.error);
          setStats(res.data);
        })
        .catch((e) => setError(e.message));
      fetch("/api/live")
        .then((r) => r.json())
        .then((res) => setLive(res.snapshot))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 60000); // tiles refresh once a minute
    return () => clearInterval(timer);
  }, []);

  if (error) return <div className="error-box">{error}</div>;
  if (!stats) return <p className="muted">loading…</p>;

  const sum = (rows, key) => Math.round(rows.reduce((a, r) => a + (r[key] ?? 0), 0) * 100) / 100;
  const grid = live?.primary?.totalPower;

  return (
    <div>
      <div className="tiles">
        <Tile
          title="Now"
          main={grid != null ? `${Math.abs(grid)} W` : "—"}
          sub={grid != null ? (grid >= 0 ? "grid import" : "grid export") : "meter offline"}
        />
        <Tile
          title="Today"
          main={`${stats.today.importKwh} kWh`}
          sub={`export ${stats.today.exportKwh} kWh · avg ${stats.today.avgW ?? "—"} W · peak ${
            stats.today.peakW ?? "—"
          } W`}
        />
        <Tile
          title="This week"
          main={`${sum(stats.week, "importKwh")} kWh`}
          sub={`export ${sum(stats.week, "exportKwh")} kWh · ${stats.week.length} days`}
        />
        <Tile
          title="This month"
          main={`${sum(stats.month, "importKwh")} kWh`}
          sub={`export ${sum(stats.month, "exportKwh")} kWh`}
        />
        <Tile
          title="This year"
          main={`${sum(stats.year, "importKwh")} kWh`}
          sub={`export ${sum(stats.year, "exportKwh")} kWh`}
        />
      </div>

      <div className="tiles-period">
        <DayTile stats={stats} />
        <KwhBarsTile
          title="Week overview"
          rows={stats.week}
          formatLabel={(l) =>
            new Date(`${l}T12:00:00`).toLocaleDateString([], { weekday: "short" })
          }
          sub={`import ${sum(stats.week, "importKwh")} kWh · export ${sum(
            stats.week,
            "exportKwh",
          )} kWh this week`}
        />
        <KwhBarsTile
          title="Month overview"
          rows={stats.month}
          formatLabel={(l) => l.slice(8)}
          sub={`import ${sum(stats.month, "importKwh")} kWh · export ${sum(
            stats.month,
            "exportKwh",
          )} kWh this month`}
        />
      </div>
    </div>
  );
}

export function Tile({ title, main, sub, children }) {
  return (
    <div className="tile">
      <div className="tile-title">{title}</div>
      {main && <div className="tile-main">{main}</div>}
      {sub && <div className="tile-sub">{sub}</div>}
      {children}
    </div>
  );
}
