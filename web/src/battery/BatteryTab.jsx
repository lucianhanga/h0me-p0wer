import { useEffect, useState } from "react";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { batteryEtaHours, formatEta } from "../batteryEta.js";
import { usePolledResource } from "../usePolledResource.js";
import { useLiveStream } from "../useLiveStream.js";
import { useT } from "../i18n/LanguageProvider.jsx";

// Rendered inside StrategyTab.jsx (moved out of its own top-level tab
// 2026-09-16) — the gauge stays visible, the detailed param cards below
// collapse by default (same .details-toggle pattern as PowerPlanCard.jsx).

const fmtW = (v) => (v == null ? "—" : `${Math.round(v)} W`);
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

// Upright segmented battery: one module per physical battery unit (main +
// expansion packs), stacked like the real hardware — solarbank (main unit)
// ON TOP, expansion battery(s) BELOW (user correction 2026-09-26: "the
// battery stack is first the solarbank and then the battery — this is how
// it's done in practice"); segment height ∝ capacity. Per-module SOC comes
// from MQTT only (main unit via 0405 a3, packs via 040a) — REST has no
// per-pack data. Modules show "—" until real per-module data arrives (an
// "≈ overall" estimate was tried for a day and rejected — identical fills
// looked fabricated).
function BatteryModules({ live, constants, limits = {}, heroLvlClass, heroZoneLabel }) {
  const t = useT();
  const packs = constants?.expansionPacks ?? 0;
  if (!packs) return null;
  const modules = [
    {
      key: "main",
      name: t("battery.modules.mainUnit"),
      kwh: constants.baseCapacityKwh,
      soc: live.mainSoc ?? null,
      tempC: live.temperatureC ?? null,
      soh: null,
    },
    ...Array.from({ length: packs }, (_, i) => {
      const exp = live.expansions?.[i] ?? null;
      return {
        key: `exp${i}`,
        name: t("battery.modules.expansion", { n: i + 1 }),
        kwh: constants.expansionPackKwh,
        soc: exp?.soc ?? null,
        tempC: exp?.temperatureC ?? null,
        soh: exp?.soh ?? null,
      };
    }),
  ];
  const totalKwh = modules.reduce((a, m) => a + m.kwh, 0);
  const lvlOf = (soc) =>
    soc == null ? null : soc > 90 ? "lvl-full" : soc > 50 ? "lvl-high" : soc >= 20 ? "lvl-mid" : "lvl-low";
  const anyUnknown = modules.some((m) => m.soc == null);
  return (
    <div className="batt-modules">
      <div className="batt-seg" title={t("battery.modules.tip")}>
        {modules.map((m) => (
          <div key={m.key} className="batt-seg-mod" style={{ height: `${(m.kwh / totalKwh) * 100}%` }}>
            <div className={`batt-seg-fill ${lvlOf(m.soc) ?? ""}`} style={{ height: `${m.soc ?? 0}%` }} />
            <span className="batt-seg-soc">{m.soc != null ? `${m.soc} %` : "—"}</span>
          </div>
        ))}
      </div>
      <div className="batt-modules-side">
        <div className="batt-modules-hero">
          <span className="batt-gauge-pct">
            {live.soc ?? 0} %{heroZoneLabel && <span className={`batt-gauge-zone ${heroLvlClass}`}>{heroZoneLabel}</span>}
          </span>
          <span className="batt-gauge-kwh">
            {live.storedKwh != null && constants?.capacityKwh != null
              ? t("battery.storedKwh", { stored: live.storedKwh, total: constants.capacityKwh })
              : t("battery.capacityNa")}
          </span>
          {(limits.minPct != null || limits.maxPct != null) && (
            <span className="batt-modules-limits muted">
              {limits.minPct != null && t("battery.gauge.min", { pct: limits.minPct })}
              {limits.floorPct != null &&
                limits.floorPct !== limits.minPct &&
                ` · ${t("battery.gauge.floor", { pct: limits.floorPct })}`}
              {limits.maxPct != null && ` · ${t("battery.gauge.max", { pct: limits.maxPct })}`}
            </span>
          )}
        </div>
        <div className="batt-modules-legend">
          {modules.map((m) => (
            <div key={m.key} className="batt-modules-row">
              <span className="batt-modules-name">{m.name}</span>
              <span className="batt-modules-detail">
                {m.kwh} kWh · {m.soc != null ? `${m.soc} %` : "—"}
                {m.soh != null && ` · SOH ${m.soh} %`}
                {m.tempC != null && ` · ${Math.round(m.tempC)} °C`}
              </span>
            </div>
          ))}
          {anyUnknown && (
            <div className="batt-modules-note muted">
              {t("battery.modules.mqttNote")}
            </div>
          )}
        </div>
      </div>
    </div>
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
function BatteryCard({ live, config, features, constants, dischargeTolerancePct, onRefresh }) {
  const t = useT();
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);

  const forceRefresh = () => {
    setRefreshing(true);
    onRefresh().finally(() => setRefreshing(false));
  };

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
  const showFloorTick = effectiveFloorPct != null && effectiveFloorPct !== minPct;
  const hasModules = (constants?.expansionPacks ?? 0) > 0;
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
          {live.pn && <span className="batt-card-sn">{live.pn}</span>}
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
          {live.sn && <span className="batt-card-sn">{live.sn}</span>}
        </div>
        {hasModules ? (
          // Vertical segmented view replaces the horizontal gauge entirely
          // (2026-09-26, user request: "show only the vertical, not the
          // horizontal") — it carries the overall hero SOC + kWh + limits
          // itself, so nothing is lost with the gauge.
          <BatteryModules
            live={live}
            constants={constants}
            limits={{ minPct, floorPct: effectiveFloorPct, maxPct }}
            heroLvlClass={lvlClass}
            heroZoneLabel={zoneLabel}
          />
        ) : (
          <div className="batt-gauge-wrap">
          <div className={`batt-gauge-body ${lvlClass}`}>
            <div className={`batt-gauge-fill ${lvlClass} ${mode}`} style={{ width: `${soc}%` }} />
            {minPct != null && (
              <div
                className="batt-tick"
                style={{ left: `${minPct}%` }}
                title={t("battery.gauge.minTip", { pct: minPct })}
              />
            )}
            {showFloorTick && (
              <div
                className="batt-tick batt-tick-floor"
                style={{ left: `${effectiveFloorPct}%` }}
                title={t("battery.gauge.floorTip", {
                  floor: effectiveFloorPct,
                  min: minPct,
                  margin: dischargeTolerancePct,
                })}
              />
            )}
            {maxPct != null && (
              <div
                className="batt-tick"
                style={{ left: `${maxPct}%` }}
                title={t("battery.gauge.maxTip", { pct: maxPct })}
              />
            )}
            <div className="batt-gauge-center">
              <span className="batt-gauge-pct">
                {soc} %{zoneLabel && <span className={`batt-gauge-zone ${lvlClass}`}>{zoneLabel}</span>}
              </span>
              <span className="batt-gauge-kwh">
                {live.storedKwh != null && constants?.capacityKwh != null
                  ? t("battery.storedKwh", { stored: live.storedKwh, total: constants.capacityKwh })
                  : t("battery.capacityNa")}
              </span>
            </div>
          </div>
          <div className={`batt-gauge-cap ${lvlClass}`} />
          {minPct != null && (
            <span className="batt-tick-label" style={{ left: `${minPct}%` }}>
              {t("battery.gauge.min", { pct: minPct })}
            </span>
          )}
          {showFloorTick && (
            <span className="batt-tick-label batt-tick-label-floor" style={{ left: `${effectiveFloorPct}%` }}>
              {t("battery.gauge.floor", { pct: effectiveFloorPct })}
            </span>
          )}
          {maxPct != null && (
            <span className="batt-tick-label" style={{ left: `${maxPct}%` }}>
              {t("battery.gauge.max", { pct: maxPct })}
            </span>
          )}
          </div>
        )}
        <div className={`batt-status ${mode}`}>
          {mode === "charging" && (
            <>
              <span className="batt-chevs">
                <span>▲</span>
                <span>▲</span>
                <span>▲</span>
              </span>
              <span className="batt-status-main">{t("battery.status.charging", { w: fmtW(chargeW) })}</span>
              {etaLabel && <span className="batt-status-eta">{t("battery.status.fullIn", { eta: etaLabel })}</span>}
            </>
          )}
          {mode === "discharging" && (
            <>
              <span className="batt-chevs">
                <span>▼</span>
                <span>▼</span>
                <span>▼</span>
              </span>
              <span className="batt-status-main">{t("battery.status.discharging", { w: fmtW(cellsW) })}</span>
              {etaLabel && <span className="batt-status-eta">{t("battery.status.emptyIn", { eta: etaLabel })}</span>}
            </>
          )}
          {mode === "idle" && <span className="batt-status-main">{t("battery.status.idle")}</span>}
          {usableKwh != null && (
            <span className="batt-status-sub">{t("battery.status.usableWindow", { kwh: usableKwh })}</span>
          )}
        </div>
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
      </div>

      {config == null && features == null ? (
        // Secondary battery (e.g. the Solarbank 4, 2026-09-24): monitored
        // live-only — its config endpoints aren't verified for this hardware,
        // so there is no Configuration/Status detail to expand.
        <p className="muted" style={{ marginTop: 8 }}>
          {t("battery.liveOnlyNote")}
        </p>
      ) : (
        <>
          <button className="details-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {t("battery.infoToggle")} <span className="chevron">{open ? "▾" : "▸"}</span>
          </button>
          {open && (
        <div className="param-cards">
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
// The endpoint (GET /api/battery/params) returns a `batteries` array:
// batteries[0] is the primary (house-system) battery with full
// {live, config, features, constants}; batteries[1] (since 2026-09-24) is
// the Solarbank 4 on the separate "h-power" site — live-only payload with
// null config/features/constants, which BatteryCard handles by hiding the
// details section (see its own comment). Single-battery deployments just
// get a one-item array; the fallback to treating the bare payload as one
// item stays for older servers.
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
      // The pushed flow.battery describes the PRIMARY battery only (2026-09-24:
      // merging it into every entry would have shown the SB2's live numbers
      // on the Solarbank 4's card too).
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

  // Only the PRIMARY system's batteries are shown here (2026-09-26, user
  // request: "show only the batteries in the h-solar system") — batteries[0]
  // is the house system by construction; batteries[1+] (the Solarbank 4 on
  // the h-power site) stay tracked in the backend/API but are not rendered
  // on this tab — they belong to the future multi-system view (epic #218).
  const all = Array.isArray(data.batteries) ? data.batteries : [data];
  const batteries = all.slice(0, 1);
  const latestTs = batteries.reduce((max, b) => Math.max(max, b.live?.ts ?? 0), 0) || null;

  return (
    <div>
      <UpdatedStamp at={latestTs}>
        {batteries.length > 1
          ? t("battery.count", { n: batteries.length })
          : (batteries[0].live?.name ?? t("battery.fallbackName"))}
      </UpdatedStamp>

      <div className="battery-list">
        {batteries.map((b, i) => (
          <BatteryCard
            key={b.live?.sn ?? i}
            live={b.live}
            config={b.config}
            features={b.features}
            constants={b.constants}
            // The discharge tolerance is a power-plan concept — it applies
            // only to the primary (controlled) battery, never to a
            // monitored-only secondary one.
            dischargeTolerancePct={i === 0 ? dischargeTolerancePct : null}
            onRefresh={forceRefresh}
          />
        ))}
      </div>
    </div>
  );
}
