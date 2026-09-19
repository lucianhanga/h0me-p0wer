import { useEffect, useRef, useState } from "react";
import echarts from "../echarts.js";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { usePolledResource } from "../usePolledResource.js";

const DAY_MS = 86400000;
const fmtEur = (v) =>
  `€${Number(v).toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

// ROI tab: what the setup cost (snapshotted BOM), what it has saved so far
// (measured, DB only), and when the savings cross the investment. All
// forward-looking numbers come from the persisted baseline (set in stone,
// recomputed only via the ↻ button) — the measured average is shown only as
// a comparison.
export default function RoiTab() {
  // daily-grain data; 5 min is plenty. (Real bug fixed by this migration:
  // the old hand-rolled version never cleared `error` on a successful poll,
  // so any single failure permanently broke the tab even after the next
  // poll recovered — see AGENTS.md.)
  const { data, error, setData } = usePolledResource("/api/roi", { intervalMs: 300000 });
  const [updatedAt, setUpdatedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (data) setUpdatedAt(new Date());
  }, [data]);

  const recomputeBaseline = () => {
    if (
      !confirm(
        "Recompute the savings baseline? This replaces the fixed basis for payback and all projections (one AI call).",
      )
    ) {
      return;
    }
    setRefreshing(true);
    fetch("/api/roi/baseline/refresh", { method: "POST" })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) throw new Error(res.error);
        setData(res.data);
      })
      .catch((e) => alert(`Baseline recompute failed: ${e.message ?? e}`))
      .finally(() => setRefreshing(false));
  };

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <p className="muted">loading…</p>;

  const monthsTo = (iso) =>
    iso == null
      ? null
      : Math.max(0, Math.round((new Date(`${iso}T12:00:00`).getTime() - Date.now()) / (30.44 * DAY_MS)));
  const monthsToOutlookPayback = monthsTo(data.outlookPaybackDate);
  const baseline = data.baseline;
  // "Possible outcome" (trend-adjusted rolling forecast — see roi.js
  // buildOutlook) is the headline payback date; the original flat baseline
  // plan (from day 1) stays visible as a comparison only where it actually
  // differs, so the tile doesn't repeat the same date twice.
  const planDiffers = data.paybackDate !== data.outlookPaybackDate;
  const tracking = data.performanceRatioPct != null;
  const ahead = tracking && data.performanceRatioPct >= 100;
  // "Extended" = optional add-ons not yet bought (currently: the battery
  // weather cover, and the BP5000 expansion module) — kept visible for
  // reference/planning but split out of the actual system's BOM so the
  // main list stays "what's installed," matching category in roi-bom.json.
  const mainBom = data.bom.filter((r) => r.category !== "extended");
  const extendedBom = data.bom.filter((r) => r.category === "extended");

  return (
    <div>
      <UpdatedStamp at={updatedAt}>tariff €{data.tariffEurPerKwh}/kWh · DB only</UpdatedStamp>

      <div className="tiles">
        <div className="tile">
          <div className="tile-title">Saved so far</div>
          <div className="tile-main">{fmtEur(data.savingsSoFarEur)}</div>
          <div className="tile-sub">
            since {fmtDate(data.installDate)} · {data.measuredDays} days
          </div>
        </div>
        <div className="tile">
          <div className="tile-title">Tracking</div>
          <div className={`tile-main ${tracking ? (ahead ? "roi-pos" : "roi-neg") : ""}`}>
            {tracking ? `${data.performanceRatioPct}%` : "—"}
          </div>
          <div className="tile-sub">{tracking ? "of seasonal baseline" : "not enough data yet"}</div>
        </div>
        <div className="tile">
          <div className="tile-title roi-baseline-head">
            Baseline
            <button
              className="roi-refresh-btn"
              onClick={recomputeBaseline}
              disabled={refreshing}
              title="Recompute the baseline (AI estimate) — replaces the fixed ROI basis"
            >
              {refreshing ? "…" : "↻"}
            </button>
          </div>
          <div className="tile-main">
            {fmtEur(baseline.avgDailySavingsEur)}
            <span className="roi-perday">/day</span>
          </div>
          <div className="tile-sub">
            set {fmtDate(baseline.createdAt.slice(0, 10))} ·{" "}
            {baseline.source === "ai" ? "AI estimate" : "PVGIS estimate"}
          </div>
          <div className="tile-sub muted">
            measured {fmtEur(data.measuredAvgDailySavingsEur)}/day over {data.measuredDays} days
          </div>
        </div>
        <div className="tile">
          <div className="tile-title">Projected per year</div>
          <div className="tile-main">{fmtEur(data.projectedAnnualSavingsEur)}</div>
          <div className="tile-sub">baseline annual</div>
        </div>
        <div className="tile">
          <div className="tile-title">Payback</div>
          <div className="tile-main">
            {data.outlookPaybackDate ? fmtDate(data.outlookPaybackDate) : "—"}
          </div>
          <div className="tile-sub">
            {monthsToOutlookPayback != null ? `in ${monthsToOutlookPayback} months` : "not within 25 years"}
          </div>
          {planDiffers && (
            <div className="tile-sub muted">
              baseline plan: {data.paybackDate ? fmtDate(data.paybackDate) : "—"}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h4>Amortization</h4>
        <AmortizationChart data={data} />
        {data.outlookNote && <p className="muted roi-outlook-note">{data.outlookNote}</p>}
      </div>

      <div className="card">
        <div className="roi-bom-head">
          <h4>Investment (bill of materials)</h4>
          <a className="roi-pdf-btn" href="/api/roi/bom.pdf" download>
            Download PDF
          </a>
        </div>
        {mainBom.map((r) => (
          <BomRow key={r.asin} r={r} />
        ))}
        <div className="roi-total-row">
          <span>Total invested</span>
          <span className="roi-total">{fmtEur(data.totalInvestedEur)}</span>
        </div>
        <p className="muted">
          Prices are snapshots from{" "}
          {data.bom.find((r) => r.priceSnapshotDate)?.priceSnapshotDate ?? "n/a"} — what was paid,
          not today's price. Editable in server/roi-bom.json.{" "}
          <span className="roi-est">~</span> = estimated, please correct.
        </p>
      </div>

      {extendedBom.length > 0 && (
        <div className="card">
          <h4>Extended (not yet purchased)</h4>
          {extendedBom.map((r) => (
            <BomRow key={r.asin} r={r} />
          ))}
          <p className="muted">
            Optional add-ons under consideration — kept here for reference, excluded from
            "Total invested" until actually bought.
          </p>
        </div>
      )}

      <h4>Projection (baseline estimate)</h4>
      <div className="tiles roi-proj">
        {data.projections.map((p) => (
          <div className="tile" key={p.years}>
            <div className="tile-title">{p.years} {p.years === 1 ? "year" : "years"}</div>
            <div className="tile-main">{fmtEur(p.cumulativeSavingsEur)}</div>
            <div className={`tile-sub ${p.profitEur >= 0 ? "roi-pos" : "roi-neg"}`}>
              {p.profitEur >= 0 ? "+" : "−"}{fmtEur(Math.abs(p.profitEur))} profit
            </div>
          </div>
        ))}
      </div>

      <p className="muted">
        Assumptions: {baseline.source === "ai" ? "AI" : "PVGIS"} baseline set{" "}
        {fmtDate(baseline.createdAt.slice(0, 10))} — {fmtEur(baseline.avgDailySavingsEur)}/day (
        {Math.round(baseline.annualPvKwh)} kWh/yr at {Math.round(baseline.selfConsumptionRatio * 100)}%
        self-consumption), seasonally shaped per month, constant tariff €
        {data.tariffEurPerKwh}/kWh, no panel degradation. {baseline.reasoning} Measured comparison:
        {" "}{fmtEur(data.measuredAvgDailySavingsEur)}/day over {data.measuredDays} days (today
        excluded, unfinished). Savings = avoided grid import (PV direct-to-home + battery cells
        discharge). The "Possible outcome" (dotted line, Payback tile) is a rolling forecast: the
        baseline's seasonal shape scaled by how the system has tracked against it so far —
        it moves as new days are measured, unlike the fixed baseline plan.
      </p>
    </div>
  );
}

// One BOM/extended-list row — shared so both sections render identically
// (thumbnail, name, qty × unit price, line total, "not counted" tag for
// excluded rows).
function BomRow({ r }) {
  return (
    <a
      className={`roi-bom-row${r.excluded ? " excluded" : ""}`}
      href={r.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${r.name} — view product`}
    >
      <img className="roi-bom-thumb" src={`/api/roi/image/${r.asin}`} alt="" loading="lazy" />
      <span className="roi-bom-name">
        {r.estimated ? <span className="roi-est">~</span> : null}
        {r.name}
        {r.excluded ? <span className="roi-excl-tag">not counted</span> : null}
      </span>
      <span className="roi-bom-nums">
        <span className="roi-bom-qty">
          {r.qty} × {fmtEur(r.unitPriceEur)}
        </span>
        <span className="roi-bom-price">{fmtEur(r.lineTotalEur)}</span>
      </span>
    </a>
  );
}

