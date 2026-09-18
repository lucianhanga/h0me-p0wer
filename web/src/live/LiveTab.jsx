import { useEffect, useRef, useState } from "react";
import FlowDiagram from "../FlowDiagram.jsx";
import FlipTile from "../components/FlipTile.jsx";
import PowerPlanCard from "./PowerPlanCard.jsx";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { batteryEtaHours, formatEta } from "../batteryEta.js";

// Live tab: connection badges, power-flow diagram, main tiles, and the
// grid/PV detail breakdown. Polls the backend every 5 s (flow/meter) and
// 10 s (battery/health).
export default function LiveTab() {
  const [live, setLive] = useState(null); // /api/live (meter snapshot)
  const [flow, setFlow] = useState(null); // /api/flow
  const [health, setHealth] = useState(null); // /api/health
  const [detailsOpen, setDetailsOpen] = useState(false); // Details section: collapsed by default
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
  const cloudGrid = snapshot == null ? live?.cloud : null;
  const grid = snapshot?.primary?.totalPower ?? cloudGrid?.power ?? null;
  const gridFromCloud = snapshot?.primary?.totalPower == null && cloudGrid != null;
  const phases = snapshot?.primary?.phases;
  const battery = flow?.battery;
  const pv = flow?.pv;
  // Charge/discharge ETA (2026-09-18, user request) — same shared helper as
  // BatteryTab.jsx; maxPct/floorPct/capacityKwh come from /api/flow's
  // battery object (server-resolved account limits, see server/index.js).
  const battMode = battery
    ? (battery.cells ?? 0) > 0
      ? "discharging"
      : battery.charge > 0
        ? "charging"
        : "idle"
    : null;
  const battEta = battery
    ? formatEta(
        batteryEtaHours({
          mode: battMode,
          soc: battery.soc,
          chargeW: battery.charge,
          cellsW: battery.cells,
          maxPct: battery.maxPct,
          floorPct: battery.floorPct,
          capacityKwh: battery.capacityKwh,
        }),
      )
    : null;

  // Badge logic
  const meterDirect = health?.meterDirect ?? live?.connected ?? false;
  const cloudFresh =
    health?.cloud?.enabled && health?.cloud?.lastOkAt != null &&
    Date.now() - health.cloud.lastOkAt < 5 * 60 * 1000;
  const batteryFresh =
    health?.battery?.lastTs != null && Date.now() - health.battery.lastTs < 90 * 1000;

  return (
    <div>
      <UpdatedStamp at={flow?.obtainedAt ?? flow?.ts}>
        {flow
          ? `grid: ${flow.grid.source === "meter" ? "meter direct" : "online"} · battery: online`
          : ""}
      </UpdatedStamp>
      <p>
        <Badge ok={cloudFresh} warn={!health?.cloud?.enabled}>
          meter online
        </Badge>{" "}
        <Badge ok={batteryFresh}>battery online</Badge>{" "}
        <Badge ok={meterDirect}>meter direct</Badge>
      </p>

      <h3>Power Flow</h3>
      <FlowDiagram flow={flow} />

      <div className="cards">
        <FlipTile>
          <div className="card">
            <div className="card-label">House</div>
            <div className="card-value">
              {flow?.home?.consumption != null ? `${flow.home.consumption} W` : "—"}
            </div>
            <div className="card-label">total consumption</div>
          </div>
        </FlipTile>
        <FlipTile>
          <div className="card">
            <div className="card-label">
              Grid {grid != null && (grid >= 0 ? "import" : "export")}
            </div>
            <div className={`card-value ${grid != null ? (grid >= 0 ? "import" : "export") : ""}`}>
              {grid != null ? `${Math.abs(grid)} W` : "—"}
            </div>
            <div className="card-label">
              {gridFromCloud ? "via cloud" : grid != null ? "meter direct" : "—"}
            </div>
          </div>
        </FlipTile>
        <FlipTile>
          <div className="card">
            <div className="card-label">Battery</div>
            <div className="card-value" style={{ color: "#c084fc" }}>
              {battery
                ? (battery.cells ?? 0) > 0
                  ? `⏏ −${battery.cells} W`
                  : battery.charge > 0
                    ? `⚡ +${battery.charge} W`
                    : "idle"
                : "—"}
            </div>
            <div className="card-label">
              {battery
                ? (battery.cells ?? 0) > 0
                  ? `discharging · ${battery.soc}%`
                  : battery.charge > 0
                    ? `charging · ${battery.soc}%`
                    : `idle · ${battery.soc}%`
                : "offline"}
            </div>
            {battEta && (
              <div className="card-label">
                {battMode === "discharging" ? `empty in ≈ ${battEta}` : `full in ≈ ${battEta}`}
              </div>
            )}
          </div>
        </FlipTile>
        <FlipTile>
          <div className="card">
            <div className="card-label">Solar PV</div>
            <div className="card-value" style={{ color: "#5fce80" }}>
              {pv ? `${pv.production} W` : "—"}
            </div>
            <div className="card-label">
              {pv && pv.production > 0
                ? pv.toHome > 0 && pv.toBattery > 0
                  ? `${pv.toHome} W house · ${pv.toBattery} W battery`
                  : pv.toBattery > 0
                    ? "charging the battery"
                    : "to the house"
                : "no production"}
            </div>
          </div>
        </FlipTile>
      </div>

      <PowerPlanCard />

      <button
        className="details-toggle"
        onClick={() => setDetailsOpen((o) => !o)}
        aria-expanded={detailsOpen}
      >
        Details <span className="chevron">{detailsOpen ? "▾" : "▸"}</span>
      </button>
      {detailsOpen && (
        <>
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
                <span className="phase-detail">
                  {pv?.pv1KwhToday != null ? `${pv.pv1KwhToday} kWh today` : ""}
                </span>
              </div>
            </FlipTile>
            <FlipTile>
              <div className="phase-card">
                <span className="phase-name">PV2</span>
                <span className="phase-power">{battery?.pv2W != null ? `${battery.pv2W} W` : "—"}</span>
                <span className="phase-detail">
                  {pv?.pv2KwhToday != null ? `${pv.pv2KwhToday} kWh today` : ""}
                </span>
              </div>
            </FlipTile>
          </div>
          {snapshot && (
            <p className="muted">
              {snapshot.meter.model} · {snapshot.meter.type} · SW {snapshot.meter.swVersion} · last
              update {new Date(snapshot.timestamp).toLocaleTimeString()}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Badge({ ok, warn, children }) {
  return <span className={`badge ${ok ? "ok" : warn ? "warn" : "bad"}`}>{children}</span>;
}
