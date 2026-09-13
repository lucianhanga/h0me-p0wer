import { useEffect, useRef, useState } from "react";
import FlowDiagram from "../FlowDiagram.jsx";
import FlipTile from "../components/FlipTile.jsx";

// Live tab: connection badges, power-flow diagram, main tiles, and the
// grid/PV detail breakdown. Polls the backend every 5 s (flow/meter) and
// 10 s (battery/health).
export default function LiveTab() {
  const [live, setLive] = useState(null); // /api/live (meter snapshot)
  const [flow, setFlow] = useState(null); // /api/flow
  const [health, setHealth] = useState(null); // /api/health
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const get = (url) => fetch(url).then((r) => r.json()).catch(() => null);
    const fast = () =>
      Promise.all([get("/api/live"), get("/api/flow")]).then(([l, f]) => {
        if (!mounted.current) return;
        if (l) setLive(l);
        if (f?.ok) setFlow(f.data);
      });
    const slow = () =>
      get("/api/health").then((h) => h?.ok && mounted.current && setHealth(h.data));
    fast();
    slow();
    const t1 = setInterval(fast, 5000);
    const t2 = setInterval(slow, 10000);
    return () => {
      mounted.current = false;
      clearInterval(t1);
      clearInterval(t2);
    };
  }, []);

  const snapshot = live?.snapshot;
  const grid = snapshot?.primary?.totalPower;
  const phases = snapshot?.primary?.phases;
  const battery = flow?.battery;
  const pv = flow?.pv;

  // Badge logic
  const meterDirect = health?.meterDirect ?? live?.connected ?? false;
  const cloudFresh =
    health?.cloud?.enabled && health?.cloud?.lastOkAt != null &&
    Date.now() - health.cloud.lastOkAt < 5 * 60 * 1000;
  const batteryFresh =
    health?.battery?.lastTs != null && Date.now() - health.battery.lastTs < 90 * 1000;

  return (
    <div>
      <p>
        <Badge ok={cloudFresh} warn={!health?.cloud?.enabled}>
          meter online
        </Badge>{" "}
        <Badge ok={batteryFresh}>battery online</Badge>{" "}
        <Badge ok={meterDirect}>meter direct</Badge>
      </p>

      <h3>Power Flow</h3>
      <FlowDiagram />

      <div className="cards">
        <FlipTile>
          <div className="card card-hero">
            <div className="card-label">House</div>
            <div className="card-value">
              {flow?.home?.consumption != null ? `${flow.home.consumption} W` : "—"}
            </div>
          </div>
        </FlipTile>
        <FlipTile>
          <div className="card">
            <div className="card-label">Grid {grid != null && (grid >= 0 ? "import" : "export")}</div>
            <div className={`card-value ${grid != null ? (grid >= 0 ? "import" : "export") : ""}`}>
              {grid != null ? `${Math.abs(grid)} W` : "—"}
            </div>
          </div>
        </FlipTile>
        <FlipTile>
          <div className="card">
            <div className="card-label">Battery</div>
            <div className="card-value" style={{ color: "#c084fc" }}>
              {battery
                ? battery.discharge > 0
                  ? `${battery.discharge} W`
                  : battery.charge > 0
                    ? `${battery.charge} W`
                    : "idle"
                : "—"}
            </div>
            <div className="card-label">
              {battery
                ? battery.discharge > 0
                  ? `sending to house · ${battery.soc}%`
                  : battery.charge > 0
                    ? `loading · ${battery.soc}%`
                    : `idle · ${battery.soc}%`
                : "offline"}
            </div>
          </div>
        </FlipTile>
        <FlipTile>
          <div className="card">
            <div className="card-label">Solar PV</div>
            <div className="card-value" style={{ color: "#5fce80" }}>
              {pv ? `${pv.toHome} W` : "—"}
            </div>
            <div className="card-label">
              {pv && pv.production > 0 ? "sending to house" : "no production"}
            </div>
          </div>
        </FlipTile>
      </div>

      <h3>Details</h3>
      <h4>Grid</h4>
      <div className="phase-cards">
        {(phases ?? [null, null, null]).map((p, i) => (
          <FlipTile key={i}>
            <div className="phase-card">
              <span className="phase-name">L{i + 1}</span>
              <span className="phase-power">{p ? `${p.power} W` : "—"}</span>
              <span className="phase-detail">{p ? `${p.current} A · ${p.voltage} V` : ""}</span>
            </div>
          </FlipTile>
        ))}
      </div>
      <h4>Solar PV</h4>
      <div className="phase-cards">
        <FlipTile>
          <div className="phase-card">
            <span className="phase-name">PV total</span>
            <span className="phase-power">{pv ? `${pv.production} W` : "—"}</span>
          </div>
        </FlipTile>
        <FlipTile>
          <div className="phase-card">
            <span className="phase-name">PV1</span>
            <span className="phase-power">{battery?.pv1W != null ? `${battery.pv1W} W` : "—"}</span>
          </div>
        </FlipTile>
        <FlipTile>
          <div className="phase-card">
            <span className="phase-name">PV2</span>
            <span className="phase-power">{battery?.pv2W != null ? `${battery.pv2W} W` : "—"}</span>
          </div>
        </FlipTile>
      </div>
      {snapshot && (
        <p className="muted">
          {snapshot.meter.model} · {snapshot.meter.type} · SW {snapshot.meter.swVersion} · last
          update {new Date(snapshot.timestamp).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

function Badge({ ok, warn, children }) {
  return <span className={`badge ${ok ? "ok" : warn ? "warn" : "bad"}`}>{children}</span>;
}