// Cumulative savings vs. investment: ONE line, solid where it's measured
// (2026-09-16, user request + research: dashboards mix up actual/forecast
// when they use different colors for each — same color, style changes at
// "now" is the standard convention) — solid green for what's already
// known, dotted green continuing as the trend-adjusted "possible outcome"
// (buildOutlook, roi.js). Orange dashed = total invested; marker =
// break-even where the OUTLOOK crosses the invested line.
function AmortizationChart({ data }) {
  const ref = useRef(null);

  useEffect(() => {
    const measured = data.series.map((s) => [
      new Date(`${s.date}T00:00:00`).getTime(),
      s.cumulativeEur,
    ]);
    const outlook = (data.outlookSeries ?? []).map((f) => [
      new Date(`${f.date}T00:00:00`).getTime(),
      f.cumulativeEur,
    ]);

    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: { top: 28, right: 16, bottom: 8, left: 8, containLabel: true },
      legend: {
        top: 0,
        textStyle: { color: "#8b98a5", fontSize: 10 },
        itemWidth: 14,
        itemHeight: 8,
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#1a2128",
        borderColor: "#2a3238",
        textStyle: { color: "#e8ecef", fontSize: 11 },
        valueFormatter: (v) => (v == null ? "—" : fmtEur(v)),
      },
      xAxis: {
        type: "time",
        axisLabel: { color: "#8b98a5", fontSize: 10, hideOverlap: true },
        axisLine: { lineStyle: { color: "#2a3238" } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#8b98a5", fontSize: 10, formatter: (v) => `€${v}` },
        splitLine: { lineStyle: { color: "#2a323866" } },
      },
      series: [
        {
          name: "Saved (measured)",
          type: "line",
          showSymbol: false,
          lineStyle: { color: "#5fce80", width: 2 },
          itemStyle: { color: "#5fce80" },
          data: measured,
        },
        {
          name: "Possible outcome",
          type: "line",
          showSymbol: false,
          lineStyle: { color: "#5fce80", width: 2, type: "dotted", opacity: 0.85 },
          itemStyle: { color: "#5fce80" },
          data: outlook,
          markLine: {
            silent: true,
            symbol: "none",
            data: [{ yAxis: data.totalInvestedEur }],
            lineStyle: { color: "#f7a44f", type: "dashed" },
            label: {
              formatter: `invested ${fmtEur(data.totalInvestedEur)}`,
              color: "#f7a44f",
              fontSize: 10,
              position: "insideStartTop",
            },
          },
          markPoint: data.outlookPaybackDate
            ? {
                symbol: "circle",
                symbolSize: 9,
                itemStyle: { color: "#f7a44f" },
                label: {
                  formatter: `break-even\n${fmtDate(data.outlookPaybackDate)}`,
                  color: "#e8ecef",
                  fontSize: 10,
                  position: "top",
                },
                data: [
                  {
                    coord: [
                      new Date(`${data.outlookPaybackDate}T00:00:00`).getTime(),
                      data.totalInvestedEur,
                    ],
                  },
                ],
              }
            : undefined,
        },
      ],
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [data]);

  return <div ref={ref} className="roi-chart" />;
}
