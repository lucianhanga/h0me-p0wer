import { useMemo } from "react";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import SectionTitle from "../components/SectionTitle.jsx";
import { PLUG_COLORS } from "../plugs/PlugsTab.jsx";
import { summarizeTodaySessions } from "./simpleDevicesToday.js";

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function SimpleDevicesToday() {
  const t = useT();
  const fromDate = new Date();
  fromDate.setHours(0, 0, 0, 0);
  const toDate = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate() + 1);
  const { data } = usePolledResource(`/api/big-consumers/sessions?from=${fromDate.getTime()}&to=${toDate.getTime()}`, {
    intervalMs: 60000,
    keepLastGoodOnError: true,
    cacheTtlMs: 60000,
  });
  const devices = useMemo(() => summarizeTodaySessions(data?.sessions ?? [], Date.now()), [data]);
  if (!devices.length) return null;

  return (
    <>
      <SectionTitle>{t("devices.today")}</SectionTitle>
      <ul className="simple-devices-today" role="list">
        {devices.map((device, i) => (
          <li className="simple-device-row" key={device.device}>
            <span className="simple-device-dot" style={{ background: PLUG_COLORS[(device.colorIdx ?? i) % PLUG_COLORS.length] }} aria-hidden="true" />
            <div className="simple-device-main">
              <span className="simple-device-name">{device.device}</span>
              <span className={`simple-device-status${device.running ? " is-running" : ""}`}>
                {device.running
                  ? t("devices.running", { minutes: device.durationMin })
                  : t("devices.ended", { time: fmtTime(device.activityTs) })}
              </span>
            </div>
            <span className="simple-device-kwh">{device.kwh.toFixed(2)} kWh</span>
          </li>
        ))}
      </ul>
    </>
  );
}
