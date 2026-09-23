import { useEffect, useMemo, useRef, useState } from "react";
import FlowDiagram from "../FlowDiagram.jsx";
import FlipTile from "../components/FlipTile.jsx";
import PowerPlanCard from "./PowerPlanCard.jsx";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import TodayMiniChart from "./TodayMiniChart.jsx";
import { batteryEtaHours, formatEta } from "../batteryEta.js";
import { useLiveStream } from "../useLiveStream.js";
import { useTweenedWatts } from "../useTweenedValue.js";

// Live tab: connection badges, power-flow diagram, main tiles, and the
// grid/PV detail breakdown. Live data arrives over the WebSocket
// (/ws, {type:"live"} messages pushed the moment the server has new
// meter/battery data — 2026-09-22, user request: "as fast as the Anker
// app", whose own live view is MQTT push at ~3-5 s). An initial REST fetch
// paints immediately, and a slow 30 s REST poll remains as a safety net in
// case the WS silently dies. Health/profile stay on their own slow polls.
// Display deadband (2026-09-22, user report: "our app almost always shows
// pushing into the grid, the Anker app the opposite"). Verified against 24h
// of production data: the meter reads a small NEGATIVE value 24% of
// daylight buckets — the Solarbank's zero-export regulation oscillates a
// few watts around zero when PV ≈ demand (median −9 W, worst −85 W), and
// Anker's own cloud trend shows the same −7…−11 W class — but the Anker
// APP smooths that band to "0 W" while we lit up a visible export arc for
// every flicker. DISPLAY-ONLY: graphs, stats, and the controller's export
// watchdog keep the raw signed value; sustained real export (> 20 W)
// still shows.
const GRID_DISPLAY_DEADBAND_W = 20;

