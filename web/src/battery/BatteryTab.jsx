import { useEffect, useState } from "react";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { batteryEtaHours, formatEta } from "../batteryEta.js";
import { usePolledResource } from "../usePolledResource.js";
import { useLiveStream } from "../useLiveStream.js";
import BatteryModules from "./BatteryModules.jsx";
import StateIcon from "../components/StateIcon.jsx";
import { useT } from "../i18n/LanguageProvider.jsx";

// Rendered inside StrategyTab.jsx (moved out of its own top-level tab
// 2026-09-16) — the gauge stays visible, the detailed param cards below
// collapse by default (same .details-toggle pattern as PowerPlanCard.jsx).

const fmtW = (v) => (v == null ? "—" : `${Math.round(v)} W`);
const fmtKwh = (v) => (v == null ? "—" : `${v} kWh`);
const fmtPct = (v) => (v == null ? "—" : `${v} %`);
const fmtTemp = (v) => (v == null ? "—" : `${Math.round(v)} °C`);
const onOff = (t, v) => (v == null ? "—" : v ? t("battery.on") : t("battery.off"));
const fmtTime = (ts) =>
  ts == null
    ? "—"
    : new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// charging_status (scen_info string) → friendly label, per the community
// SolarbankStatus enum (2026-09-27, user request). The raw code stays as a
// muted suffix — friendly without losing the technical value.
function chargingStatusLabel(t, v) {
  if (v == null) return "—";
  const code = String(v);
  const KEY = {
    "0": "detection",
    "03": "protectionCharge",
    "1": "bypass",
    "12": "bypassDischarge",
    "2": "discharge",
    "3": "charge",
    "31": "chargeBypass",
    "32": "chargeAc",
    "37": "chargePriority",
    "4": "wakeup",
    "116": "coldWakeup",
    "5": "fullyCharged",
    "6": "fullBypass",
    "7": "standby",
  }[code];
  if (!KEY) return code;
  return (
    <>
      {t(`battery.chargingStatus.${KEY}`)}
      <span className="muted"> · {code}</span>
    </>
  );
}

function ParamRow({ k, v }) {
  return (
    <div className="param-row">
      <span className="param-k">{k}</span>
      <span className="param-v">{v}</span>
    </div>
  );
}

/* One expressive state badge instead of the old chevron stack + in-text
   glyphs (2026-09-28, user request): MDI battery-charging / battery-arrow-
   down / power-standby icons (StateIcon), tinted per state, gently pulsing
   while energy actually flows. */
export function StatusBadge({ mode }) {
  return (
    <span className={`batt-state-icon ${mode}`}>
      <StateIcon mode={mode} />
    </span>
  );
}

