import { useEffect, useMemo, useRef, useState } from "react";
import FlowView from "../flow/FlowView.jsx";
import FlipTile from "../components/FlipTile.jsx";
import StateIcon from "../components/StateIcon.jsx";
import PowerPlanCard from "./PowerPlanCard.jsx";
import SectionTitle from "../components/SectionTitle.jsx";
import GradientMeter from "../components/GradientMeter.jsx";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import TodayMiniChart from "./TodayMiniChart.jsx";
import { batteryEtaHours, formatEta } from "../batteryEta.js";
import { useLiveStream } from "../useLiveStream.js";
import { useTweenedWatts } from "../useTweenedValue.js";
import { useT } from "../i18n/LanguageProvider.jsx";

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
// Grid phase meters have no configured capacity to scale against (unlike
// PV ports' PV_PORT_W_*), so this is a display-only reference, not a
// claimed circuit rating: a standard single-phase 16 A / 230 V EU breaker
// (2026-10-04, same GradientMeter control as Solar Strings — "take care
// that they can be also negative").
const PHASE_MAX_W = 3680;

export default function LiveTab() {
  const t = useT();
  const [live, setLive] = useState(null); // meter state (WS meter / /api/live)
  const [flow, setFlow] = useState(null); // flow payload (WS flow / /api/flow)
  const [health, setHealth] = useState(null); // /api/health
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
  // The tile displays the SAME app channels as the flow diagram
  // (2026-09-29 review: v1.5.127 changed the server but this tile never
  // consumed flow.grid — it kept reading the meter snapshot, so the exact
  // tile↔arc divergence the change promised to fix persisted). The meter
  // reading is now the fallback for when the feed is down (flow.grid
  // absent), matching the diagram's own fallback.
  const gridFlow = flow?.grid ? (flow.grid.import ?? 0) - (flow.grid.export ?? 0) : null;
  const grid = gridFlow ?? snapshot?.primary?.totalPower ?? cloudGrid?.power ?? null;
  const gridFromCloud = flow?.grid ? flow.grid.source !== "meter" : snapshot?.primary?.totalPower == null && cloudGrid != null;
  const phases = snapshot?.primary?.phases;
  const battery = flow?.battery;
  const pv = flow?.pv;
  // Display-deadbanded grid (see GRID_DISPLAY_DEADBAND_W above): the tile
  // uses the clamped value; the diagram applies the same deadband inside
  // flow/model.js (2026-09-29 review: the old flowDisplay wrapper zeroed
  // flow.grid, which the model no longer reads — dead code, removed).
  const gridDisplay = grid != null && Math.abs(grid) <= GRID_DISPLAY_DEADBAND_W ? 0 : grid;
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
  // Charge/discharge ETA (2026-09-18, user request) — maxPct/floorPct/
  // capacityKwh come from /api/flow's battery object (server-resolved
  // account limits, see server/index.js). 2026-09-30 (user report: "the
  // estimated unload time changes every time the battery feed changes" —
  // discharging 10 W read "empty in ≈ 265h 36m"): the DISCHARGE estimate
  // uses the stable 7-day-average figure (the diagram node's
  // timeToEmptyH, average-rate to the effective floor); charging keeps the
  // current-rate estimate (PV-driven and steady).
  const battMode = battery
    ? (battery.cells ?? 0) > 0
      ? "discharging"
      : battery.charge > 0
        ? "charging"
        : "idle"
    : null;
  const battEta = battery
    ? battMode === "discharging"
      ? formatEta(flow?.diagram?.timeToEmptyH ?? null)
      : formatEta(
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
          ? t("live.sources", {
              grid: flow.grid.source === "meter" ? t("live.meterDirect") : t("live.online"),
              battery: t("live.online"),
            })
          : ""}
      </UpdatedStamp>
      <p>
        <Badge ok={cloudFresh} warn={!health?.cloud?.enabled}>
          {t("live.badges.meterOnline")}
        </Badge>{" "}
        <Badge ok={batteryFresh}>{t("live.badges.batteryOnline")}</Badge>{" "}
        <Badge ok={meterDirect}>{t("live.meterDirect")}</Badge>
      </p>

      <SectionTitle>{t("live.powerFlow")}</SectionTitle>
      <FlowView flow={flow} />

      <div className="cards">
        <FlipTile back={<TodayMiniChart lines={[{ data: houseSeries, color: "#e8ecef" }]} />}>
          <div className="card">
            <div className="card-label">{t("live.tiles.house")}</div>
            <div className="card-value">
              {homeW != null ? `${homeW} W` : "—"}
            </div>
            <div className="card-label">{t("live.tiles.totalConsumption")}</div>
          </div>
        </FlipTile>
        <FlipTile
          back={<TodayMiniChart lines={[{ data: gridSeries, color: "#f7a44f" }]} zeroLine />}
        >
          <div className="card">
            <div className="card-label">
              {t("live.tiles.grid")} {gridDisplay != null ? (gridDisplay > 0 ? t("live.grid.import") : gridDisplay < 0 ? t("live.grid.export") : t("live.grid.balanced")) : ""}
            </div>
            <div className={`card-value ${gridDisplay != null ? (gridDisplay > 0 ? "import" : gridDisplay < 0 ? "export" : "") : ""}`}>
              {gridW != null ? `${Math.abs(gridW)} W` : "—"}
            </div>
            <div className="card-label">
              {gridFromCloud ? t("live.viaCloud") : gridDisplay != null ? t("live.meterDirect") : "—"}
            </div>
          </div>
        </FlipTile>
        <FlipTile
          back={
            <TodayMiniChart
              lines={[
                { data: battDischargeSeries, color: "#c084fc", name: t("live.battery.discharging") },
                { data: battChargeSeries, color: "#8b98a5", name: t("live.battery.charging") },
              ]}
              zeroLine
            />
          }
        >
          <div className="card">
            <div className="card-label">{t("live.tiles.battery")}</div>
            <div className="card-value batt-card-value" style={{ color: "#c084fc" }}>
              {battery ? (
                (battery.cells ?? 0) > 0 ? (
                  <>
                    <StateIcon mode="discharging" size={18} /> −{battW ?? 0} W
                  </>
                ) : battery.charge > 0 ? (
                  <>
                    <StateIcon mode="charging" size={18} /> +{battW ?? 0} W
                  </>
                ) : (
                  <>
                    <StateIcon mode="idle" size={18} /> {t("live.battery.idle")}
                  </>
                )
              ) : (
                "—"
              )}
            </div>
            <div className="card-label">
              {battery
                ? (battery.cells ?? 0) > 0
                  ? t("live.battery.dischargingSoc", { soc: battery.soc })
                  : battery.charge > 0
                    ? (battery.gridCharge ?? 0) > 0
                      ? t("live.battery.chargingGridSoc", {
                          soc: battery.soc,
                          grid: `${Math.round(battery.gridCharge)} W`,
                        })
                      : t("live.battery.chargingSoc", { soc: battery.soc })
                    : t("live.battery.idleSoc", { soc: battery.soc })
                : t("live.battery.offline")}
            </div>
            {battEta && (
              <div className="card-label">
                {battMode === "discharging"
                  ? t("live.battery.emptyIn", { eta: battEta })
                  : t("live.battery.fullIn", { eta: battEta })}
              </div>
            )}
          </div>
        </FlipTile>
        <FlipTile back={<TodayMiniChart lines={[{ data: pvSeries, color: "#5fce80" }]} />}>
          <div className="card">
            <div className="card-label">{t("live.tiles.solarPv")}</div>
            <div className="card-value" style={{ color: "#5fce80" }}>
              {pvW != null ? `${pvW} W` : "—"}
            </div>
            <div className="card-label">
              {pv && pv.production > 0
                ? pv.toHome > 0 && pv.toBattery > 0
                  ? t("live.pv.split", { home: pvHomeW ?? 0, battery: pvBattW ?? 0 })
                  : pv.toBattery > 0
                    ? t("live.pv.chargingBattery")
                    : t("live.pv.toHouse")
                : t("live.pv.noProduction")}
            </div>
          </div>
        </FlipTile>
      </div>

      <PowerPlanCard />

      <SectionTitle>{t("live.details")}</SectionTitle>
      <h4>{t("live.tiles.grid")}</h4>
      <div className="phase-cards">
        {(phases ?? [null, null, null]).map((p, i) => (
          <FlipTile key={i}>
            <div className="phase-card">
              <span className="phase-name">L{i + 1}</span>
              <span className="phase-power">{p ? `${p.power} W` : "—"}</span>
              <span className="phase-detail">{p ? `${p.current} A · ${p.voltage} V` : ""}</span>
              {p && <GradientMeter value={p.power} max={PHASE_MAX_W} bidirectional />}
            </div>
          </FlipTile>
        ))}
      </div>
      <h4>{t("live.tiles.solarPv")}</h4>
      <div className="phase-cards">
        <FlipTile>
          <div className="phase-card">
            <span className="phase-name">{t("live.pvTotal")}</span>
            <span className="phase-power">{pv ? `${pv.production} W` : "—"}</span>
            {pv && <GradientMeter value={pv.production} max={pv.peakW} />}
          </div>
        </FlipTile>
      </div>
      {/* Every MPPT channel of every unit (2026-09-28, user request):
          connected strings (ever seen producing — server-side sticky
          marker) show live watts; never-producing channels render
          disabled. Replaces the old fixed PV1/PV2 cards, which only
          covered the primary unit's first two strings. */}
      {(battery?.pvUnits ?? []).map((u) => (
        <div key={u.sn}>
          {(battery.pvUnits?.length ?? 0) > 1 && <p className="pv-unit-label muted">{u.name}</p>}
          <div className="phase-cards">
            {u.channels.map((c) =>
              c.connected ? (
                <FlipTile key={c.n}>
                  <div className="phase-card">
                    <span className="phase-name">{c.name}</span>
                    {/* watts is null while the unit's MQTT push channel
                        is stalled — an honest "—", never the frozen
                        scen_info pv_power number. */}
                    <span className="phase-power">{c.watts != null ? `${c.watts} W` : "—"}</span>
                    <GradientMeter value={c.watts} max={c.peakW} />
                  </div>
                </FlipTile>
              ) : (
                // Not flippable — an empty back face behind a dead
                // channel would just be noise.
                <div key={c.n} className="phase-card off">
                  <span className="phase-name">{c.name}</span>
                  <span className="phase-power">—</span>
                  <span className="phase-detail">{t("live.pvNotConnected")}</span>
                </div>
              ),
            )}
          </div>
        </div>
      ))}
      {/* Fallback for the DB-fallback battery / setups without per-unit
          channel data: the old aggregate PV1/PV2 cards. */}
      {!battery?.pvUnits?.length && battery?.pv1W != null && (
        <div className="phase-cards">
          <FlipTile>
            <div className="phase-card">
              <span className="phase-name">PV1</span>
              <span className="phase-power">{`${battery.pv1W} W`}</span>
              <span className="phase-detail">
                {pv?.pv1KwhToday != null ? t("live.kwhToday", { kwh: pv.pv1KwhToday }) : ""}
              </span>
            </div>
          </FlipTile>
          <FlipTile>
            <div className="phase-card">
              <span className="phase-name">PV2</span>
              <span className="phase-power">{`${battery.pv2W} W`}</span>
              <span className="phase-detail">
                {pv?.pv2KwhToday != null ? t("live.kwhToday", { kwh: pv.pv2KwhToday }) : ""}
              </span>
            </div>
          </FlipTile>
        </div>
      )}
      {snapshot && (
        <p className="muted">
          {t("live.meterInfo", {
            model: snapshot.meter.model,
            type: snapshot.meter.type,
            sw: snapshot.meter.swVersion,
            time: new Date(snapshot.timestamp).toLocaleTimeString(),
          })}
        </p>
      )}
    </div>
  );
}

function Badge({ ok, warn, children }) {
  return <span className={`badge ${ok ? "ok" : warn ? "warn" : "bad"}`}>{children}</span>;
}
