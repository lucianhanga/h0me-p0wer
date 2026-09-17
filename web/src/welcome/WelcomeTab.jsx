import { useEffect, useRef, useState } from "react";
import SpeakButton from "../components/SpeakButton.jsx";
import UpdatedStamp from "../components/UpdatedStamp.jsx";

const ICONS = {
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4",
  "cloud-sun": "M12 8a4 4 0 0 1 4 4h-1.5A2.5 2.5 0 0 0 12 9.5 2.5 2.5 0 0 0 9.5 12H8a4 4 0 0 1 4-4Zm-6 9h12a3 3 0 0 0 0-6h-.5A4.5 4.5 0 0 0 9 8.5 4 4 0 0 0 5 12.5 2.5 2.5 0 0 0 6 17Z",
  cloud: "M6 18h12a3.5 3.5 0 0 0 .5-6.97A5 5 0 0 0 9 7.5a4.5 4.5 0 0 0-4.4 5.4A3 3 0 0 0 6 18Z",
  rain: "M6 15h12a3.5 3.5 0 0 0 .5-6.97A5 5 0 0 0 9 4.5 4.5 4.5 0 0 0 4.6 9.9 3 3 0 0 0 6 15Zm1 3-1 2m5-2-1 2m5-2-1 2",
  snow: "M12 3v18m-7-13 14 10M5 16l14-10",
};

function WeatherIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" className="wx-icon" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name] ?? ICONS.cloud} />
    </svg>
  );
}