// One battery: animated SOC gauge (with the configured min/max markers right
// on it) + every battery parameter. Split out of BatteryTab (2026-09-21,
// user request) so a second physical battery is a data change, not a
// redesign: BatteryTab maps over an array and stacks cards vertically (see
// its own comment for why vertical, not side-by-side). Since 2026-09-24 a
// real second battery exists (Solarbank 4, live-only payload) — this card
// tolerates null config/features/constants for it.
//
// Own/muted next to the state text, never color alone (2026-09-21,
// applying that same research): the near-full/low SOC zones already had
// distinct gauge colors, but nothing NAMED the zone — you had to read the
// number and know the thresholds yourself. `zoneLabel` below adds that.
function BatteryCard({ live, config, features, constants, dischargeTolerancePct, onRefresh, aggregate = false, member = false, heightPx = null, slotHeightPx = null }) {
  const t = useT();

  if (!live) return <p className="muted">{t("battery.noData")}</p>;

  const soc = live.soc ?? 0;
  // 2026-09-17: near-full gets its own color (user request) — distinct from
  // "just healthy" (lvl-high) so a topped-up battery reads at a glance.
  const lvlClass = soc > 90 ? "lvl-full" : soc > 50 ? "lvl-high" : soc >= 20 ? "lvl-mid" : "lvl-low";
  const zoneLabel =
    lvlClass === "lvl-full" ? t("battery.zone.full") : lvlClass === "lvl-low" ? t("battery.zone.low") : null;
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
  const usableKwh =
    minPct != null && maxPct != null && constants?.capacityKwh != null
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
          <span className="batt-card-name">{live.name ?? t("battery.fallbackName")}</span>
          {/* The aggregate is the SYSTEM, not one device — its pn/SN are the
              primary unit's and would mislead on the system card. */}
          {live.pn && !aggregate && <span className="batt-card-sn">{live.pn}</span>}
          {live.expansionPacks > 0 && (
            <span
              className="badge ok"
              title={t("battery.expansionTip", {
                n: live.expansionPacks,
                kwh: constants?.expansionPackKwh ?? "?",
              })}
            >
              {t("battery.expansionBadge", { n: live.expansionPacks })}
            </span>
          )}
          {live.sn && !aggregate && <span className="batt-card-sn">{live.sn}</span>}
        </div>
        {/* Vertical segmented view for EVERY unit (2026-09-27, user
            request: "get rid of the horizontal views... remove the
            horizontal code for good") — carries the hero SOC + kWh +
            limits itself; single-module units get one full-height segment
            (BatteryModules handles it). */}
        <BatteryModules
          live={live}
          constants={constants}
          limits={{ minPct, floorPct: effectiveFloorPct, maxPct }}
          heroLvlClass={lvlClass}
          heroZoneLabel={zoneLabel}
          single={aggregate}
          mode={mode}
          heightPx={heightPx}
          slotHeightPx={slotHeightPx}
        />
        <div className={`batt-status ${mode}`}>
          <StatusBadge mode={mode} />
          {mode === "charging" && (
            <>
              <span className="batt-status-main">{t("battery.status.charging", { w: fmtW(chargeW) })}</span>
              {etaLabel && <span className="batt-status-eta">{t("battery.status.fullIn", { eta: etaLabel })}</span>}
            </>
          )}
          {mode === "discharging" && (
            <>
              <span className="batt-status-main">{t("battery.status.discharging", { w: fmtW(cellsW) })}</span>
              {etaLabel && <span className="batt-status-eta">{t("battery.status.emptyIn", { eta: etaLabel })}</span>}
            </>
          )}
          {mode === "idle" && <span className="batt-status-main">{t("battery.status.idle")}</span>}
          {usableKwh != null && (
            <span className="batt-status-sub">{t("battery.status.usableWindow", { kwh: usableKwh })}</span>
          )}
        </div>
        {/* Coverage at the 7-day-average home consumption (2026-09-29, user
            request) — distinct from the ETA's CURRENT-rate estimate. */}
        {live.coverH != null && (
          <div className="batt-cover muted">{t("battery.coverAvg", { eta: formatEta(live.coverH) })}</div>
        )}
        {config?.dischargeLowerLimitPct != null && config.dischargeLowerLimitPct <= 5 && (
          // Factory-floor warning (2026-09-27): the E1600 Pro arrived with
          // the 5% factory cutoff (the user's 8% died with the old Plus) and
          // the battery drained into Anker's low-battery deep sleep
          // overnight — exactly what this hint exists to catch next time.
          <p className="callout-warn batt-floor-warn">
            <span className="callout-icon">⚠</span>
            {t("battery.lowFloorWarn")}
          </p>
        )}
        {/* Per-unit update stamp, bottom-right like the system tile's
            (2026-09-28, user request: "timestamps on the bottom right on
            each tile"). */}
        <div className="batt-sys-ts">{t("battery.system.updated", { time: fmtTime(live.ts) })}</div>
      </div>

      <BatteryDetails
        live={live}
        config={config}
        features={features}
        constants={constants}
        member={member}
        onRefresh={onRefresh}
      />
    </div>
  );
}

