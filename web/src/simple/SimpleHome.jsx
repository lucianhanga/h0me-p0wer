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
  const live = primary?.live ?? null;
  const soc = live?.soc ?? null;
  const lvlClass =
    soc == null ? null : soc > 90 ? "lvl-full" : soc > 50 ? "lvl-high" : soc >= 20 ? "lvl-mid" : "lvl-low";
  const zoneLabel =
    lvlClass === "lvl-full" ? t("battery.zone.full") : lvlClass === "lvl-low" ? t("battery.zone.low") : null;

  return (
    <div className="simple-home">
      <div className="simple-flow">
        <FlowDiagram flow={flow} />
      </div>
      {live && (
        <div className="simple-batt">
          <BatteryModules
            live={live}
            constants={primary?.constants}
            limits={{
              minPct: primary?.config?.dischargeLowerLimitPct,
              maxPct: primary?.config?.chargeUpperLimitPct,
            }}
            heroLvlClass={lvlClass}
            heroZoneLabel={zoneLabel}
          />
        </div>
      )}
      <UpdatedStamp at={flow?.ts ?? live?.ts ?? null} />
    </div>
  );
}
