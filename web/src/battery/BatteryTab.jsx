import { useState } from "react";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { batteryEtaHours, formatEta } from "../batteryEta.js";
import { usePolledResource } from "../usePolledResource.js";

// Rendered inside StrategyTab.jsx (moved out of its own top-level tab
// 2026-09-16) — the gauge stays visible, the detailed param cards below
// collapse by default (same .details-toggle pattern as PowerPlanCard.jsx).

const fmtW = (v) => (v == null ? "—" : `${Math.round(v)} W`);
const fmtPct = (v) => (v == null ? "—" : `${v} %`);
const fmtTemp = (v) => (v == null ? "—" : `${Math.round(v)} °C`);
const onOff = (v) => (v == null ? "—" : v ? "on" : "off");
const fmtTime = (ts) =>
  ts == null
    ? "—"
    : new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function ParamRow({ k, v }) {
  return (
    <div className="param-row">
      <span className="param-k">{k}</span>
      <span className="param-v">{v}</span>
    </div>
  );
}

// One battery: animated SOC gauge (with the configured min/max markers right
// on it) + every battery parameter. Split out of BatteryTab (2026-09-21,
// user request) so a second physical battery — "it will soon come," not
// installed yet — is a data change, not a redesign: BatteryTab already
// maps over an array and stacks cards vertically (see its own comment for
// why vertical, not side-by-side — battery UI/UX research below).
//
// Own/muted next to the state text, never color alone (2026-09-21,
// applying that same research): the near-full/low SOC zones already had
// distinct gauge colors, but nothing NAMED the zone — you had to read the
// number and know the thresholds yourself. `zoneLabel` below adds that.
function BatteryCard({ live, config, features, constants, dischargeTolerancePct, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);

  const forceRefresh = () => {
    setRefreshing(true);
    onRefresh().finally(() => setRefreshing(false));
  };

  if (!live) return <p className="muted">no battery data yet</p>;

  const soc = live.soc ?? 0;
  // 2026-09-17: near-full gets its own color (user request) — distinct from
  // "just healthy" (lvl-high) so a topped-up battery reads at a glance.
  const lvlClass = soc > 90 ? "lvl-full" : soc > 50 ? "lvl-high" : soc >= 20 ? "lvl-mid" : "lvl-low";
  const zoneLabel = lvlClass === "lvl-full" ? "Full" : lvlClass === "lvl-low" ? "Low" : null;
  // 2026-09-16 fix: outputW is the TOTAL inverter output (PV pass-through +
  // cell discharge combined, see server/battery-params.js's
  // deriveBatteryFlow) — comparing it directly misread pure PV pass-through
  // (chargeW=0, outputW>0) as "discharging", disagreeing with the Live
  // tab's flow diagram. cellsW is the actual battery discharge power.
  // Dominant direction only, matching FlowDiagram's own rule — chargeW and
  // cellsW can both briefly read a small nonzero value from sensor timing
  // noise (see AGENTS.md), not real simultaneous charge+discharge; a naive
  // "chargeW > 0" check let a tiny charging blip override a real, larger
  // discharge.
  const chargeW = live.chargeW ?? 0;
  const cellsW = live.cellsW ?? 0;
  const mode = chargeW > cellsW ? "charging" : cellsW > chargeW ? "discharging" : "idle";
  const minPct = config?.dischargeLowerLimitPct;
  const maxPct = config?.chargeUpperLimitPct;
  // The account's configured floor is not where the controller actually
  // stops discharging — dischargeToTarget() pads it by DISCHARGE_TOLERANCE_PCT
  // as a safety margin (see power-plan.js; 3 points as of 2026-09-19, so
  // 13% on a 10% account floor). Shown as a second, distinct marker so
  // "why does it stop there, not at the account floor?" is answered on
  // the gauge itself instead of only in server-side comments. In native
  // self-consumption mode StrategyTab passes 0 (the device enforces its own
  // cutoff directly) — the second marker then equals the first and is
  // suppressed below to avoid two overlapping ticks/labels.
  const effectiveFloorPct =
    minPct != null && dischargeTolerancePct != null ? minPct + dischargeTolerancePct : null;
  const showFloorTick = effectiveFloorPct != null && effectiveFloorPct !== minPct;
  const usableKwh =
    minPct != null && maxPct != null
      ? Math.round((((maxPct - minPct) / 100) * constants.capacityKwh) * 100) / 100
      : null;
  const etaLabel = formatEta(
    batteryEtaHours({
      mode,
      soc,
      chargeW,
      cellsW,
      maxPct,
      floorPct: effectiveFloorPct ?? minPct,
      capacityKwh: constants?.capacityKwh,
    }),
  );

  return (
    <div>
      <div className="card batt-gauge-card">
        <div className="batt-card-head">
          <span className="batt-card-name">{live.name ?? "battery"}</span>
          {live.sn && <span className="batt-card-sn">{live.sn}</span>}
        </div>
        <div className="batt-gauge-wrap">
          <div className={`batt-gauge-body ${lvlClass}`}>
            <div className={`batt-gauge-fill ${lvlClass} ${mode}`} style={{ width: `${soc}%` }} />
            {minPct != null && (
              <div
                className="batt-tick"
                style={{ left: `${minPct}%` }}
                title={`account discharge floor ${minPct}%`}
              />
            )}
            {showFloorTick && (
              <div
                className="batt-tick batt-tick-floor"
                style={{ left: `${effectiveFloorPct}%` }}
                title={`controller won't discharge below ${effectiveFloorPct}% (${minPct}% floor + ${dischargeTolerancePct}% safety margin)`}
              />
            )}
            {maxPct != null && (
              <div className="batt-tick" style={{ left: `${maxPct}%` }} title={`max charge ${maxPct}%`} />
            )}
            <div className="batt-gauge-center">
              <span className="batt-gauge-pct">
                {soc} %{zoneLabel && <span className={`batt-gauge-zone ${lvlClass}`}>{zoneLabel}</span>}
              </span>
              <span className="batt-gauge-kwh">
                {live.storedKwh} kWh of {constants.capacityKwh} kWh
              </span>
            </div>
          </div>
          <div className={`batt-gauge-cap ${lvlClass}`} />
          {minPct != null && (
            <span className="batt-tick-label" style={{ left: `${minPct}%` }}>
              min {minPct}%
            </span>
          )}
          {showFloorTick && (
            <span className="batt-tick-label batt-tick-label-floor" style={{ left: `${effectiveFloorPct}%` }}>
              floor {effectiveFloorPct}%
            </span>
          )}
          {maxPct != null && (
            <span className="batt-tick-label" style={{ left: `${maxPct}%` }}>
              max {maxPct}%
            </span>
          )}
        </div>
        <div className={`batt-status ${mode}`}>
          {mode === "charging" && (
            <>
              <span className="batt-chevs">
                <span>▲</span>
                <span>▲</span>
                <span>▲</span>
              </span>
              <span className="batt-status-main">⚡ charging {fmtW(chargeW)}</span>
              {etaLabel && <span className="batt-status-eta">full in ≈ {etaLabel}</span>}
            </>
          )}
          {mode === "discharging" && (
            <>
              <span className="batt-chevs">
                <span>▼</span>
                <span>▼</span>
                <span>▼</span>
              </span>
              <span className="batt-status-main">⏏ discharging {fmtW(cellsW)}</span>
              {etaLabel && <span className="batt-status-eta">empty in ≈ {etaLabel}</span>}
            </>
          )}
          {mode === "idle" && <span className="batt-status-main">idle</span>}
          {usableKwh != null && <span className="batt-status-sub">usable window ≈ {usableKwh} kWh</span>}
        </div>
      </div>

      <button className="details-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Battery information <span className="chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="param-cards">
          <div className="card">
            <div className="card-label">
              Configuration
              <button
                className={`wx-refresh${refreshing ? " spinning" : ""}`}
                disabled={refreshing}
                title="refetch device configuration from the cloud"
                onClick={forceRefresh}
              >
                ↻
              </button>
            </div>
            <ParamRow k="Charge upper limit" v={fmtPct(config?.chargeUpperLimitPct)} />
            <ParamRow k="Discharge lower limit" v={fmtPct(config?.dischargeLowerLimitPct)} />
            <ParamRow
              k="Backup reserve"
              v={
                config?.backupReservePct != null
                  ? `${config.backupReservePct} % · ${onOff(config.backupReserveSwitch)}`
                  : "—"
              }
            />
            <ParamRow
              k="Limits source"
              v={
                <span
                  className={`badge ${["power_cutoff", "account"].includes(config?.limitsSource) ? "ok" : "warn"}`}
                >
                  {config?.limitsSource ?? "unknown"}
                </span>
              }
            />
            <ParamRow k="Zero-export (0w feed)" v={onOff(features?.zeroExport)} />
            <ParamRow k="SOC calibration" v={onOff(config?.socCalibrationEnable)} />
            <ParamRow
              k="Config fetched"
              v={`${fmtTime(config?.fetchedAt)}${config?.source ? ` · ${config.source}` : ""}`}
            />
            {config?.station && (
              <div className="param-raw">station: {JSON.stringify(config.station)}</div>
            )}
          </div>

          <div className="card">
            <div className="card-label">Status</div>
            <ParamRow k="Temperature" v={fmtTemp(live.temperatureC)} />
            <ParamRow k="Charging status" v={live.chargingStatus ?? "—"} />
            <ParamRow k="Error code" v={live.errCode ?? "—"} />
            <ParamRow k="Heating power" v={fmtW(live.heatingPower)} />
            <ParamRow k="PV1 / PV2" v={`${fmtW(live.pv1W)} / ${fmtW(live.pv2W)}`} />
            <ParamRow k="Grid → battery" v={fmtW(live.gridToBatteryW)} />
            <ParamRow k="PV → grid" v={fmtW(live.pvToGridW)} />
            <ParamRow k="Home load" v={fmtW(live.homeLoadW)} />
          </div>
        </div>
      )}
    </div>
  );
}

