import { useEffect, useRef, useState } from "react";
import echarts from "../echarts.js";
import QuadFlipTile from "./QuadFlipTile.jsx";
import { useT } from "../i18n/LanguageProvider.jsx";
import { readCached, writeCached, periodImmutable } from "../historyCache.js";
import { PLUG_COLORS, REST_COLOR } from "../plugs/PlugsTab.jsx";

// Per-period consumer breakdown tile (2026-10-07, user request) — shared by
// the simple view's Consume section and the full Dashboard grid. One tile
// per period (day / week / month), round-robin THREE faces via
// QuadFlipTile: ring (the period's split as a donut, house total in the
// center) → stacked per-day bars (rest at the bottom, consumers above in
// the shared palette) → the value list (consumers, rest, whole house).
// ‹ › arrows + horizontal swipe navigate the period into the past (same
// contract as SourceCard); immutable periods come from the browser cache.
// Data: /api/stats/consumers?type&offset (plug_daily + cloud_home_history).
// Renders nothing when the account has no plugs.

const FACES = ["ring", "bars", "list"];

export function RingFace({ data, t }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  const plugs = data.plugs;

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
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
          // Rest LAST in the data — same position it holds on the list
          // face.
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

  return (
    <div className="card consumers-ring-front">
      <div className="consumers-ring-chart" ref={ref} />
      {/* Center total as an HTML overlay — the slim ECharts build has no
          TitleComponent, and app values live ON the visuals. */}
      <div className="consumers-ring-center">
        <span className="consumers-ring-total-kwh">{data.homeKwh} kWh</span>
        <span className="consumers-ring-house">{t("plugs.house")}</span>
      </div>
    </div>
  );
}

// Stacked per-day kWh bars: rest FIRST = bottom of the stack (user request
// 2026-10-06), then one series per plug in the shared palette. formatLabel
// defaults to weekday-short (day/week windows); month bars pass a
// day-of-month formatter.
export function ConsumerBars({ bars, plugs, t, formatLabel }) {
  const ref = useRef(null);
  const labelOf = formatLabel ?? ((l) => new Date(`${l}T12:00:00`).toLocaleDateString([], { weekday: "short" }));

  useEffect(() => {
    if (!bars?.length) return undefined;
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: { top: 8, right: 4, bottom: 4, left: 4, containLabel: true },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#1a2128",
        borderColor: "#2a3238",
        textStyle: { color: "#e8ecef", fontSize: 11 },
        valueFormatter: (v) => `${v} kWh`,
      },
      xAxis: {
        type: "category",
        data: bars.map((b) => labelOf(b.label)),
        axisLabel: { color: "#8b98a5", fontSize: 9, hideOverlap: true },
        axisLine: { lineStyle: { color: "#2a3238" } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#8b98a5", fontSize: 9 },
        splitLine: { lineStyle: { color: "#2a323866" } },
      },
      series: [
        { name: t("plugs.rest"), type: "bar", stack: "s", itemStyle: { color: REST_COLOR }, data: bars.map((b) => b.rest) },
        ...plugs.map((p, i) => ({
          name: p.name,
          type: "bar",
          stack: "s",
          itemStyle: { color: PLUG_COLORS[i % PLUG_COLORS.length] },
          data: bars.map((b) => b[`plug__${p.sn}`] ?? 0),
        })),
      ],
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [bars, plugs, t, labelOf]);

  return <div ref={ref} className="back-bars" />;
}

export function ListFace({ data, t }) {
  const rows = data.plugs.map((p, i) => ({
    key: p.sn,
    label: p.name,
    color: PLUG_COLORS[i % PLUG_COLORS.length],
    kwh: p.kwh,
  }));
  // Rest row pinned last of the consumers, then the whole-house total.
  rows.push({ key: "rest", label: t("plugs.rest"), color: REST_COLOR, kwh: data.restKwh });
  return (
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
  );
}

export default function ConsumersPeriodCard({ type, title }) {
  const t = useT();
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [blocked, setBlocked] = useState(false);
  const [faceIdx, setFaceIdx] = useState(0);
  const swipeStart = useRef(null);

  async function load(off) {
    const url = `/api/stats/consumers?type=${type}&offset=${off}`;
    try {
      if (periodImmutable(type, off)) {
        const hit = readCached(url);
        if (hit?.ok) return hit.data;
      }
      const j = await fetch(url).then((r) => r.json());
      if (!j.ok) return null;
      if (periodImmutable(type, off)) writeCached(url, j);
      return j.data;
    } catch {
      return null;
    }
  }

  // Initial load + 60 s refresh of the live (offset 0) period.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const d = await load(0);
      if (!cancelled && d) {
        setData(d);
        setBlocked(!d.hasEarlier);
      }
    };
    tick();
    const iv = setInterval(() => {
      if (offset === 0) tick();
    }, 60000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, offset === 0]);

  // Swipe left/right navigates periods — same gesture contract as
  // SourceCard (left = older, right = newer, 50 px min, 1.5× dominance).
  const onTouchStart = (e) => {
    if (e.target.closest("button")) return;
    swipeStart.current = [e.touches[0].clientX, e.touches[0].clientY];
  };
  const onTouchEnd = (e) => {
    const s = swipeStart.current;
    swipeStart.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s[0];
    const dy = e.changedTouches[0].clientY - s[1];
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    go(dx < 0 ? 1 : -1);
  };

  async function go(dir) {
    const next = offset + dir;
    if (next < 0) return;
    const d = await load(next);
    if (!d) return;
    if (!d.hasData) {
      setBlocked(true); // hit the plug-history edge — stay where we are
      return;
    }
    setBlocked(!d.hasEarlier);
    setData(d);
    setOffset(next);
  }

  if (!data || !data.plugs.length) return null;

  const face = FACES[faceIdx];
  // Bars granularity mirrors the Totals tiles (2026-10-07, user request):
  // the day tile's bars are HOURLY (epoch-ms labels → HH:MM), week windows
  // label by weekday, month by day-of-month, year by month name.
  const barLabel =
    type === "day"
      ? (l) => new Date(l).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : type === "month"
        ? (l) => l.slice(8)
        : type === "year"
          ? (l) => new Date(`${l}-15T12:00:00`).toLocaleDateString([], { month: "short" })
          : (l) => new Date(`${l}T12:00:00`).toLocaleDateString([], { weekday: "short" });

  return (
    <div className="src-card" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {/* Arrows outside the flip tile so period nav works on every face
          (same lesson as SourceCard, 2026-09-19). */}
      <div className="tile-title src-title">
        <button className="src-nav" onClick={() => go(1)} disabled={blocked} aria-label={t("dashboard.olderPeriod")}>
          ‹
        </button>
        <span>{offset === 0 ? title : (data.label ?? title)}</span>
        <button className="src-nav" onClick={() => go(-1)} disabled={offset === 0} aria-label={t("dashboard.newerPeriod")}>
          ›
        </button>
      </div>
      {/* No face-name title (2026-10-07, user request) — the box alone
          flips through ring → bars → list. */}
      <QuadFlipTile
        title={null}
        onFlip={() => setFaceIdx((i) => (i + 1) % FACES.length)}
      >
        {face === "ring" ? (
          <RingFace data={data} t={t} />
        ) : face === "bars" ? (
          <div className="card consumers-bars-face">
            <ConsumerBars bars={data.bars} plugs={data.plugs} t={t} formatLabel={barLabel} />
          </div>
        ) : (
          <ListFace data={data} t={t} />
        )}
      </QuadFlipTile>
    </div>
  );
}
