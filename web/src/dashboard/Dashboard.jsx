import { useEffect, useState } from "react";
import FlipTile from "../components/FlipTile.jsx";
import BackBars from "./BackBars.jsx";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { useT } from "../i18n/LanguageProvider.jsx";

// Overview dashboard: consumption-by-source cards (today/week/month/year ×
// house/grid/battery/PV + €), all from the byPeriod block of a single
// /api/stats/overview call.
export default function Dashboard() {
  const t = useT();
  const [stats, setStats] = useState(null);
  const [topDays, setTopDays] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);

  useEffect(() => {
    const load = () => {
      Promise.all([
        fetch("/api/stats/overview").then((r) => r.json()),
        // Best-effort: a handful of finished-day rankings, not core to the
        // page — a failure here shouldn't block the rest of the dashboard.
        fetch("/api/stats/top-days")
          .then((r) => r.json())
          .catch(() => null),
      ])
        .then(([overviewRes, topRes]) => {
          if (!overviewRes.ok) throw new Error(overviewRes.error);
          setStats(overviewRes.data);
          if (topRes?.ok) setTopDays(topRes.data);
          setUpdatedAt(new Date());
          setError(null); // clear a previous transient failure — success must
          // unwedge the tab (2026-09-22 code review: one failed poll used to
          // stick the error screen forever while polls recovered underneath)
        })
        .catch((e) => setError(String(e.message ?? e)));
    };
    load();
    const timer = setInterval(load, 60000); // tiles refresh once a minute
    return () => clearInterval(timer);
  }, []);

  if (error) return <div className="error-box">{error}</div>;
  if (!stats) return <p className="muted">{t("common.loading")}</p>;

  return (
    <div>
      <UpdatedStamp at={updatedAt} />
      <div className="src-grid">
        <SourceCard
          type="day"
          title={t("dashboard.today")}
          data={stats.byPeriod.today}
          formatLabel={(l) => new Date(l).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        />
        <SourceCard
          type="week"
          title={t("dashboard.thisWeek")}
          data={stats.byPeriod.week}
          formatLabel={(l) => new Date(`${l}T12:00:00`).toLocaleDateString([], { weekday: "short" })}
        />
        <SourceCard
          type="month"
          title={t("dashboard.thisMonth")}
          data={stats.byPeriod.month}
          formatLabel={(l) => (typeof l === "string" ? l.slice(8) : l)}
        />
        <SourceCard
          type="year"
          title={t("dashboard.thisYear")}
          data={stats.byPeriod.year}
          formatLabel={(l) => new Date(`${l}-15T12:00:00`).toLocaleDateString([], { month: "short" })}
        />
      </div>
      {topDays && (topDays.top.length > 0 || topDays.bottom.length > 0) && (
        <div className="topdays-grid">
          <TopDaysCard title={t("dashboard.topdays.highest")} rows={topDays.top} />
          <TopDaysCard title={t("dashboard.topdays.lowest")} rows={topDays.bottom} />
        </div>
      )}
    </div>
  );
}

// Ranked list of finished days by solar production (the sort key — see
// /api/stats/top-days: only complete days count, today is always excluded).
// Same "single source of truth" numbers as the period cards above, just
// reshaped into a leaderboard: production first (the ranking criterion),
// then house/grid/battery for that day. Battery utilization shows both
// directions — discharged (reduced grid need that day) and charged
// (stored for later) — since a day can matter for either reason.
const formatDayLabel = (dateStr) =>
  new Date(`${dateStr}T12:00:00`).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

