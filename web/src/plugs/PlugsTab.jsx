import { useEffect, useRef, useState } from "react";
import echarts from "../echarts.js";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import { homeOf } from "../graph/derive.js";
import { SHORTCUTS } from "../graph/GraphTab.jsx";

// Smart plugs tab (2026-10-06): one card per A17X8 plug with a power chart,
// plus a derived "rest of home" chart (home − Σ plugs, floored at 0 — plug
// and meter sample cadences differ by seconds, so small negatives at load
// edges are skew artifacts, not data). Per-plug intraday history is LOCAL
// ONLY (plug_samples, accumulated by the 10 s scene poll): the Anker cloud
// exposes per-plug daily kWh but no power trend, so the curves fill in from
// deploy day.
//
// Charts behave like the Graph tab's (same resolution choices, 2026-10-06
// user request): per-card span buttons (SHORTCUTS shared with GraphTab),
// zoom/pan with a debounced 250 ms padded refetch, live-edge incremental
// appends every 10 s (plug samples land at the 10 s scene cadence), and the
// last span remembered across tab switches. Per-plug cards fetch only
// /api/plugs/timeseries; the Rest card also fetches /api/timeseries with
// the same bucket so rows align by t and "rest" is a per-bucket
// subtraction (home definition shared via derive.js's homeOf).
// Card headers poll /api/plugs every 10 s for live watts + today's kWh.
const LIVE_EDGE_MS = 2 * 60 * 1000; // "live" when right edge within 2 min of now
// Palette shared with the Dashboard's Consumers tile (2026-10-06) — a plug
// must keep the same color in both places.
// 2026-10-10 redesign (user request): 16 hues 22.5° apart (HSL S65/L62,
// tuned for the dark card background), ordered by BIT-REVERSED index so any
// used prefix is maximally hue-separated and unused tail slots stay reserved
// — and mutually distinct — for future plugs. Assignment is STABLE: the
// server hands each plug its first-seen colorIdx (kv plug_color_order), so
// adding/renaming a plug never recolors the others (the old name-sorted
// position did exactly that). plugColor() falls back to list position for
// payloads without colorIdx.
export const PLUG_COLORS = [
  "#dd5f5f", "#5fdddd", "#9edd5f", "#9e5fdd",
  "#ddbe5f", "#5f7fdd", "#5fdd7f", "#dd5fbe",
  "#dd8e5f", "#5faedd", "#6fdd5f", "#cd5fdd",
  "#cddd5f", "#6f5fdd", "#5fddae", "#dd5f8e",
];
export const REST_COLOR = "#90a4ae";
export function plugColor(p, fallbackIdx) {
  return PLUG_COLORS[(p.colorIdx ?? fallbackIdx) % PLUG_COLORS.length];
}

// Remembers each card's selected span across tab switches (the tab unmounts
// on switch — see App.jsx), same pattern as GraphTab's savedSpanMs.
const savedSpanMs = {};

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
      // Never finer than 50 W steps (2026-10-06, user request): low-power
      // plugs (a 9 W idle draw) otherwise get 5/10 W tick labels that read
      // as false precision. Bigger steps are still allowed when the data
      // range needs them.
      minInterval: 50,
      axisLabel: {
        color: "#8b98a5",
        fontSize: 10,
        formatter: (v) => `${Math.round(v)}`,
        inside: isPhone,
      },
      splitLine: { lineStyle: { color: "#2a323866" } },
    },
    // preventDefaultMouseMove: false (2026-10-07, user report): with the
    // default (true) the inside-zoom roam controller preventDefaults
    // touchmove-as-mousemove — a vertical swipe over a chart showed the
    // tooltip but never scrolled the page on phones.
    dataZoom: [{ type: "inside", xAxisIndex: 0, filterMode: "none", preventDefaultMouseMove: false }],
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

