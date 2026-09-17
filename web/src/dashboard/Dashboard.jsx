import { useEffect, useState } from "react";
import FlipTile from "../components/FlipTile.jsx";
import BackBars from "./BackBars.jsx";
import UpdatedStamp from "../components/UpdatedStamp.jsx";

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
      <UpdatedStamp at={updatedAt} />
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
    </div>
  );
}

// Consumption-by-source card: house total on top, then the source rows with
// the same colors as the chart (grid/battery/PV). Grid € = spent, battery/PV
// € = saved (avoided grid import at the same tariff). Today additionally has
// a "To battery" row (PV loaded into the battery — informational, no €: the
// savings are booked when the battery discharges, never twice).
// ‹ › in the title row navigates the card through past periods
// (/api/stats/period, offset ≥ 1); flip side shows the same period's bars.
// PV direct/From battery deliberately have NO per-row € — the ONE savings
// figure (active.savedEur, production-based — see server/savings.js) isn't
// their sum, so showing per-row €s next to it would look inconsistent.
const SRC_ROWS = [
  { key: "gridKwh", eur: "gridEur", label: "Grid", color: "#f7a44f" },
  { key: "pvKwh", label: "PV direct", color: "#5fce80" },
  { key: "battKwh", label: "From battery", color: "#c084fc" },
];
const BATT_IN_ROW = { key: "battInKwh", label: "To battery", color: "#8b98a5", stored: true };

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
  // Today (offset 0) also reports PV→battery; past periods don't have it.
  const rows = active.battInKwh != null ? [...SRC_ROWS, BATT_IN_ROW] : SRC_ROWS;
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
        {active.pvProducedKwh != null && (
          <div className="src-produced">
            <span className="src-produced-icon">☀</span>
            <span>{active.pvProducedKwh} kWh produced</span>
          </div>
        )}
        {active.dataCoveragePct != null && active.dataCoveragePct < 90 && (
          <div className="src-gap-note">
            ⚠ {active.dataCoveragePct}% of today covered, even after recovering what we could
            from Anker's cloud — actual totals may still be higher than shown
          </div>
        )}
        <div className="src-rows">
          {rows.map((r) => (
            <div className="src-row" key={r.key}>
              <span className="src-dot" style={{ background: r.color }} />
              <span className="src-label">{r.label}</span>
              <span className="src-value">
                <span className="src-kwh">{active[r.key]} kWh</span>
                {(r.stored || r.eur) && (
                  <span className="src-eur">{r.stored ? "stored" : `€${active[r.eur]} spent`}</span>
                )}
              </span>
            </div>
          ))}
        </div>
        <div className="src-money">
          spent €{active.gridEur} · saved €{active.savedEur}
        </div>
      </div>
    </FlipTile>
  );
}