function TopDaysCard({ title, rows }) {
  const t = useT();
  return (
    <div className="src-card topdays-card">
      <div className="tile-title src-title">
        <span>{title}</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted topdays-empty">{t("dashboard.topdays.notEnough")}</p>
      ) : (
        <div className="topdays-rows">
          {rows.map((d, i) => (
            <div className="topdays-row" key={d.date}>
              <span className="topdays-rank">#{i + 1}</span>
              <div className="topdays-info">
                <div className="topdays-headline">
                  <span className="topdays-date">{formatDayLabel(d.date)}</span>
                  <span className="topdays-produced wx-c-pv">
                    {t("dashboard.producedKwh", { kwh: d.pvProducedKwh })}
                  </span>
                </div>
                <div className="topdays-stats">
                  <span>{t("dashboard.topdays.house", { kwh: d.homeKwh })}</span>
                  <span className="wx-c-grid">{t("dashboard.topdays.grid", { kwh: d.gridKwh })}</span>
                  <span className="wx-c-batt">
                    {t("dashboard.topdays.battOut", { kwh: d.battKwh })}
                    {d.battInKwh > 0 ? t("dashboard.topdays.battIn", { kwh: d.battInKwh }) : ""}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Consumption-by-source card: house total on top, then the source rows with
// the same colors as the chart (grid/battery/PV). Today additionally has a
// "To battery" row (PV loaded into the battery — informational, no €: the
// savings are booked when the battery discharges, never twice).
// ‹ › in the title row navigates the card through past periods
// (/api/stats/period, offset ≥ 1); flip side shows the same period's bars.
// No row shows a per-row €: Grid's spent-€ is already in the bottom summary
// line (src-money) — repeating it inline next to the row was redundant
// (2026-09-17, user request). PV direct/From battery never had one — the
// ONE savings figure (active.savedEur, production-based — see
// server/savings.js) isn't their sum, so a per-row € next to them would
// look inconsistent with the summary.
const SRC_ROWS = [
  { key: "gridKwh", labelKey: "dashboard.rows.grid", color: "#f7a44f" },
  { key: "pvKwh", labelKey: "dashboard.rows.pvDirect", color: "#5fce80" },
  { key: "battKwh", labelKey: "dashboard.rows.fromBattery", color: "#c084fc" },
];
const BATT_IN_ROW = { key: "battInKwh", labelKey: "dashboard.rows.toBattery", color: "#8b98a5", stored: true };
// Residual grid export (2026-09-23, user request) — shown on every period
// card; 0.00 is the goal, anything above it is the honest remainder that
// slipped past zero-export.
const EXPORT_ROW = { key: "exportKwh", labelKey: "dashboard.rows.toGrid", color: "#e5544b" };

function SourceCard({ type, title, data, formatLabel }) {
  const t = useT();
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
  // Export is available on every period (overview + /api/stats/period).
  const rows = [
    ...SRC_ROWS,
    ...(active.battInKwh != null ? [BATT_IN_ROW] : []),
    ...(active.exportKwh != null ? [EXPORT_ROW] : []),
  ];
  return (
    <div className="src-card">
      {/* Outside the FlipTile so ‹ › period nav stays usable on the flipped
          (bar-chart) side too — it used to live inside the front face and
          vanish once the card was flipped (2026-09-19, user request). */}
      <div className="tile-title src-title">
        <button className="src-nav" onClick={() => go(1)} disabled={blocked} aria-label={t("dashboard.olderPeriod")}>
          ‹
        </button>
        <span>{offset === 0 ? title : (past?.label ?? title)}</span>
        <button className="src-nav" onClick={() => go(-1)} disabled={offset === 0} aria-label={t("dashboard.newerPeriod")}>
          ›
        </button>
      </div>
      <FlipTile back={<BackBars rows={active.bars} formatLabel={formatLabel} />}>
        <div className="src-card-body">
          <div className="src-home">{active.homeKwh} kWh</div>
          {active.pvProducedKwh != null && (
            <div className="src-produced">
              <span className="src-produced-icon">☀</span>
              <span>{t("dashboard.producedKwh", { kwh: active.pvProducedKwh })}</span>
            </div>
          )}
          {active.dataCoveragePct != null && active.dataCoveragePct < 90 && (
            <div className="src-gap-note">
              {t("dashboard.coverage", { pct: active.dataCoveragePct })}
            </div>
          )}
          <div className="src-rows">
            {rows.map((r) => (
              <div className="src-row" key={r.key}>
                <span className="src-dot" style={{ background: r.color }} />
                <span className="src-label">{t(r.labelKey)}</span>
                <span className="src-value">
                  <span className="src-kwh">{active[r.key]} kWh</span>
                  {r.stored && <span className="src-eur">{t("dashboard.stored")}</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="src-money">
            {t("dashboard.spentSaved", { grid: active.gridEur, saved: active.savedEur })}
          </div>
        </div>
      </FlipTile>
    </div>
  );
}
