import { useEffect, useState } from "react";
import UpdatedStamp from "../components/UpdatedStamp.jsx";

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

// Battery tab: animated SOC gauge (with the configured min/max markers right
// on it) + every battery parameter, from GET /api/battery/params (10 s poll —
// the slow-changing device config is cached server-side for 6 h).
export default function BatteryTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);

  const load = (refresh = false) =>
    fetch(`/api/battery/params${refresh ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) throw new Error(res.error);
        setData(res.data);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setRefreshing(false));

  useEffect(() => {
    load();
    const timer = setInterval(() => load(), 10000);
    return () => clearInterval(timer);
  }, []);

  if (error && !data) return <div className="error-box">{error}</div>;
  if (!data) return <p className="muted">loading…</p>;

  const { live, config, features, constants } = data;
  const soc = live?.soc ?? 0;
  const lvlClass = soc > 50 ? "lvl-high" : soc >= 20 ? "lvl-mid" : "lvl-low";
  // Dominant direction only — PV can split so both read > 0 at once.
  const mode =
    (live?.chargeW ?? 0) > (live?.outputW ?? 0)
      ? "charging"
      : (live?.outputW ?? 0) > 0
        ? "discharging"
        : "idle";
  const minPct = config?.dischargeLowerLimitPct;
  const maxPct = config?.chargeUpperLimitPct;
  const usableKwh =
    minPct != null && maxPct != null
      ? Math.round((((maxPct - minPct) / 100) * constants.capacityKwh) * 100) / 100
      : null;

  return (
    <div>
      <UpdatedStamp at={live?.ts}>
        {live?.name ?? "battery"} · {live?.sn ?? "—"}
      </UpdatedStamp>

      <div className="card batt-gauge-card">
        {live ? (
          <>
            <div className="batt-gauge-wrap">
              <div className="batt-gauge-body">
                <div
                  className={`batt-gauge-fill ${lvlClass} ${mode}`}
                  style={{ width: `${soc}%` }}
                />
                {minPct != null && (
                  <div className="batt-tick" style={{ left: `${minPct}%` }} title={`min discharge ${minPct}%`} />
                )}
                {maxPct != null && (
                  <div className="batt-tick" style={{ left: `${maxPct}%` }} title={`max charge ${maxPct}%`} />
                )}
                <div className="batt-gauge-center">
                  <span className="batt-gauge-pct">{soc} %</span>
                  <span className="batt-gauge-kwh">
                    {live.storedKwh} kWh of {constants.capacityKwh} kWh
                  </span>
                </div>
              </div>
              <div className="batt-gauge-cap" />
              {minPct != null && (
                <span className="batt-tick-label" style={{ left: `${minPct}%` }}>
                  min {minPct}%
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
                  ⚡ charging {fmtW(live.chargeW)}
                </>
              )}
              {mode === "discharging" && (
                <>
                  <span className="batt-chevs">
                    <span>▼</span>
                    <span>▼</span>
                    <span>▼</span>
                  </span>
                  ⏏ discharging {fmtW(live.outputW)}
                </>
              )}
              {mode === "idle" && "idle"}
              {usableKwh != null && (
                <span className="batt-status-sub">usable window ≈ {usableKwh} kWh</span>
              )}
            </div>
          </>
        ) : (
          <p className="muted">no battery data yet</p>
        )}
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
                onClick={() => {
                  setRefreshing(true);
                  load(true);
                }}
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
            <ParamRow k="Temperature" v={fmtTemp(live?.temperatureC)} />
            <ParamRow k="Charging status" v={live?.chargingStatus ?? "—"} />
            <ParamRow k="Error code" v={live?.errCode ?? "—"} />
            <ParamRow k="Heating power" v={fmtW(live?.heatingPower)} />
            <ParamRow k="PV1 / PV2" v={`${fmtW(live?.pv1W)} / ${fmtW(live?.pv2W)}`} />
            <ParamRow k="Grid → battery" v={fmtW(live?.gridToBatteryW)} />
            <ParamRow k="PV → grid" v={fmtW(live?.pvToGridW)} />
            <ParamRow k="Home load" v={fmtW(live?.homeLoadW)} />
            <ParamRow k="Device" v={live?.sn ? `${live.name} · ${live.sn}` : (live?.name ?? "—")} />
          </div>
        </div>
      )}
    </div>
  );
}