function PlugCard({ cardKey, sn, isRest, title, subtitle, color, watts, todayKwh, offline, t }) {
  const ref = useRef(null);
  const apiRef = useRef(null);
  const [activeSpan, setActiveSpan] = useState(savedSpanMs[cardKey] ?? 24 * 3600 * 1000);

  useEffect(() => {
    // No width/height at init — the pinned-size rotation bug (2026-09-12).
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption(chartOption(color));
    let rows = []; // [[t, watts|null], ...]
    let bucketMs = 0;
    let fetchSeq = 0;
    let fetchTimer = null;
    let programmatic = false;
    let liveBusy = false;
    let disposed = false;

    // Fetch this card's series over [fromMs, toMs]. `extra` carries either
    // points+view (full loads) or bucket (live-edge appends).
    async function fetchRows(fromMs, toMs, extra) {
      const pr = await fetch(
        `/api/plugs/timeseries?from=${Math.round(fromMs)}&to=${Math.round(toMs)}&${extra}`,
      )
        .then((r) => r.json())
        .catch(() => null);
      if (!pr?.ok) return null;
      if (!isRest) {
        return { bucketMs: pr.bucketMs, data: pr.data.map((r) => [r.t, r[`plug__${sn}`] ?? null]) };
      }
      const hr = await fetch(
        `/api/timeseries?from=${Math.round(fromMs)}&to=${Math.round(toMs)}&bucket=${pr.bucketMs}`,
      )
        .then((r) => r.json())
        .catch(() => null);
      const homeByT = new Map();
      if (hr?.ok) for (const r of hr.data) homeByT.set(r.t, homeOf(r));
      return {
        bucketMs: pr.bucketMs,
        data: pr.data.map((r) => {
          let sum = 0;
          for (const s of pr.plugs) {
            const v = r[`plug__${s}`];
            if (v != null) sum += v;
          }
          const home = homeByT.get(r.t);
          return [r.t, home == null ? null : Math.max(0, Math.round(home - sum))];
        }),
      };
    }

    function setWindow(fromMs, toMs) {
      programmatic = true;
      chart.setOption({ dataZoom: [{ startValue: fromMs, endValue: toMs }] });
      programmatic = false;
    }

    function visibleWindow() {
      const win = chart.getOption().dataZoom?.[0];
      const start = Number(win?.startValue);
      const end = Number(win?.endValue);
      return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
    }

    async function loadRange(fromMs, toMs, viewMs = toMs - fromMs) {
      const seq = ++fetchSeq;
      const payload = await fetchRows(fromMs, toMs, `points=800&view=${Math.round(viewMs)}`);
      if (!payload || seq !== fetchSeq || disposed) return;
      rows = payload.data;
      bucketMs = payload.bucketMs;
      chart.setOption({ series: [{ data: rows }] });
    }

    function loadVisible() {
      const win = visibleWindow();
      if (!win) return;
      const pad = (win[1] - win[0]) / 2;
      loadRange(win[0] - pad, win[1] + pad, win[1] - win[0]);
    }

    function scheduleLoad() {
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(loadVisible, 250);
    }

    chart.on("datazoom", () => {
      if (programmatic) return;
      scheduleLoad();
      const win = visibleWindow();
      if (win) {
        const span = win[1] - win[0];
        const match = SHORTCUTS.find((s) => Math.abs(span - s.ms) / s.ms < 0.02);
        if (match) savedSpanMs[cardKey] = match.ms;
        setActiveSpan(match?.ms ?? null);
      }
    });

    async function setSpan(ms) {
      savedSpanMs[cardKey] = ms;
      setActiveSpan(ms);
      const to = Date.now();
      const from = to - ms;
      await loadRange(from, to);
      setWindow(from, to);
    }
    apiRef.current = { setSpan };

    // Initial view: the span this card was last showing, else 24h.
    setSpan(savedSpanMs[cardKey] ?? 24 * 3600 * 1000);

    // Keep the view fresh while watching the live edge. 3 s: the server's
    // scene poll runs at ~2.5 s whenever a WS client is connected (someone
    // watching the UI), so a 3 s tick picks up every new plug sample.
    const liveTimer = setInterval(async () => {
      if (liveBusy) return;
      const win = visibleWindow();
      if (!win) return;
      if (win[1] < Date.now() - LIVE_EDGE_MS) return;
      liveBusy = true;
      try {
        const width = win[1] - win[0];
        const lastT = rows.length ? rows[rows.length - 1][0] : win[0];
        const payload = await fetchRows(lastT + 1, Date.now(), `bucket=${bucketMs}`);
        if (payload?.data.length) {
          const cutoff = Date.now() - width * 1.5;
          const byT = new Map();
          for (const r of rows) if (r[0] >= cutoff) byT.set(r[0], r);
          for (const r of payload.data) byT.set(r[0], r);
          rows = [...byT.values()].sort((a, b) => a[0] - b[0]);
          chart.setOption({ series: [{ data: rows }] });
        }
        // Only slide the window if the right edge is still at the live edge.
        const win2 = visibleWindow();
        if (win2 && win2[1] >= Date.now() - LIVE_EDGE_MS) {
          setWindow(Date.now() - width, Date.now());
        }
      } finally {
        liveBusy = false;
      }
    }, 3000);

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      disposed = true;
      clearInterval(liveTimer);
      clearTimeout(fetchTimer);
      ro.disconnect();
      chart.dispose();
      apiRef.current = null;
    };
  }, [cardKey, sn, isRest, color]);

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
      <div className="controls">
        {SHORTCUTS.map((s) => (
          <button
            key={s.labelKey}
            className={activeSpan === s.ms ? "span-active" : ""}
            onClick={() => apiRef.current?.setSpan(s.ms)}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </div>
      <div className="plug-chart" ref={ref} />
    </div>
  );
}

export default function PlugsTab() {
  const t = useT();
  const { data: live, error } = usePolledResource("/api/plugs", {
    intervalMs: 3000,
    keepLastGoodOnError: true,
  });

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
            cardKey={p.sn}
            sn={p.sn}
            isRest={false}
            title={p.name}
            subtitle={p.typeTag && p.typeTag !== "Smart Plug" ? p.typeTag : p.tag}
            color={plugColor(p, i)}
            watts={p.watts}
            todayKwh={live.todayKwh?.[p.sn]}
            offline={!p.online}
            t={t}
          />
        ))}
        <PlugCard
          cardKey="rest"
          isRest={true}
          title={t("plugs.rest")}
          subtitle={t("plugs.restSub")}
          color={REST_COLOR}
          watts={null}
          todayKwh={null}
          offline={false}
          t={t}
        />
      </div>
      <p className="plug-note">{t("plugs.note")}</p>
    </section>
  );
}
