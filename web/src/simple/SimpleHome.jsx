import { useEffect, useState } from "react";
import FlowView from "../flow/FlowView.jsx";
import BatteryModules from "../battery/BatteryModules.jsx";
import { StatusBadge } from "../battery/BatteryTab.jsx";
import { batteryEtaHours, formatEta } from "../batteryEta.js";
import { TEMP_COLD_MAX_C, TEMP_HOT_MIN_C } from "../tempLimits.js";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { usePolledResource } from "../usePolledResource.js";
import { useLiveStream } from "../useLiveStream.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import SimpleCharts from "./SimpleCharts.jsx";
import SectionTitle from "../components/SectionTitle.jsx";
import { SourceCard } from "../dashboard/Dashboard.jsx";

// The simple view (2026-09-27, user request — "minimalistic, think Tesla
// way"): ONE calm screen — the animated flow diagram as the hero, the
// battery stack underneath, nothing else. No cards, no label grids, no
// decision panels; the important values live ON the visuals themselves.
// Same data as the full Live tab (/api/flow + /api/battery/params, WS
// pushes merged for instant updates).

// Temperature chip for each battery module (2026-10-01, user request):
// color = progressive cold→hot scale (deep blue ≤ −10 °C → dark red
// ≥ +40 °C); ⚠ with an explanatory tooltip at the shared comfort bounds
// (tempLimits.js — cold: charging may be limited; hot: lifetime risk).
function TempChip({ label, tempC }) {
  const t = useT();
  if (tempC == null) return null;
  const warn = tempC <= TEMP_COLD_MAX_C ? "cold" : tempC >= TEMP_HOT_MIN_C ? "hot" : null;
  const hue = Math.round(Math.min(220, Math.max(0, 220 - ((tempC + 10) / 50) * 220)));
  return (
    <span className="batt-temp" title={warn ? t(`battery.tempWarn.${warn}`) : undefined}>
      <span className="batt-temp-dot" style={{ background: `hsl(${hue} 85% 55%)` }} />
      {label && <span className="batt-temp-label">{label} </span>}
      {Math.round(tempC)} °C
      {warn && <span className="batt-temp-warn"> ⚠</span>}
    </span>
  );
}

export default function SimpleHome() {
  const t = useT();
  const { data: flowRest } = usePolledResource("/api/flow", { intervalMs: 10000 });
  const { data: params, setData: setParams } = usePolledResource("/api/battery/params", { intervalMs: 10000 });
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
    // Unconditional overwrite (2026-09-29 review: `prev ?? flowRest` never
    // fired after the first WS push, so the REST "safety net" netted
    // nothing — a stalled socket froze the view on the last pushed values
    // forever). Same overwrite-the-world contract as LiveTab's poll.
    if (flowRest) setFlow(flowRest);
  }, [flowRest]);

  // Per-unit WS merge (2026-10-02, user request: simple view at the same
  // speed as the extended view): the battery stacks move at push cadence
  // (~1-5 s) like the Strategy tab's cards, not just at the 10 s params
  // poll — which stays for the slow fields (config, coverH, limits).
  useEffect(() => {
    const pushed = streamMsg?.flow?.battery?.members;
    if (!Array.isArray(pushed) || !pushed.length) return;
    setParams((prev) => {
      if (!prev) return prev;
      const mergeUnit = (entry) => {
        if (!entry?.live?.sn) return entry;
        const p = pushed.find((x) => x.sn === entry.live.sn);
        if (!p) return entry;
        const cap = entry.constants?.capacityKwh;
        return {
          ...entry,
          live: {
            ...entry.live,
            soc: p.soc ?? entry.live.soc,
            chargeW: p.chargeW ?? entry.live.chargeW,
            cellsW: p.cellsW ?? entry.live.cellsW,
            outputW: p.outputW ?? entry.live.outputW,
            temperatureC: p.temperatureC ?? entry.live.temperatureC,
            mainSoc: p.mainSoc ?? entry.live.mainSoc,
            expansions: p.expansions ?? entry.live.expansions,
            ts: p.ts ?? entry.live.ts,
            // storedKwh derives from soc — recompute against the pushed soc
            // so "X kWh of Y kWh" can't disagree with the %.
            storedKwh:
              p.soc != null && cap != null
                ? Math.round(((p.soc / 100) * cap) * 100) / 100
                : entry.live.storedKwh,
          },
        };
      };
      return Array.isArray(prev.batteries)
        ? { ...prev, batteries: prev.batteries.map(mergeUnit) }
        : mergeUnit(prev);
    });
  }, [streamMsg]);

  const primary = params?.batteries?.[0] ?? params;
  // Both batteries as parallel vertical stacks (2026-09-28, user request):
  // one column per UNIT (solarbank + its extensions as segments), texts
  // underneath. Falls back to the aggregate for single-battery setups.
  const units = (params?.batteries ?? []).filter((b) => b.member && b.live);
  const stacks = units.length ? units : primary?.live ? [primary] : [];
  // Members carry no config — the ETA targets the SYSTEM's charge ceiling /
  // discharge floor. Prefer the flow payload's EFFECTIVE floor (account
  // floor + controller margin, computed server-side) — the bare account
  // floor here was a third, drifting basis (2026-09-29 review).
  const sysMin = flow?.battery?.floorPct ?? primary?.config?.dischargeLowerLimitPct ?? null;
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
      <SectionTitle>{t("live.powerFlow")}</SectionTitle>
      <div className="simple-flow">
        <FlowView flow={flow} />
      </div>
      {stacks.length > 0 && (
        <>
          <SectionTitle>{t("simple.batteries")}</SectionTitle>
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
            const uEta =
              // Discharge shows NO separate ETA (2026-09-30 — the coverage
              // line below already carries the stable 7-day-average figure);
              // charging keeps the current-rate estimate.
              uMode === "discharging"
                ? null
                : formatEta(
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
                    {t("battery.coverAvg", {
                      eta: formatEta(u.live.coverH),
                      avg: params?.avgUseKwhPerDay != null ? Math.round(params.avgUseKwhPerDay * 10) / 10 : "?",
                    })}
                  </div>
                )}
                {/* Per-module temperatures (2026-10-01, user request):
                    solarbank + each expansion pack, cold→hot colored, ⚠ at
                    the cold/hot bounds with an explanatory tooltip. */}
                <div className="batt-temps">
                  <TempChip label={t("battery.modules.mainUnit")} tempC={u.live?.temperatureC} />
                  {(u.live?.expansions ?? []).map((e, i) => (
                    <TempChip
                      key={e.sn ?? i}
                      label={t("battery.modules.expansion", { n: i + 1 })}
                      tempC={e.temperatureC}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}
      <SectionTitle>{t("simple.charts")}</SectionTitle>
      <SimpleCharts />
      {overview?.byPeriod?.today && (
        <>
          <SectionTitle>{t("simple.periods")}</SectionTitle>
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
        </>
      )}
      <UpdatedStamp at={flow?.ts ?? primary?.live?.ts ?? null} />
    </div>
  );
}
