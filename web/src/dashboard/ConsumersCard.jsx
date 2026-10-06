import { useEffect, useRef, useState } from "react";
import echarts from "../echarts.js";
import FlipTile from "../components/FlipTile.jsx";
import { useT } from "../i18n/LanguageProvider.jsx";
import { immutableBeforeMs, readCached, writeCached } from "../historyCache.js";
import { PLUG_COLORS, REST_COLOR } from "../plugs/PlugsTab.jsx";

// Consumers tile (2026-10-06, user request): the day's home consumption
// split by smart plug + a "rest" remainder. Front: total kWh + one row per
// plug (color dot, name, kWh, % of the day) with the rest row pinned last.
// Flip side: stacked bars for the 7 days ending at the selected day, one
// series per plug in the SAME colors as the front rows (both sides sort by
// name, like the Consume tab, so a plug keeps its color everywhere), rest
// series FIRST so it sits at the bottom of the stack. Day navigation (‹ ›
// arrows + horizontal swipe) mirrors SourceCard; data comes from
// /api/stats/consumers (plug_daily + cloud_home_history — daily granularity
// is all the cloud keeps for plugs, and plug_daily starts 2026-10-06, so
// the past opens up as days accumulate).

// A day is immutable once it ENDED before yesterday 00:00 local (the cloud
// sync rewrites today + yesterday) — same rule as Dashboard's
// periodImmutable("day", …), which for this card is simply offset ≥ 2.
function dayImmutable(offset) {
  if (offset < 2) return false;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - (offset - 1) * 86400000 <= immutableBeforeMs();
}

function ConsumerBars({ bars, plugs, t }) {
  const ref = useRef(null);

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
        data: bars.map((b) => new Date(`${b.label}T12:00:00`).toLocaleDateString([], { weekday: "short" })),
        axisLabel: { color: "#8b98a5", fontSize: 9, hideOverlap: true },
        axisLine: { lineStyle: { color: "#2a3238" } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#8b98a5", fontSize: 9 },
        splitLine: { lineStyle: { color: "#2a323866" } },
      },
      // Rest FIRST = bottom of the stack (user request 2026-10-06).
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
  }, [bars, plugs, t]);

  return <div ref={ref} className="back-bars" />;
}

export default function ConsumersCard() {
  const t = useT();
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState(null); // /api/stats/consumers response
  const [blocked, setBlocked] = useState(false);
  const swipeStart = useRef(null);

  async function load(off) {
    const url = `/api/stats/consumers?offset=${off}`;
    try {
      if (dayImmutable(off)) {
        const hit = readCached(url);
        if (hit?.ok) return hit.data;
      }
      const j = await fetch(url).then((r) => r.json());
      if (!j.ok) return null;
      if (dayImmutable(off)) writeCached(url, j);
      return j.data;
    } catch {
      return null;
    }
  }

  // Initial load + 60 s refresh of the live (offset 0) day.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const data = await load(0);
      if (!cancelled && data) {
        setActive(data);
        setBlocked(!data.hasEarlier);
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
  }, [offset === 0]);

  // Swipe left/right navigates days — same gesture contract as SourceCard
  // (left = older, right = newer, 50 px min, 1.5× horizontal dominance).
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
    const data = await load(next);
    if (!data) return;
    if (!data.hasData) {
      setBlocked(true); // hit the plug-history edge — stay where we are
      return;
    }
    setBlocked(!data.hasEarlier);
    setActive(data);
    setOffset(next);
  }

  if (!active) return null;

  const rows = active.plugs.map((p, i) => ({
    key: p.sn,
    label: p.name,
    color: PLUG_COLORS[i % PLUG_COLORS.length],
    kwh: p.kwh,
  }));
  // Rest row pinned last on the front too — same position it holds in the
  // flipped stack.
  rows.push({ key: "rest", label: t("plugs.rest"), color: REST_COLOR, kwh: active.restKwh });

  return (
    <div className="src-card" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {/* Arrows outside the FlipTile so day nav works on the flipped side
          too (same lesson as SourceCard, 2026-09-19). */}
      <div className="tile-title src-title">
        <button className="src-nav" onClick={() => go(1)} disabled={blocked} aria-label={t("dashboard.olderPeriod")}>
          ‹
        </button>
        <span>{offset === 0 ? t("dashboard.consumers.title") : (active.label ?? active.date)}</span>
        <button className="src-nav" onClick={() => go(-1)} disabled={offset === 0} aria-label={t("dashboard.newerPeriod")}>
          ›
        </button>
      </div>
      <FlipTile back={<ConsumerBars bars={active.bars} plugs={active.plugs} t={t} />}>
        <div className="src-card-body">
          <div className="src-home">{active.homeKwh} kWh</div>
          <div className="src-rows">
            {rows.map((r) => (
              <div className="src-row" key={r.key}>
                <span className="src-dot" style={{ background: r.color }} />
                <span className="src-label">{r.label}</span>
                <span className="src-value">
                  <span className="src-kwh">{r.kwh} kWh</span>
                  {active.homeKwh > 0 && (
                    <span className="src-pct">{Math.round((r.kwh / active.homeKwh) * 100)} %</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </FlipTile>
    </div>
  );
}