export default function LiveTab() {
  const [live, setLive] = useState(null); // meter state (WS meter / /api/live)
  const [flow, setFlow] = useState(null); // flow payload (WS flow / /api/flow)
  const [health, setHealth] = useState(null); // /api/health
  const [detailsOpen, setDetailsOpen] = useState(false); // Details section: collapsed by default
  const [todayProfile, setTodayProfile] = useState(null); // /api/stats/overview's profile, for the flip-side mini charts
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const get = (url) => fetch(url).then((r) => r.json()).catch(() => null);
    const fast = () =>
      Promise.all([get("/api/live"), get("/api/flow")]).then(([l, f]) => {
        if (!mounted.current) return;
        if (l?.ok) setLive(l.data);
        if (f?.ok) setFlow(f.data);
      });
    const slow = () =>
      get("/api/health").then((h) => h?.ok && mounted.current && setHealth(h.data));
    // Today's profile only changes gently through the day — a slower,
    // best-effort poll (not tied to the 5 s live loop) is plenty; a failure
    // here just means the flip side stays empty, nothing else breaks.
    const today = () =>
      get("/api/stats/overview").then(
        (r) => r?.ok && mounted.current && setTodayProfile(r.data.profile),
      );
    fast();
    slow();
    today();

    // Safety net only: live values arrive over the shared WS push channel
    // (useLiveStream below); if the socket is down (reconnect backoff
    // running there), the UI still refreshes — just slowly.
    const t1 = setInterval(fast, 30000);
    const t2 = setInterval(slow, 10000);
    const t3 = setInterval(today, 60000);
    return () => {
      mounted.current = false;
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
    };
  }, []);

  // Push channel: the server sends {type:"live", meter, flow} the moment it
  // has new meter (2 s) or battery (3-5 s MQTT / 10 s REST) data.
  const streamMsg = useLiveStream();
  useEffect(() => {
    if (!streamMsg) return;
    if (streamMsg.meter) setLive(streamMsg.meter);
    if (streamMsg.flow) setFlow(streamMsg.flow);
  }, [streamMsg]);

  const snapshot = live?.snapshot;
  const cloudGrid = snapshot == null ? live?.cloud : null;
  const grid = snapshot?.primary?.totalPower ?? cloudGrid?.power ?? null;
  const gridFromCloud = snapshot?.primary?.totalPower == null && cloudGrid != null;
  const phases = snapshot?.primary?.phases;
  const battery = flow?.battery;
  const pv = flow?.pv;
  // Display-deadbanded grid (see GRID_DISPLAY_DEADBAND_W above): tile and
  // flow diagram both use the clamped values, raw stays in the flip-side
  // chart and everywhere else.
  const gridDisplay = grid != null && Math.abs(grid) <= GRID_DISPLAY_DEADBAND_W ? 0 : grid;
  const flowDisplay =
    flow?.grid &&
    Math.abs((flow.grid.import ?? 0) - (flow.grid.export ?? 0)) <= GRID_DISPLAY_DEADBAND_W
      ? { ...flow, grid: { ...flow.grid, import: 0, export: 0 } }
      : flow;
  // Tweened display values for the tiles (2026-09-23, user request — the
  // Anker app animates number transitions; same cadence, now same glide).
  const homeW = useTweenedWatts(flow?.home?.consumption ?? null);
  const gridW = useTweenedWatts(gridDisplay);
  const battW = useTweenedWatts(
    battery ? ((battery.cells ?? 0) > 0 ? (battery.cells ?? 0) : (battery.charge ?? 0)) : null,
  );
  const pvW = useTweenedWatts(pv?.production ?? null);
  const pvHomeW = useTweenedWatts(pv?.toHome ?? null);
  const pvBattW = useTweenedWatts(pv?.toBattery ?? null);
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

  // Today-so-far series for each tile's flip side, from the same `profile`
  // buckets the Dashboard's "Today" bars use — grid.power is already signed
  // (+ import / − export, matching the Grid tile); pvHome is PV-to-house
  // (same field the Dashboard's own PV bar uses — not total production,
  // kept consistent rather than introducing a second PV definition); house
  // is reconstructed the same way the Dashboard's hourly bars are (grid
  // import + battery discharge + PV-to-house).
  // Battery: two DISTINCT series, not one signed line — discharging (cells,
  // ≥0, excl. PV pass-through, same quantity the front tile's "discharging"
  // reading uses) and charging (chargeW, plotted negative so it falls below
  // the zero line same as before), each its own color so direction reads
  // from color as well as sign (2026-09-19, user follow-up: "show both load
  // and unload" — a single purple line only distinguished by which side of
  // zero it fell on). NOT the raw `batt` field (output_w − charge_w), which
  // conflates PV pass-through with real charge/discharge.
  // Memoized on todayProfile (2026-09-22 code review): these arrays were
  // rebuilt on EVERY 1-3 Hz WS push render, and TodayMiniChart's effect
  // keys on `lines` identity — so all four flip-side charts did a full
  // echarts dispose+init per push even though the profile only changes
  // once a minute.
  const [gridSeries, houseSeries, battDischargeSeries, battChargeSeries, pvSeries] =
    useMemo(() => {
      const toSeries = (pick) => todayProfile?.map((p) => [p.t, pick(p)]) ?? [];
      return [
        toSeries((p) => p.power),
        toSeries((p) => Math.max(p.power, 0) + Math.max(p.cells ?? 0, 0) + Math.max(p.pvHome ?? 0, 0)),
        toSeries((p) => Math.max(p.cells ?? 0, 0)),
        toSeries((p) => -Math.max(p.chargeW ?? 0, 0)),
        toSeries((p) => p.pvHome),
      ];
    }, [todayProfile]);

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
      <FlowDiagram flow={flowDisplay} />

      <div className="cards">
        <FlipTile back={<TodayMiniChart lines={[{ data: houseSeries, color: "#e8ecef" }]} />}>
          <div className="card">
            <div className="card-label">House</div>
            <div className="card-value">
              {homeW != null ? `${homeW} W` : "—"}
            </div>
            <div className="card-label">total consumption</div>
          </div>
        </FlipTile>
        <FlipTile
          back={<TodayMiniChart lines={[{ data: gridSeries, color: "#f7a44f" }]} zeroLine />}
        >
          <div className="card">
            <div className="card-label">
              Grid {gridDisplay != null ? (gridDisplay > 0 ? "import" : gridDisplay < 0 ? "export" : "balanced") : ""}
            </div>
            <div className={`card-value ${gridDisplay != null ? (gridDisplay > 0 ? "import" : gridDisplay < 0 ? "export" : "") : ""}`}>
              {gridW != null ? `${Math.abs(gridW)} W` : "—"}
            </div>
            <div className="card-label">
              {gridFromCloud ? "via cloud" : gridDisplay != null ? "meter direct" : "—"}
            </div>
          </div>
        </FlipTile>
        <FlipTile
          back={
            <TodayMiniChart
              lines={[
                { data: battDischargeSeries, color: "#c084fc", name: "Discharging" },
                { data: battChargeSeries, color: "#8b98a5", name: "Charging" },
              ]}
              zeroLine
            />
          }
        >
          <div className="card">
            <div className="card-label">Battery</div>
            <div className="card-value" style={{ color: "#c084fc" }}>
              {battery
                ? (battery.cells ?? 0) > 0
                  ? `⏏ −${battW ?? 0} W`
                  : battery.charge > 0
                    ? `⚡ +${battW ?? 0} W`
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
        <FlipTile back={<TodayMiniChart lines={[{ data: pvSeries, color: "#5fce80" }]} />}>
          <div className="card">
            <div className="card-label">Solar PV</div>
            <div className="card-value" style={{ color: "#5fce80" }}>
              {pvW != null ? `${pvW} W` : "—"}
            </div>
            <div className="card-label">
              {pv && pv.production > 0
                ? pv.toHome > 0 && pv.toBattery > 0
                  ? `${pvHomeW ?? 0} W house · ${pvBattW ?? 0} W battery`
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
