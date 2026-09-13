import { useEffect, useRef, useState } from "react";

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
function SunArc({ sunrise, sunset }) {
  const toMin = (s) => Number(s?.slice(0, 2)) * 60 + Number(s?.slice(3, 5));
  const sr = toMin(sunrise), ss = toMin(sunset);
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const frac = ss > sr ? Math.min(1, Math.max(0, (now - sr) / (ss - sr))) : null;
  const angle = frac == null ? null : Math.PI * (1 - frac); // π → 0 left to right
  const cx = 100, cy = 95, r = 80;
  const x = frac == null ? null : cx + r * Math.cos(angle);
  const y = frac == null ? null : cy - r * Math.sin(angle);
  return (
    <svg viewBox="0 0 200 114" className="sun-arc">
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="#2a3238" strokeWidth="2" />
      {x != null && <circle cx={x} cy={y} r="5" fill="#f7a44f" />}
      <text x={cx - r} y={cy + 14} textAnchor="middle" className="arc-label">{sunrise}</text>
      <text x={cx + r} y={cy + 14} textAnchor="middle" className="arc-label">{sunset}</text>
    </svg>
  );
}

export default function WelcomeTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const hasData = useRef(false); // survives the []-closure for keep-last-good

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
    return () => { alive = false; clearInterval(t); };
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
      <section className="card wx-hero">
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
        <section className="card"><h3>This week</h3><p>{data.week.statement}</p></section>
        <section className="card"><h3>{new Date().toLocaleString([], { month: "long" })}</h3><p>{data.month.statement}</p></section>

        <section className="card">
          <h3>Estimated production (planned PV)</h3>
          <p className="wx-big">{data.production.todayKwh} kWh <span className="muted">today</span></p>
          <p className="muted">week ≈ {data.production.weekKwh} kWh · month ≈ {data.production.monthKwh} kWh</p>
          <p className="muted">{data.production.reasoning}</p>
        </section>

        <section className="card">
          <h3>Start of day (measured)</h3>
          <p>Sunrise {data.startOfDay.sunrise} · battery {data.startOfDay.batterySoc ?? "—"}%</p>
          <p className="muted">grid import so far {data.startOfDay.gridImportKwhSoFar} kWh</p>
        </section>

        <section className="card">
          <h3>End of day (predicted)</h3>
          <p>battery ≈ {data.endOfDay.batterySocEstimate}% · house ≈ {data.endOfDay.toHouseKwh} kWh</p>
          <p className="muted">to battery ≈ {data.endOfDay.toBatteryKwh} kWh · export ≈ {data.endOfDay.gridExportKwh} kWh</p>
          <p className="muted">{data.endOfDay.note}</p>
        </section>

        <section className="card">
          <h3>Estimated savings</h3>
          <p className="wx-big">≈ €{data.savings.todayEur} <span className="muted">today</span></p>
          <p className="muted">month ≈ €{data.savings.monthEur} · {data.savings.note}</p>
        </section>
      </div>
    </div>
  );
}