// The collapsible "Battery information" detail (config card, status card,
// one card per expansion pack) — used by BatteryCard (per-unit). Briefly
// shared with the aggregate's system tile until 2026-09-28, when the user
// asked for the tile to be summary-only (no toggle).
function BatteryDetails({ live, config, features, constants, member = false, onRefresh }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const forceRefresh = () => {
    setRefreshing(true);
    onRefresh().finally(() => setRefreshing(false));
  };

  const usableWindowKwh =
    config?.dischargeLowerLimitPct != null &&
    config?.chargeUpperLimitPct != null &&
    constants?.capacityKwh != null
      ? Math.round(
          (((config.chargeUpperLimitPct - config.dischargeLowerLimitPct) / 100) * constants.capacityKwh) * 100,
        ) / 100
      : null;

  return (
    <>
      {/* Collapsible per-unit details (2026-09-28, user request): capacity
          breakdown for EVERY unit, plus the config card only where the
          account limits are actually known (the primary unit). */}
      <button className="details-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {t("battery.infoToggle")} <span className="chevron">{open ? "▾" : "▸"}</span>
      </button>
      {member && (
        <p className="muted" style={{ marginTop: 4 }}>
          {t("battery.memberNote")}
        </p>
      )}
      {open && (
        <div className="param-cards">
          <div className="card">
            <div className="card-label">{t("battery.details.capacityTitle")}</div>
            <ParamRow k={t("battery.details.totalCap")} v={fmtKwh(constants?.capacityKwh)} />
            {(constants?.expansionPacks ?? 0) > 0 && (
              <ParamRow k={t("battery.modules.mainUnit")} v={fmtKwh(constants?.baseCapacityKwh)} />
            )}
            {Array.from({ length: constants?.expansionPacks ?? 0 }, (_, i) => (
              <ParamRow
                key={`cap-exp${i}`}
                k={t("battery.modules.expansion", { n: i + 1 })}
                v={fmtKwh(constants?.expansionPackKwh)}
              />
            ))}
            {usableWindowKwh != null && (
              <ParamRow
                k={t("battery.system.window", {
                  min: config.dischargeLowerLimitPct,
                  max: config.chargeUpperLimitPct,
                })}
                v={fmtKwh(usableWindowKwh)}
              />
            )}
            <ParamRow k={t("battery.details.maxAc")} v={fmtW(constants?.maxAcOutputW)} />
            <ParamRow k={t("battery.details.maxPv")} v={fmtW(constants?.maxPvInputW)} />
          </div>

          {(config != null || features != null) && (
          <div className="card">
            <div className="card-label">
              {t("battery.config.title")}
              <button
                className={`wx-refresh${refreshing ? " spinning" : ""}`}
                disabled={refreshing}
                title={t("battery.config.refreshTip")}
                onClick={forceRefresh}
              >
                ↻
              </button>
            </div>
            <ParamRow k={t("battery.config.chargeUpperLimit")} v={fmtPct(config?.chargeUpperLimitPct)} />
            <ParamRow k={t("battery.config.dischargeLowerLimit")} v={fmtPct(config?.dischargeLowerLimitPct)} />
            <ParamRow
              k={t("battery.config.backupReserve")}
              v={
                config?.backupReservePct != null
                  ? `${config.backupReservePct} % · ${onOff(t, config.backupReserveSwitch)}`
                  : "—"
              }
            />
            <ParamRow
              k={t("battery.config.limitsSource")}
              v={
                <span
                  className={`badge ${["power_cutoff", "account"].includes(config?.limitsSource) ? "ok" : "warn"}`}
                >
                  {config?.limitsSource ?? t("battery.config.limitsSourceUnknown")}
                </span>
              }
            />
            <ParamRow k={t("battery.config.zeroExport")} v={onOff(t, features?.zeroExport)} />
            <ParamRow k={t("battery.config.socCalibration")} v={onOff(t, config?.socCalibrationEnable)} />
            <ParamRow
              k={t("battery.config.fetched")}
              v={`${fmtTime(config?.fetchedAt)}${config?.source ? ` · ${config.source}` : ""}`}
            />
            {config?.station && (
              <div className="param-raw">station: {JSON.stringify(config.station)}</div>
            )}
            <div className="muted" style={{ fontSize: "0.75rem", marginTop: 6 }}>
              {t("battery.info.configAppliesNote")}
            </div>
          </div>
          )}

          <div className="card">
            <div className="card-label">
              {t("battery.statusCard.title")} · {t("battery.info.controllerTag")}
            </div>
            <ParamRow k={t("battery.statusCard.temperature")} v={fmtTemp(live.temperatureC)} />
            <ParamRow k={t("battery.statusCard.chargingStatus")} v={chargingStatusLabel(t, live.chargingStatus)} />
            <ParamRow k={t("battery.statusCard.errorCode")} v={live.errCode ?? "—"} />
            <ParamRow k={t("battery.statusCard.heatingPower")} v={fmtW(live.heatingPower)} />
            <ParamRow
              k={live.pv3W != null || live.pv4W != null ? "PV1 / PV2 / PV3 / PV4" : "PV1 / PV2"}
              v={
                live.pv3W != null || live.pv4W != null
                  ? `${fmtW(live.pv1W)} / ${fmtW(live.pv2W)} / ${fmtW(live.pv3W)} / ${fmtW(live.pv4W)}`
                  : `${fmtW(live.pv1W)} / ${fmtW(live.pv2W)}`
              }
            />
            <ParamRow k={t("battery.statusCard.gridToBattery")} v={fmtW(live.gridToBatteryW)} />
            <ParamRow k={t("battery.statusCard.pvToGrid")} v={fmtW(live.pvToGridW)} />
            <ParamRow k={t("battery.statusCard.homeLoad")} v={fmtW(live.homeLoadW)} />
          </div>

          {/* One card per expansion pack (2026-09-27, user request: it was
              ambiguous whether the info above describes the main unit or
              the extension — now each expansion has its own subsection). */}
          {Array.from({ length: constants?.expansionPacks ?? 0 }, (_, i) => {
            const exp = live.expansions?.[i] ?? null;
            return (
              <div className="card" key={`exp${i}`}>
                <div className="card-label">{t("battery.modules.expansion", { n: i + 1 })}</div>
                <ParamRow k={t("battery.info.soc")} v={fmtPct(exp?.soc)} />
                <ParamRow k="SOH" v={fmtPct(exp?.soh)} />
                <ParamRow k={t("battery.statusCard.temperature")} v={fmtTemp(exp?.temperatureC)} />
                <ParamRow k={t("battery.info.status")} v={exp?.status ?? "—"} />
                <ParamRow k={t("battery.info.sn")} v={exp?.sn ?? "—"} />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// The AGGREGATE "Battery system" tile (2026-09-28, user request): NOT
// another battery-shaped gauge — a horizontal summary of the whole system:
// capacity-weighted SOC, the configured min/max SOC, four capacity figures
// (usable-to-floor now / stored incl. reserve / usable window floor→ceiling
// / total), the total discharge rate with the ETA to the floor, and the
// last-update time bottom-right. Deliberately NO "Battery information"
// toggle here (same request, follow-up) — per-unit details live on the
// unit cards.
function BatterySystemTile({ live, config, features, constants, dischargeTolerancePct }) {
  const t = useT();
  if (!live) return <p className="muted">{t("battery.noData")}</p>;

  const soc = live.soc ?? 0; // already capacity-weighted server-side
  const cap = constants?.capacityKwh ?? null;
  const minPct = config?.dischargeLowerLimitPct ?? null;
  const maxPct = config?.chargeUpperLimitPct ?? null;
  const effFloorPct =
    minPct != null && dischargeTolerancePct != null ? minPct + dischargeTolerancePct : minPct;
  const lvlClass = soc > 90 ? "lvl-full" : soc > 50 ? "lvl-high" : soc >= 20 ? "lvl-mid" : "lvl-low";
  const zoneLabel =
    lvlClass === "lvl-full" ? t("battery.zone.full") : lvlClass === "lvl-low" ? t("battery.zone.low") : null;

  const r2 = (v) => Math.round(v * 100) / 100;
  const storedKwh = cap != null ? r2((soc / 100) * cap) : null; // incl. reserve
  const usableNowKwh =
    cap != null && effFloorPct != null ? r2(Math.max(0, ((soc - effFloorPct) / 100) * cap)) : null;
  const windowKwh =
    cap != null && minPct != null && maxPct != null ? r2(((maxPct - minPct) / 100) * cap) : null;

  const chargeW = live.chargeW ?? 0;
  const cellsW = live.cellsW ?? 0;
  const mode = chargeW > cellsW ? "charging" : cellsW > chargeW ? "discharging" : "idle";
  const etaLabel = formatEta(
    batteryEtaHours({
      mode,
      soc,
      chargeW,
      cellsW,
      maxPct,
      floorPct: effFloorPct ?? minPct,
      capacityKwh: cap,
    }),
  );

  return (
    <div className="card batt-sys">
      <div className="batt-sys-main">
        <div className="batt-sys-hero">
          <span className="batt-sys-name">{live.name ?? t("battery.fallbackName")}</span>
          <span className={`batt-sys-pct ${lvlClass}`}>
            {soc}&nbsp;%{zoneLabel && <span className="batt-sys-zone">{zoneLabel}</span>}
          </span>
          <span className="batt-sys-stored">
            {storedKwh != null && cap != null ? `${storedKwh} / ${cap} kWh` : "—"}
          </span>
        </div>
        <div className="batt-sys-body">
          {/* 0–100 % bar: dim reserve below the min SOC, the live fill to
              the current SOC, tick markers at min / effective floor / max. */}
          <div className="batt-sys-bar" role="img" aria-label={`SOC ${soc} %`}>
            {minPct != null && (
              <div className="batt-sys-reserve" style={{ width: `${minPct}%` }} />
            )}
            <div className={`batt-sys-fill ${lvlClass}`} style={{ width: `${soc}%` }} />
            {[
              { pct: minPct, cls: "min" },
              { pct: effFloorPct !== minPct ? effFloorPct : null, cls: "floor" },
              { pct: maxPct, cls: "max" },
            ]
              .filter((tk) => tk.pct != null)
              .map((tk) => (
                <div key={tk.cls} className={`batt-sys-tick ${tk.cls}`} style={{ left: `${tk.pct}%` }} />
              ))}
          </div>
          <div className="batt-sys-bar-labels">
            {/* "0" collides with the min label when min ≤ 10 % — skip it. */}
            {(minPct == null || minPct > 10) && <span>0</span>}
            {minPct != null && <span style={{ left: `${minPct}%` }}>{t("battery.system.minShort", { pct: minPct })}</span>}
            {maxPct != null && (
              <span
                style={{
                  left: `${maxPct}%`,
                  // Near the right edge, end-align the label at the tick
                  // instead of centering — centered would overflow/wrap.
                  transform: maxPct >= 90 ? "translateX(-100%)" : undefined,
                }}
              >
                {t("battery.system.maxShort", { pct: maxPct })}
              </span>
            )}
            {/* "100" collides with the max label when max ≥ 90 % — skip it. */}
            {(maxPct == null || maxPct < 90) && <span>100</span>}
          </div>
          <div className="batt-sys-metrics">
            <div>
              <span>{t("battery.system.usableNow", { pct: effFloorPct ?? minPct ?? "—" })}</span>
              <b>{usableNowKwh != null ? `${usableNowKwh} kWh` : "—"}</b>
            </div>
            <div>
              <span>{t("battery.system.availableNow")}</span>
              <b>{storedKwh != null ? `${storedKwh} kWh` : "—"}</b>
            </div>
            <div>
              <span>{t("battery.system.window", { min: minPct ?? "—", max: maxPct ?? "—" })}</span>
              <b>{windowKwh != null ? `${windowKwh} kWh` : "—"}</b>
            </div>
            <div>
              <span>{t("battery.system.totalCap")}</span>
              <b>{cap != null ? `${cap} kWh` : "—"}</b>
            </div>
          </div>
          <div className={`batt-sys-status ${mode}`}>
            <StatusBadge mode={mode} />
            {mode === "charging" && t("battery.status.charging", { w: fmtW(chargeW) })}
            {mode === "discharging" && t("battery.status.discharging", { w: fmtW(cellsW) })}
            {mode === "idle" && t("battery.status.idle")}
            {etaLabel && (
              <span className="batt-status-eta">
                {" · "}
                {mode === "charging"
                  ? t("battery.status.fullIn", { eta: etaLabel })
                  : t("battery.status.emptyIn", { eta: etaLabel })}
              </span>
            )}
          </div>
          {/* Coverage at the 7-day-average home consumption (2026-09-29). */}
          {live.coverH != null && (
            <div className="batt-cover muted">{t("battery.coverAvg", { eta: formatEta(live.coverH) })}</div>
          )}
        </div>
      </div>
      {config?.dischargeLowerLimitPct != null && config.dischargeLowerLimitPct <= 5 && (
        // Same factory-floor warning BatteryCard shows (2026-09-27): the
        // config here is the primary unit's — the one the controller obeys.
        <p className="callout-warn batt-floor-warn">
          <span className="callout-icon">⚠</span>
          {t("battery.lowFloorWarn")}
        </p>
      )}
      {/* No "Battery information" toggle on the system tile (2026-09-28,
          user request) — the summary IS the whole point of this tile; the
          per-unit details live on the unit cards below. */}
      <div className="batt-sys-ts">{t("battery.system.updated", { time: fmtTime(live.ts) })}</div>
    </div>
  );
}


// Battery section: the aggregate renders as the horizontal BatterySystemTile
// summary (2026-09-28, user request — it was a battery-shaped gauge like the
// units before); each unit keeps its UPRIGHT segmented card, side by side
// (2026-09-27), metrics underneath; wraps on narrow screens.
export default function BatteryTab({ dischargeTolerancePct } = {}) {
  const t = useT();
  const { data, error, setData } = usePolledResource("/api/battery/params", { intervalMs: 10000 });

  // Live push (2026-09-22, user request: status as fast as the Anker app):
  // the gauge's live fields (SOC, charge/discharge watts, PV) merge straight
  // from the shared WS channel the moment the server pushes (meter 2 s,
  // battery MQTT 3-5 s) instead of waiting for the 10 s poll above — the
  // poll stays for the slow-moving parts (config/features/constants).
  const streamMsg = useLiveStream();
  useEffect(() => {
    const b = streamMsg?.flow?.battery;
    if (!b) return;
    setData((prev) => {
      if (!prev) return prev;
      const mergeLive = (entry) => {
        if (!entry?.live) return entry;
        const cap = entry.constants?.capacityKwh;
        return {
          ...entry,
          live: {
            ...entry.live,
            soc: b.soc ?? entry.live.soc,
            outputW: b.discharge ?? entry.live.outputW,
            chargeW: b.charge ?? entry.live.chargeW,
            pvW: streamMsg.flow.pv?.production ?? entry.live.pvW,
            pv1W: b.pv1W ?? entry.live.pv1W,
            pv2W: b.pv2W ?? entry.live.pv2W,
            cellsW: b.cells ?? entry.live.cellsW,
            gridToBatteryW: b.gridCharge ?? entry.live.gridToBatteryW,
            ts: b.ts ?? entry.live.ts,
            // storedKwh derives from soc — recompute against the pushed soc
            // so the gauge's "X kWh of 1.6 kWh" can't disagree with the %.
            storedKwh:
              b.soc != null && cap != null
                ? Math.round(((b.soc / 100) * cap) * 100) / 100
                : entry.live.storedKwh,
          },
        };
      };
      // The pushed flow.battery describes the site AGGREGATE — it merges
      // only into batteries[0] (the aggregate entry); the per-unit cards
      // keep their own polled values (2026-09-24: merging into every entry
      // would have shown one unit's numbers on all cards).
      if (Array.isArray(prev.batteries))
        return {
          ...prev,
          batteries: prev.batteries.map((entry, i) => (i === 0 ? mergeLive(entry) : entry)),
        };
      return mergeLive(prev);
    });
  }, [streamMsg, setData]);

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
  if (!data) return <p className="muted">{t("common.loading")}</p>;

  // ALL entries render (2026-09-27, dock era): batteries[0] is the system
  // aggregate, the rest are the site's member units (h-power carries SB4 +
  // SB2 Pro on the Power Dock). The earlier slice(0,1) ("only the h-solar
  // system") predates the dock — members ARE the house system now.
  const batteries = Array.isArray(data.batteries) ? data.batteries : [data];
  const latestTs = batteries.reduce((max, b) => Math.max(max, b.live?.ts ?? 0), 0) || null;

  // Capacity-proportional cylinder heights across the member units
  // (2026-09-30, user request — "make the battery in the second tile
  // proportionally smaller than the one in the first tile... tiles and
  // texts stay the same size and properly aligned"): same heightPx/
  // slotHeightPx mechanism as the simple view — the slot reserves the
  // tallest stack's height and bottom-aligns the cylinder inside it, so
  // cards and text rows stay identical/aligned.
  const baseH = window.matchMedia("(max-width: 600px)").matches ? 200 : 260;
  const maxCap = Math.max(...batteries.filter((b) => b.member).map((b) => b.constants?.capacityKwh ?? 0), 0) || 1;
  const heightOf = (b) =>
    Math.round(baseH * Math.max(0.55, (b.constants?.capacityKwh ?? maxCap) / maxCap));

  return (
    <div>
      <UpdatedStamp at={latestTs}>
        {batteries.length > 1
          ? t("battery.count", { n: batteries.length })
          : (batteries[0].live?.name ?? t("battery.fallbackName"))}
      </UpdatedStamp>

      <div className="battery-list">
        {batteries.map((b, i) =>
          b.aggregate ? (
            <BatterySystemTile
              key={b.live?.sn ?? i}
              live={b.live}
              config={b.config}
              features={b.features}
              constants={b.constants}
              dischargeTolerancePct={dischargeTolerancePct}
            />
          ) : (
            <BatteryCard
              key={b.live?.sn ?? i}
              live={b.live}
              config={b.config}
              features={b.features}
              constants={b.constants}
              aggregate={b.aggregate ?? false}
              member={b.member ?? false}
              // The discharge tolerance is a power-plan concept — it applies
              // only to the primary (controlled) battery, never to a
              // monitored-only secondary one.
              dischargeTolerancePct={i === 0 ? dischargeTolerancePct : null}
              heightPx={heightOf(b)}
              slotHeightPx={baseH}
              onRefresh={forceRefresh}
            />
          ),
        )}
      </div>
    </div>
  );
}
