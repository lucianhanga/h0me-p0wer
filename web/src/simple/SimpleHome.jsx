import { useEffect, useState } from "react";
import FlowView from "../flow/FlowView.jsx";
import BatteryModules from "../battery/BatteryModules.jsx";
import { StatusBadge } from "../battery/BatteryTab.jsx";
import { batteryEtaHours, formatEta } from "../batteryEta.js";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { usePolledResource } from "../usePolledResource.js";
import { useLiveStream } from "../useLiveStream.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import SimpleCharts from "./SimpleCharts.jsx";
import { SourceCard } from "../dashboard/Dashboard.jsx";

// The simple view (2026-09-27, user request — "minimalistic, think Tesla
// way"): ONE calm screen — the animated flow diagram as the hero, the
// battery stack underneath, nothing else. No cards, no label grids, no
// decision panels; the important values live ON the visuals themselves.
// Same data as the full Live tab (/api/flow + /api/battery/params, WS
// pushes merged for instant updates).
export default function SimpleHome() {
  const t = useT();
  const { data: flowRest } = usePolledResource("/api/flow", { intervalMs: 10000 });
  const { data: params } = usePolledResource("/api/battery/params", { intervalMs: 30000 });
  // The Today dashboard tile at the end of the simple view (2026-09-28,
  // user request — "but just for today", flipping included).
  const { data: overview } = usePolledResource("/api/stats/overview", { intervalMs: 60000 });
  const [flow, setFlow] = useState(null);

  // WS push is the fast channel; the REST poll is the safety net/first paint.
  const streamMsg = useLiveStream();
  useEffect(() => {
    if (streamMsg?.type === "live" && streamMsg.flow) setFlow(streamMsg.flow);
  }, [streamMsg]);
  useEffect(() => {
    if (flowRest) setFlow((prev) => prev ?? flowRest);
  }, [flowRest]);

  const primary = params?.batteries?.[0] ?? params;
  // Both batteries as parallel vertical stacks (2026-09-28, user request):
  // one column per UNIT (solarbank + its extensions as segments), texts
  // underneath. Falls back to the aggregate for single-battery setups.
  const units = (params?.batteries ?? []).filter((b) => b.member && b.live);
  const stacks = units.length ? units : primary?.live ? [primary] : [];
  // Members carry no config — the ETA targets the SYSTEM's charge ceiling /
  // discharge floor (the aggregate's config = the primary unit's account
  // limits, the same values the controller obeys).
  const sysMin = primary?.config?.dischargeLowerLimitPct ?? null;
  const sysMax = primary?.config?.chargeUpperLimitPct ?? null;
  // Cylinder height ∝ the unit's total capacity (2026-09-28, user request:
  // "display the batteries with different sizes near each other... so the
  // proportions are observed" — the Pro's main unit is only 1.6 kWh). A
  // floor keeps a small unit's cylinder readable (55% of the largest).
  const baseH = window.matchMedia("(max-width: 600px)").matches ? 230 : 300;
  const maxCap = Math.max(...stacks.map((u) => u.constants?.capacityKwh ?? 0), 0) || 1;
  const heightOf = (u) =>
    Math.round(baseH * Math.max(0.55, (u.constants?.capacityKwh ?? maxCap) / maxCap));

  return (
    <div className="simple-home">
      <div className="simple-flow">
        <FlowView flow={flow} />
      </div>
      {stacks.length > 0 && (
        <div className="simple-batt-row">
          {stacks.map((u) => {
            const uSoc = u.live?.soc ?? null;
            const uLvl =
              uSoc == null ? null : uSoc > 90 ? "lvl-full" : uSoc > 50 ? "lvl-high" : uSoc >= 20 ? "lvl-mid" : "lvl-low";
            // Same dominant-direction rule as the Strategy cards.
            const uChargeW = u.live?.chargeW ?? 0;
            const uCellsW = u.live?.cellsW ?? 0;
            const uMode = uChargeW > uCellsW ? "charging" : uCellsW > uChargeW ? "discharging" : "idle";
            const uW = uMode === "charging" ? uChargeW : uCellsW;
            const uEta = formatEta(
              batteryEtaHours({
                mode: uMode,
                soc: uSoc,
                chargeW: uChargeW,
                cellsW: uCellsW,
                maxPct: sysMax,
                floorPct: sysMin,
                capacityKwh: u.constants?.capacityKwh,
              }),
            );
            return (
              <div className="simple-batt" key={u.live.sn ?? "aggregate"}>
                <BatteryModules
                  live={u.live}
                  constants={u.constants}
                  limits={
                    u.member
                      ? {}
                      : {
                          minPct: u.config?.dischargeLowerLimitPct,
                          maxPct: u.config?.chargeUpperLimitPct,
                        }
                  }
                  heroLvlClass={uLvl}
                  heroZoneLabel={
                    uLvl === "lvl-full"
                      ? t("battery.zone.full")
                      : uLvl === "lvl-low"
                        ? t("battery.zone.low")
                        : null
                  }
                  mode={uMode}
                  stacked
                  legend={false}
                  heightPx={heightOf(u)}
                  slotHeightPx={baseH}
                />
                {/* State + ETA until full/empty, same as the Strategy cards
                    (2026-09-28, user request) — replaces the per-module legend
                    here (removed per the same request). */}
                <div className={`batt-status simple-batt-status ${uMode}`}>
                  <StatusBadge mode={uMode} />
                  <span className="batt-status-main">
                    {uMode === "idle"
                      ? t("battery.status.idle")
                      : t(`battery.status.${uMode}`, { w: `${Math.round(uW)} W` })}
                  </span>
                  {uEta && (
                    <span className="batt-status-eta">
                      {t(uMode === "charging" ? "battery.status.fullIn" : "battery.status.emptyIn", {
                        eta: uEta,
                      })}
                    </span>
                  )}
                </div>
                {/* Coverage at the 7-day-average home consumption
                    (2026-09-29, user request) — distinct from the ETA above
                    (which uses the CURRENT charge/discharge rate). */}
                {u.live?.coverH != null && (
                  <div className="batt-cover muted">
                    {t("battery.coverAvg", { eta: formatEta(u.live.coverH) })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <SimpleCharts />
      {overview?.byPeriod?.today && (
        <div className="simple-periods">
          {/* Today + Week + Month (2026-09-29, user request — "under the
              today tile add also the week and month tiles") — the real
              Dashboard cards, flip + ‹ › period nav included. */}
          <SourceCard
            type="day"
            title={t("dashboard.today")}
            data={overview.byPeriod.today}
            formatLabel={(l) => new Date(l).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          />
          <SourceCard
            type="week"
            title={t("dashboard.thisWeek")}
            data={overview.byPeriod.week}
            formatLabel={(l) => new Date(`${l}T12:00:00`).toLocaleDateString([], { weekday: "short" })}
          />
          <SourceCard
            type="month"
            title={t("dashboard.thisMonth")}
            data={overview.byPeriod.month}
            formatLabel={(l) => (typeof l === "string" ? l.slice(8) : l)}
          />
        </div>
      )}
      <UpdatedStamp at={flow?.ts ?? primary?.live?.ts ?? null} />
    </div>
  );
}