// Battery section: one card per battery, stacked VERTICALLY (2026-09-21,
// user request — "it will soon come a second one"). Vertical, not side by
// side, for two reasons found researching multi-device battery dashboards:
// (1) each card already needs real width for its gauge's three threshold
// labels (min/floor/max) plus the collapsible parameter cards below it —
// squeezing two side by side on anything but a wide desktop would crowd
// both; (2) fleet/multi-battery UI guidance favors a clear per-device
// identity (name visible on ITS OWN card, not a shared header) over
// density, since users scan "which battery is doing what" one at a time,
// not comparing two gauges side by side at a glance the way you would two
// KPI numbers.
//
// The endpoint (GET /api/battery/params) only ever returns ONE battery's
// {live, config, features, constants} today — there's no second physical
// battery yet. Rather than wait for that to design around, this reads an
// optional `data.batteries` array first and falls back to treating the
// current single-battery payload as a one-item list — so the day the
// backend actually adds a second device to the response, this component
// needs no changes at all, just more items in the array.
export default function BatteryTab({ dischargeTolerancePct } = {}) {
  const { data, error, setData } = usePolledResource("/api/battery/params", { intervalMs: 10000 });

  // Force a live refetch of the (server-side, 6h-cached) device config —
  // a different URL from the poll above, so it stays a one-off fetch
  // outside the hook rather than forcing the hook to support query params
  // it otherwise never needs. Single-endpoint today (no per-device `sn`
  // param exists server-side yet) — fine while there's only one battery;
  // revisit once a second device needs its own independent refresh.
  const forceRefresh = () =>
    fetch("/api/battery/params?refresh=1")
      .then((r) => r.json())
      .then((res) => res.ok && setData(res.data));

  if (error && !data) return <div className="error-box">{error}</div>;
  if (!data) return <p className="muted">loading…</p>;

  const batteries = Array.isArray(data.batteries) ? data.batteries : [data];
  const latestTs = batteries.reduce((max, b) => Math.max(max, b.live?.ts ?? 0), 0) || null;

  return (
    <div>
      <UpdatedStamp at={latestTs}>
        {batteries.length > 1 ? `${batteries.length} batteries` : (batteries[0].live?.name ?? "battery")}
      </UpdatedStamp>

      <div className="battery-list">
        {batteries.map((b, i) => (
          <BatteryCard
            key={b.live?.sn ?? i}
            live={b.live}
            config={b.config}
            features={b.features}
            constants={b.constants}
            dischargeTolerancePct={dischargeTolerancePct}
            onRefresh={forceRefresh}
          />
        ))}
      </div>
    </div>
  );
}
