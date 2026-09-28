import { useEffect, useState } from "react";
import FlowDiagram from "../FlowDiagram.jsx";
import BatteryModules from "../battery/BatteryModules.jsx";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { usePolledResource } from "../usePolledResource.js";
import { useLiveStream } from "../useLiveStream.js";
import { useT } from "../i18n/LanguageProvider.jsx";

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

  return (
    <div className="simple-home">
      <div className="simple-flow">
        <FlowDiagram flow={flow} />
      </div>
      {stacks.length > 0 && (
        <div className="simple-batt-row">
          {stacks.map((u) => {
            const uSoc = u.live?.soc ?? null;
            const uLvl =
              uSoc == null ? null : uSoc > 90 ? "lvl-full" : uSoc > 50 ? "lvl-high" : uSoc >= 20 ? "lvl-mid" : "lvl-low";
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
                  stacked
                />
              </div>
            );
          })}
        </div>
      )}
      <UpdatedStamp at={flow?.ts ?? primary?.live?.ts ?? null} />
    </div>
  );
}
