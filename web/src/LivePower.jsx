import { useEffect, useRef, useState } from "react";

// In dev (Vite on :5173) connect straight to the backend; in a served build
// use same-origin.
const WS_URL =
  location.port === "5173"
    ? "ws://localhost:3001/ws"
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

// Live meter snapshot pushed by the backend over /ws.
export default function LivePower() {
  const [state, setState] = useState(null);
  const [wsOpen, setWsOpen] = useState(false);
  const [today, setToday] = useState(null); // {importKwh, exportKwh}
  const mounted = useRef(true);

  // Today's energy totals (from the aggregate stats endpoint), refreshed
  // once a minute — the day total ticks up slowly, no need for 5 s updates.
  useEffect(() => {
    const load = () =>
      fetch("/api/stats/overview")
        .then((r) => r.json())
        .then((res) => res.ok && mounted.current && setToday(res.data.today))
        .catch(() => {});
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    mounted.current = true;
    let ws;
    let retry;
    function connect() {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => mounted.current && setWsOpen(true);
      ws.onmessage = (ev) => {
        if (mounted.current) setState(JSON.parse(ev.data));
      };
      ws.onclose = () => {
        if (!mounted.current) return;
        setWsOpen(false);
        retry = setTimeout(connect, 3000);
      };
    }
    connect();
    return () => {
      mounted.current = false;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  if (!state) return <p className="muted">connecting…</p>;

  const { connected, error, hint, snapshot } = state;
  const grid = snapshot?.primary?.totalPower;
  const solar = snapshot?.secondary?.totalPower;

  return (
    <div>
      <p>
        <span className={`badge ${connected ? "ok" : "bad"}`}>
          {connected ? "meter connected" : "meter offline"}
        </span>{" "}
        <span className={`badge ${wsOpen ? "ok" : "bad"}`}>
          {wsOpen ? "live feed" : "feed disconnected"}
        </span>
      </p>

      {!connected && (
        <div className="error-box">
          <p>{error ?? "waiting for first reading…"}</p>
          {hint && <p className="muted">{hint}</p>}
        </div>
      )}

      {snapshot && (
        <>
          <div className="cards">
            <div className="card card-hero">
              <div className="card-label">
                Grid {grid != null && (grid >= 0 ? "(import)" : "(export)")}
              </div>
              <div className={`card-value ${grid >= 0 ? "import" : "export"}`}>
                {grid != null ? `${Math.abs(grid)} W` : "—"}
              </div>
            </div>
            <div className="card">
              <div className="card-label">Solar CT</div>
              <div className="card-value">
                {solar != null ? `${Math.abs(solar)} W` : "—"}
              </div>
            </div>
            <div className="card">
              <div className="card-label">Today</div>
              <div className="card-value">
                {today ? `${today.importKwh} kWh` : "—"}
              </div>
              {today && (
                <div className="card-label">
                  export {today.exportKwh} kWh · {today.coverage}%
                </div>
              )}
            </div>
            <div className="card">
              <div className="card-label">Meter</div>
              <div className="card-value small">
                {snapshot.meter.model}
                <br />
                <span className="muted">
                  {snapshot.meter.type} · SW {snapshot.meter.swVersion}
                </span>
              </div>
            </div>
          </div>

          {/* Mobile: stacked per-phase cards (NN/g mobile-table pattern).
              Desktop: classic table. CSS switches between the two. */}
          <div className="phase-cards">
            {snapshot.primary.phases.map((p, i) => (
              <div className="phase-card" key={i}>
                <span className="phase-name">L{i + 1}</span>
                <span className="phase-power">{p.power} W</span>
                <span className="phase-detail">
                  {p.current} A · {p.voltage} V · solar {snapshot.secondary.phases[i].power} W
                </span>
              </div>
            ))}
          </div>

          <div className="table-wrap">
            <table>
            <thead>
              <tr>
                <th>Phase</th>
                <th>Grid power</th>
                <th>Current</th>
                <th>Voltage</th>
                <th>Solar power</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.primary.phases.map((p, i) => (
                <tr key={i}>
                  <td>L{i + 1}</td>
                  <td>{p.power} W</td>
                  <td>{p.current} A</td>
                  <td>{p.voltage} V</td>
                  <td>{snapshot.secondary.phases[i].power} W</td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
          <p className="muted">last update: {new Date(snapshot.timestamp).toLocaleTimeString()}</p>
        </>
      )}
    </div>
  );
}
