import { useEffect, useState } from "react";
import FlipTile from "../components/FlipTile.jsx";
import BackBars from "./BackBars.jsx";

// Overview dashboard: consumption-by-source cards (today/week/month/year ×
// house/grid/battery/PV + €), all from the byPeriod block of a single
// /api/stats/overview call.
export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);

  useEffect(() => {
    const load = () => {
      fetch("/api/stats/overview")
        .then((r) => r.json())
        .then((res) => {
          if (!res.ok) throw new Error(res.error);
          setStats(res.data);
          setUpdatedAt(new Date());
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
    <div>
      <div className="src-grid">
        <SourceCard
          type="day"
          title="Today"
          data={stats.byPeriod.today}
          formatLabel={(l) => new Date(l).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        />
        <SourceCard
          type="week"
          title="This week"
          data={stats.byPeriod.week}
          formatLabel={(l) => new Date(`${l}T12:00:00`).toLocaleDateString([], { weekday: "short" })}
        />
        <SourceCard
          type="month"
          title="This month"
          data={stats.byPeriod.month}
          formatLabel={(l) => (typeof l === "string" ? l.slice(8) : l)}
        />
        <SourceCard
          type="year"
          title="This year"
          data={stats.byPeriod.year}
          formatLabel={(l) => new Date(`${l}-15T12:00:00`).toLocaleDateString([], { month: "short" })}
        />
      </div>
      {updatedAt && (
        <p className="muted dash-updated">
          updated {updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </p>
      )}
    </div>
  );
}

// Consumption-by-source card: house total on top, then the three sources
// with the same colors as the chart (grid/battery/PV). Grid € = spent,
// battery/PV € = saved (avoided grid import at the same tariff).
// ‹ › in the title row navigates the card through past periods
// (/api/stats/period, offset ≥ 1); flip side shows the same period's bars.
const SRC_ROWS = [
  { key: "gridKwh", eur: "gridEur", label: "Grid", color: "#f7a44f" },
  { key: "battKwh", eur: "battEur", label: "Battery", color: "#c084fc", saved: true },
  { key: "pvKwh", eur: "pvEur", label: "PV", color: "#5fce80", saved: true },
];

function SourceCard({ type, title, data, formatLabel }) {
  const [offset, setOffset] = useState(0); // 0 = current period (overview data)
  const [past, setPast] = useState(null); // /api/stats/period response (offset ≥ 1)
  const [blocked, setBlocked] = useState(false); // no data further back

  async function go(dir) {
    const next = offset + dir;
    if (next < 0) return;
    if (next === 0) {
      setOffset(0);
      setPast(null);
      return;
    }
    try {
      const j = await fetch(`/api/stats/period?type=${type}&offset=${next}`).then((r) => r.json());
      if (!j.ok) return;
      if (!j.data.hasData) {
        setBlocked(true); // hit the data edge — stay where we are
        return;
      }
      setBlocked(!j.data.hasEarlier);
      setPast(j.data);
      setOffset(next);
    } catch {
      // keep current period
    }
  }

  const active = offset === 0 || !past ? data : past;
  const savedEur = Math.round((active.battEur + active.pvEur) * 100) / 100;
  return (
    <FlipTile back={<BackBars rows={active.bars} formatLabel={formatLabel} />}>
      <div className="tile">
        <div className="tile-title src-title">
          <button
            className="src-nav"
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            disabled={blocked}
            aria-label="Older period"
          >
            ‹
          </button>
          <span>{offset === 0 ? title : (past?.label ?? title)}</span>
          <button
            className="src-nav"
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            disabled={offset === 0}
            aria-label="Newer period"
          >
            ›
          </button>
        </div>
        <div className="src-home">{active.homeKwh} kWh</div>
        <div className="src-rows">
          {SRC_ROWS.map((r) => (
            <div className="src-row" key={r.key}>
              <span className="src-dot" style={{ background: r.color }} />
              <span>{r.label}</span>
              <span className="src-value">
                {active[r.key]} kWh
                <span className="src-eur">
                  · €{active[r.eur]}
                  {r.saved ? " saved" : ""}
                </span>
              </span>
            </div>
          ))}
        </div>
        <div className="src-money">
          spent €{active.gridEur} · saved €{savedEur}
        </div>
      </div>
    </FlipTile>
  );
}
