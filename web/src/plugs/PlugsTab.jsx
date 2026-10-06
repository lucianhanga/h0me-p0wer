import { useEffect, useRef, useState } from "react";
import echarts from "../echarts.js";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import { homeOf } from "../graph/derive.js";

// Smart plugs tab (2026-10-06): one card per A17X8 plug with a 24 h power
// chart, plus a derived "rest of home" chart (home − Σ plugs, floored at 0 —
// plug and meter sample cadences differ by seconds, so small negatives at
// load edges are skew artifacts, not data). Per-plug intraday history is
// LOCAL ONLY (plug_samples, accumulated by the 10 s scene poll): the Anker
// cloud exposes per-plug daily kWh but no power trend, so the curves start
// filling in from the moment this shipped.
//
// Data flow: card headers poll /api/plugs every 10 s (live watts + today's
// kWh from the cloud home_usage sync); the charts refresh every minute from
// /api/plugs/timeseries + /api/timeseries fetched with the SAME bucket size
// so rows align by t and "rest" is a plain per-bucket subtraction (home
// definition shared with the Graph tab via derive.js's homeOf).
const WINDOW_MS = 24 * 3600 * 1000;
const CHART_REFRESH_MS = 60 * 1000;
const PLUG_COLORS = ["#5fce80", "#f7a44f", "#c084fc", "#6bb8f5", "#e5544b", "#f5d76b", "#8ee3a8", "#e8ecef"];
const REST_COLOR = "#90a4ae";

function chartOption(color) {
  const isPhone = window.matchMedia("(max-width: 600px)").matches;
  return {
    animation: false,
    backgroundColor: "transparent",
    grid: isPhone
      ? { top: 8, right: 2, bottom: 22, left: 2, containLabel: false }
      : { top: 8, right: 8, bottom: 22, left: 44 },
    tooltip: {
      trigger: "axis",
      valueFormatter: (v) => (v == null ? "—" : `${Math.round(v)} W`),
      backgroundColor: "#1a2128",
      borderColor: "#2a3238",
      textStyle: { color: "#e8ecef", fontSize: 12 },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: "#2a3238" } },
      axisLabel: {
        color: "#8b98a5",
        fontSize: 10,
        hideOverlap: true,
        formatter: (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      splitNumber: 2,
      axisLabel: {
        color: "#8b98a5",
        fontSize: 10,
        formatter: (v) => `${Math.round(v)}`,
        inside: isPhone,
      },
      splitLine: { lineStyle: { color: "#2a323866" } },
    },
    dataZoom: [{ type: "inside", xAxisIndex: 0, filterMode: "none" }],
    series: [
      {
        name: "W",
        type: "line",
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color, width: 1.5 },
        itemStyle: { color },
        areaStyle: { color: `${color}33` },
        emphasis: { disabled: true },
        data: [],
      },
    ],
  };
}

function PlugCard({ title, subtitle, color, watts, todayKwh, offline, data, t }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    // No width/height at init — the pinned-size rotation bug (2026-09-12).
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption(chartOption(color));
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [color]);

  useEffect(() => {
    chartRef.current?.setOption({ series: [{ data: data ?? [] }] });
  }, [data]);

  return (
    <div className={`card plug-card${offline ? " plug-offline" : ""}`}>
      <div className="plug-card-head">
        <div className="plug-card-title">
          <span className="plug-name">{title}</span>
          {subtitle && <span className="plug-sub">{subtitle}</span>}
        </div>
        <div className="plug-card-stats">
          <span className="plug-watts">
            {offline ? t("plugs.offline") : watts != null ? `${Math.round(watts)} W` : "—"}
          </span>
          {todayKwh != null && <span className="plug-kwh">{todayKwh.toFixed(2)} kWh {t("plugs.today")}</span>}
        </div>
      </div>
      <div className="plug-chart" ref={ref} />
    </div>
  );
}

export default function PlugsTab() {
  const t = useT();
  const { data: live, error } = usePolledResource("/api/plugs", {
    intervalMs: 10000,
    keepLastGoodOnError: true,
  });
  const [curves, setCurves] = useState(null); // { bySn: {sn: [[t,w]..]}, rest: [[t,w]..] }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const to = Date.now();
      const from = to - WINDOW_MS;
      try {
        const pr = await fetch(`/api/plugs/timeseries?from=${from}&to=${to}&points=800`).then((r) => r.json());
        if (!pr.ok) return;
        const hr = await fetch(
          `/api/timeseries?from=${from}&to=${to}&bucket=${pr.bucketMs}`,
        ).then((r) => r.json());
        const homeByT = new Map();
        if (hr.ok) for (const r of hr.data) homeByT.set(r.t, homeOf(r));
        const bySn = {};
        for (const sn of pr.plugs) bySn[sn] = [];
        const rest = [];
        for (const row of pr.data) {
          let sum = 0;
          for (const sn of pr.plugs) {
            const v = row[`plug__${sn}`];
            bySn[sn].push([row.t, v]);
            if (v != null) sum += v;
          }
          const home = homeByT.get(row.t);
          rest.push([row.t, home == null ? null : Math.max(0, Math.round(home - sum))]);
        }
        if (!cancelled) setCurves({ bySn, rest });
      } catch {
        // transient — next minute's tick retries
      }
    }
    load();
    const iv = setInterval(load, CHART_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  if (error && !live) return <p className="error">{String(error)}</p>;
  if (!live) return <p>{t("common.loading")}</p>;

  const plugs = [...(live.plugs ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (!plugs.length) return <p className="plug-empty">{t("plugs.empty")}</p>;

  return (
    <section>
      <div className="plug-cards">
        {plugs.map((p, i) => (
          <PlugCard
            key={p.sn}
            title={p.name}
            subtitle={p.typeTag && p.typeTag !== "Smart Plug" ? p.typeTag : p.tag}
            color={PLUG_COLORS[i % PLUG_COLORS.length]}
            watts={p.watts}
            todayKwh={live.todayKwh?.[p.sn]}
            offline={!p.online}
            data={curves?.bySn?.[p.sn]}
            t={t}
          />
        ))}
        <PlugCard
          title={t("plugs.rest")}
          subtitle={t("plugs.restSub")}
          color={REST_COLOR}
          watts={null}
          todayKwh={null}
          offline={false}
          data={curves?.rest}
          t={t}
        />
      </div>
      <p className="plug-note">{t("plugs.note")}</p>
    </section>
  );
}
