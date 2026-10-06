import { useEffect, useRef } from "react";
import echarts from "../echarts.js";
import FlipTile from "../components/FlipTile.jsx";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import { PLUG_COLORS, REST_COLOR } from "../plugs/PlugsTab.jsx";

// Simple-view Consumers ring (2026-10-06, user request): today's home
// consumption as a donut — one segment per smart plug + the Rest-of-home
// segment (the ring's total IS the whole house, shown in the center).
// Flip it for the value list: consumers, rest, then the house total with
// the day's kWh. Same data as the Dashboard's Consumers tile
// (/api/stats/consumers, offset 0), same colors (shared PLUG_COLORS/
// REST_COLOR, name-sorted everywhere). Hidden entirely when the account
// has no plugs.
export default function ConsumersRing() {
  const t = useT();
  const { data } = usePolledResource("/api/stats/consumers?offset=0", {
    intervalMs: 60000,
    keepLastGoodOnError: true,
  });
  const ref = useRef(null);
  const chartRef = useRef(null);

  const plugs = data?.plugs ?? [];
  const hasPlugs = plugs.length > 0;

  useEffect(() => {
    if (!hasPlugs) return undefined;
    // No width/height at init — the pinned-size rotation bug (2026-09-12).
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [hasPlugs]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !data) return;
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      tooltip: {
        trigger: "item",
        backgroundColor: "#1a2128",
        borderColor: "#2a3238",
        textStyle: { color: "#e8ecef", fontSize: 12 },
        formatter: (p) => `${p.name}: ${p.value} kWh (${p.percent} %)`,
      },
      series: [
        {
          type: "pie",
          radius: ["62%", "88%"],
          center: ["50%", "50%"],
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderColor: "#10151a", borderWidth: 1 },
          // Rest LAST in the data so it closes the ring in the same
          // position it holds on the Dashboard tile's front (bottom/last).
          data: [
            ...plugs.map((p, i) => ({
              name: p.name,
              value: p.kwh,
              itemStyle: { color: PLUG_COLORS[i % PLUG_COLORS.length] },
            })),
            { name: t("plugs.rest"), value: data.restKwh, itemStyle: { color: REST_COLOR } },
          ],
        },
      ],
    });
  }, [data, plugs, t]);

  if (!hasPlugs) return null;

  const rows = plugs.map((p, i) => ({
    key: p.sn,
    label: p.name,
    color: PLUG_COLORS[i % PLUG_COLORS.length],
    kwh: p.kwh,
  }));
  rows.push({ key: "rest", label: t("plugs.rest"), color: REST_COLOR, kwh: data.restKwh });

  return (
    <div className="src-card">
      <div className="tile-title src-title">
        <span>{t("dashboard.consumers.title")}</span>
      </div>
      <FlipTile
        back={
          <div className="src-card-body consumers-ring-back">
            <div className="src-rows">
              {rows.map((r) => (
                <div className="src-row" key={r.key}>
                  <span className="src-dot" style={{ background: r.color }} />
                  <span className="src-label">{r.label}</span>
                  <span className="src-value">
                    <span className="src-kwh">{r.kwh} kWh</span>
                    {data.homeKwh > 0 && (
                      <span className="src-pct">{Math.round((r.kwh / data.homeKwh) * 100)} %</span>
                    )}
                  </span>
                </div>
              ))}
              <div className="src-row consumers-ring-total">
                <span className="src-label">{t("plugs.house")}</span>
                <span className="src-value">
                  <span className="src-kwh">{data.homeKwh} kWh</span>
                </span>
              </div>
            </div>
          </div>
        }
      >
        <div className="card consumers-ring-front">
          <div className="consumers-ring-chart" ref={ref} />
          {/* Center total as an HTML overlay — the slim ECharts build has
              no TitleComponent, and app values live ON the visuals. */}
          <div className="consumers-ring-center">
            <span className="consumers-ring-total-kwh">{data.homeKwh} kWh</span>
            <span className="consumers-ring-house">{t("plugs.house")}</span>
          </div>
        </div>
      </FlipTile>
    </div>
  );
}