// Sun arc: semicircle sunrise→sunset with a marker for the current time.
// The elapsed portion (sunrise → now) is drawn as a warm gradient "progress"
// stroke over the plain track, and the marker pulses — turns the arc from a
// static diagram into a live read of how much of today's daylight has
// passed (2026-09-16: "make the weather tile more vivid/alive").
function SunArc({ sunrise, sunset }) {
  const toMin = (s) => Number(s?.slice(0, 2)) * 60 + Number(s?.slice(3, 5));
  const sr = toMin(sunrise), ss = toMin(sunset);
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const frac = ss > sr ? Math.min(1, Math.max(0, (now - sr) / (ss - sr))) : null;
  const angle = frac == null ? null : Math.PI * (1 - frac); // π → 0 left to right
  const cx = 100, cy = 95, r = 80;
  const point = (a) => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  const [x, y] = frac == null ? [null, null] : point(angle);
  return (
    <svg viewBox="0 0 200 114" className="sun-arc">
      <defs>
        <linearGradient id="sunArcElapsed" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#f9d976" />
          <stop offset="100%" stopColor="#f7a44f" />
        </linearGradient>
      </defs>
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="#2a3238" strokeWidth="2" />
      {x != null && (
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x} ${y}`}
          fill="none"
          stroke="url(#sunArcElapsed)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      )}
      {x != null && <circle cx={x} cy={y} r="9" className="sun-marker-glow" />}
      {x != null && <circle cx={x} cy={y} r="5" fill="#f7a44f" className="sun-marker-dot" />}
      <text x={cx - r} y={cy + 14} textAnchor="middle" className="arc-label">{sunrise}</text>
      <text x={cx + r} y={cy + 14} textAnchor="middle" className="arc-label">{sunset}</text>
    </svg>
  );
}

// Yesterday summary — deterministic (measured, not AI), its own fetch
// against the same /api/stats/period route the Dashboard's ‹ › navigation
// uses, so it never depends on the AI briefing schema or its refresh cycle.
function YesterdayCard() {
  const [y, setY] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/stats/period?type=day&offset=1")
      .then((r) => r.json())
      .then((j) => {
        if (alive && j.ok && j.data.hasData) setY(j.data);
      })
      .catch(() => {
        // no data yet (e.g. first day of use) — card just doesn't render
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!y) return null;
  return (
    <section className="card">
      <SpeakButton
        id="yesterday"
        className="speak-corner"
        text={`Yesterday: ${y.homeKwh} kilowatt-hours used, ${y.pvProducedKwh} produced by the panels, ${y.gridKwh} from the grid, ${y.battKwh} from the battery. Spent ${y.gridEur} euros, saved ${y.savedEur}.`}
      />
      <h3>Yesterday</h3>
      <p className="wx-big">
        {y.homeKwh} kWh <span className="muted">used</span>
      </p>
      <p className="muted">
        grid {y.gridKwh} kWh · battery {y.battKwh} kWh · PV {y.pvKwh} kWh direct
      </p>
      <p className="muted">
        ☀ {y.pvProducedKwh} kWh produced · spent €{y.gridEur} · saved €{y.savedEur}
      </p>
    </section>
  );
}

// This week so far — deterministic, same reasoning as YesterdayCard: the
// AI's week.upcoming/estimate are forward-looking (see welcome-ai.js), so
// "what's already happened this week" is measured here instead, from the
// Dashboard's own /api/stats/overview week totals (calendar Mon-Sun,
// 2026-09-16 fix — see AGENTS.md). Future days in the week contribute 0,
// so the totals are already correctly "so far," not inflated.
function ThisWeekSoFarCard() {
  const [w, setW] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/stats/overview")
      .then((r) => r.json())
      .then((j) => {
        if (alive && j.ok) setW(j.data.byPeriod.week);
      })
      .catch(() => {
        // no data yet — card just doesn't render
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!w) return null;
  return (
    <section className="card">
      <SpeakButton
        id="weekSoFar"
        className="speak-corner"
        text={`This week so far: ${w.homeKwh} kilowatt-hours used, ${w.pvProducedKwh} produced by the panels, ${w.gridKwh} from the grid, ${w.battKwh} from the battery. Spent ${w.gridEur} euros, saved ${w.savedEur}.`}
      />
      <h3>This week so far</h3>
      <p className="wx-big">
        {w.homeKwh} kWh <span className="muted">used</span>
      </p>
      <p className="muted">
        grid {w.gridKwh} kWh · battery {w.battKwh} kWh · PV {w.pvKwh} kWh direct
      </p>
      <p className="muted">
        ☀ {w.pvProducedKwh} kWh produced · spent €{w.gridEur} · saved €{w.savedEur}
      </p>
    </section>
  );
}

export default function WelcomeTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const hasData = useRef(false); // survives the []-closure for keep-last-good
  const synth = typeof window !== "undefined" ? window.speechSynthesis : null;

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const j = await fetch("/api/welcome").then((r) => r.json());
        if (!alive) return;
        if (j.ok) { hasData.current = true; setData(j.data); setError(null); }
        else if (!hasData.current) setError(String(j.error ?? "request failed"));
        // Keep last good: once data exists, failed polls are ignored.
      } catch (e) {
        if (alive && !hasData.current) setError(String(e.message ?? "request failed"));
      }
    }
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(t);
      synth?.cancel(); // don't keep talking after leaving the tab
    };
  }, []);

  // Forced regeneration (server makes a real AI call — can take ~20-30 s).
  async function refresh() {
    setRefreshing(true);
    try {
      const j = await fetch("/api/welcome/refresh", { method: "POST" }).then((r) => r.json());
      if (j.ok) { hasData.current = true; setData(j.data); setError(null); }
    } catch {
      // keep last good
    } finally {
      setRefreshing(false);
    }
  }

  if (error) return <p className="muted">Welcome — {error}</p>;
  if (!data) return <p className="muted">Preparing your briefing…</p>;
  const gt = data.groundTruth ?? {};
  return (
    <div className="welcome">
      <UpdatedStamp at={data.generatedAt}>
        {`${data.aiPowered ? "AI briefing" : "offline estimate"}${data.stale ? " · cached" : ""}`}
      </UpdatedStamp>
      <section className="card wx-hero">
        <SpeakButton id="hero" className="speak-corner" text={data.greeting} />
        <p className="wx-greeting">{data.greeting}</p>
        <p className="muted wx-meta">
          {data.aiPowered ? "AI briefing" : "offline estimate"}
          {data.stale ? " · cached (refresh failed)" : ""} · {new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          <button
            className={`wx-refresh${refreshing ? " spinning" : ""}`}
            onClick={refresh}
            disabled={refreshing}
            title="Refresh briefing (new AI call)"
            aria-label="Refresh briefing"
          >
            ↻
          </button>
        </p>
      </section>

      <section className="card wx-today">
        <SpeakButton
          id="today"
          className="speak-corner"
          text={`${data.today.summary} Temperatures between ${gt.tempMin} and ${gt.tempMax} degrees, ${gt.sunHoursToday} hours of sun. Sunrise at ${gt.sunrise}, sunset at ${gt.sunset}.`}
        />
        <WeatherIcon name={data.today.icon} />
        <div>
          <p>{data.today.summary}</p>
          <p className="muted">
            {gt.tempMin}°–{gt.tempMax}°C · {gt.sunHoursToday} h sun
          </p>
        </div>
        <SunArc sunrise={gt.sunrise} sunset={gt.sunset} />
      </section>

      <div className="wx-grid">
        <section className="card">
          <SpeakButton
            id="startOfDay"
            className="speak-corner"
            text={`How the day started: sunrise at ${data.startOfDay.sunrise}, battery at ${data.startOfDay.batterySoc ?? "unknown"} percent, grid import so far ${data.startOfDay.gridImportKwhSoFar} kilowatt-hours.`}
          />
          <h3>How the day started</h3>
          <p>Sunrise {data.startOfDay.sunrise} · battery {data.startOfDay.batterySoc ?? "—"}%</p>
          <p className="muted">grid import so far {data.startOfDay.gridImportKwhSoFar} kWh</p>
        </section>

        <section className="card wx-now">
          <SpeakButton
            id="statusQuo"
            className="speak-corner"
            text={`${data.today.statusQuo} ${data.production.todayKwh} kilowatt-hours produced so far today. ${data.production.reasoning}`}
          />
          <h3>
            <span className="wx-live-dot" aria-hidden="true" />
            Right now
          </h3>
          <p>{data.today.statusQuo}</p>
          <p className="wx-big">{data.production.todayKwh} kWh <span className="muted">produced today</span></p>
          <p className="muted">week ≈ {data.production.weekKwh} kWh · month ≈ {data.production.monthKwh} kWh</p>
          <p className="muted">{gt.pvLiveToday ? "measured" : "estimated — PV still planned"} · {data.production.reasoning}</p>
          {data.today.statusQuoUpdatedAt && (
            <p className="muted wx-status-quo-stamp">
              refreshed{" "}
              {new Date(data.today.statusQuoUpdatedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
        </section>

        <section className="card">
          <SpeakButton
            id="endOfDay"
            className="speak-corner"
            text={`How today will end: battery about ${data.endOfDay.batterySocEstimate} percent, ${data.endOfDay.toHouseKwh} kilowatt-hours to the house, about ${data.endOfDay.estimatedSavingsEur} euros saved. ${data.endOfDay.note}`}
          />
          <h3>How today will end</h3>
          <p>battery ≈ {data.endOfDay.batterySocEstimate}% · house ≈ {data.endOfDay.toHouseKwh} kWh</p>
          <p className="muted">to battery ≈ {data.endOfDay.toBatteryKwh} kWh · export ≈ {data.endOfDay.gridExportKwh} kWh</p>
          <p className="wx-big small">≈ €{data.endOfDay.estimatedSavingsEur} <span className="muted">saved today</span></p>
          <p className="muted">{data.endOfDay.note}</p>
        </section>

        <YesterdayCard />

        <ThisWeekSoFarCard />

        <section className="card">
          <SpeakButton id="weekUpcoming" className="speak-corner" text={`What's coming this week: ${data.week.upcoming}`} />
          <h3>What's coming this week</h3>
          <p>{data.week.upcoming}</p>
        </section>

        <section className="card">
          <SpeakButton
            id="weekEstimate"
            className="speak-corner"
            text={`How this week should end: ${data.week.estimate} About ${data.week.estimateKwh} kilowatt-hours, ${data.week.estimateEur} euros saved.`}
          />
          <h3>How this week should end</h3>
          <p>{data.week.estimate}</p>
          <p className="muted">≈ {data.week.estimateKwh} kWh · €{data.week.estimateEur} saved</p>
        </section>

        <section className="card">
          <SpeakButton id="month" className="speak-corner" text={`${new Date().toLocaleString([], { month: "long" })}: ${data.month.statement}`} />
          <h3>{new Date().toLocaleString([], { month: "long" })}</h3>
          <p>{data.month.statement}</p>
        </section>
      </div>
    </div>
  );
}
