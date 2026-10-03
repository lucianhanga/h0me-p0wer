import { useEffect, useRef, useState } from "react";
import echarts from "../echarts.js";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";

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
  const t = useT();
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
    if (!confirm(t("roi.baseline.confirm"))) {
      return;
    }
    setRefreshing(true);
    fetch("/api/roi/baseline/refresh", { method: "POST" })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) throw new Error(res.error);
        setData(res.data);
      })
      .catch((e) => alert(t("roi.baseline.failed", { error: e.message ?? e })))
      .finally(() => setRefreshing(false));
  };

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <p className="muted">{t("common.loading")}</p>;

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
  // Break-even tile for the Projection row (2026-10-03, user request — "add
  // a tile with the break even year, the profit that year"). Baseline basis
  // (this section IS the baseline estimate): the YEAR of paybackDate, and
  // the profit earned inside that year AFTER the break-even point —
  // cumulative baseline savings at Dec 31 minus the investment (the
  // forecast curve crosses invested exactly at paybackDate).
  const breakEvenYear = data.paybackDate ? new Date(`${data.paybackDate}T00:00:00`).getFullYear() : null;
  // Cumulative baseline savings at a date, walked from the payload's
  // forecastSeries (dates are ISO strings, series is sorted).
  const cumulativeAt = (iso) => {
    let cum = null;
    for (const p of data.forecastSeries ?? []) {
      if (p.date <= iso) cum = p.cumulativeEur;
      else break;
    }
    return cum;
  };
  const breakEvenCumulativeEur =
    data.paybackDate != null ? cumulativeAt(data.paybackDate) : null;
  const breakEvenYearProfitEur = (() => {
    if (breakEvenYear == null) return null;
    const cum = cumulativeAt(`${breakEvenYear}-12-31`);
    return cum != null ? Math.round((cum - data.totalInvestedEur) * 100) / 100 : null;
  })();

  return (
    <div>
      <UpdatedStamp at={updatedAt}>{t("roi.stampSuffix", { tariff: data.tariffEurPerKwh })}</UpdatedStamp>

      <div className="tiles">
        <div className="tile">
          <div className="tile-title">{t("roi.savedSoFar.title")}</div>
          <div className="tile-main">{fmtEur(data.savingsSoFarEur)}</div>
          <div className="tile-sub">
            {t("roi.savedSoFar.sub", { date: fmtDate(data.installDate), days: data.measuredDays })}
          </div>
        </div>
        <div className="tile">
          <div className="tile-title">{t("roi.tracking.title")}</div>
          <div className={`tile-main ${tracking ? (ahead ? "roi-pos" : "roi-neg") : ""}`}>
            {tracking ? `${data.performanceRatioPct}%` : "—"}
          </div>
          <div className="tile-sub">{tracking ? t("roi.tracking.sub") : t("roi.tracking.noData")}</div>
        </div>
        <div className="tile">
          <div className="tile-title roi-baseline-head">
            {t("roi.baseline.title")}
            <button
              className="roi-refresh-btn"
              onClick={recomputeBaseline}
              disabled={refreshing}
              title={t("roi.baseline.refreshTitle")}
            >
              {refreshing ? "…" : "↻"}
            </button>
          </div>
          <div className="tile-main">
            {fmtEur(baseline.avgDailySavingsEur)}
            <span className="roi-perday">{t("roi.perDay")}</span>
          </div>
          <div className="tile-sub">
            {t("roi.baseline.sub", {
              date: fmtDate(baseline.createdAt.slice(0, 10)),
              source: baseline.source === "ai" ? t("roi.baseline.sourceAi") : t("roi.baseline.sourcePvgis"),
            })}
          </div>
          <div className="tile-sub muted">
            {t("roi.baseline.measured", {
              eur: fmtEur(data.measuredAvgDailySavingsEur),
              days: data.measuredDays,
            })}
          </div>
        </div>
        <div className="tile">
          <div className="tile-title">{t("roi.projectedPerYear.title")}</div>
          <div className="tile-main">{fmtEur(data.projectedAnnualSavingsEur)}</div>
          <div className="tile-sub">{t("roi.projectedPerYear.sub")}</div>
        </div>
        <div className="tile">
          <div className="tile-title">{t("roi.payback.title")}</div>
          <div className="tile-main">
            {data.outlookPaybackDate ? fmtDate(data.outlookPaybackDate) : "—"}
          </div>
          <div className="tile-sub">
            {monthsToOutlookPayback != null
              ? t("roi.payback.inMonths", { months: monthsToOutlookPayback })
              : t("roi.payback.never")}
          </div>
          {planDiffers && (
            <div className="tile-sub muted">
              {t("roi.payback.baselinePlan", { date: data.paybackDate ? fmtDate(data.paybackDate) : "—" })}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h4>{t("roi.amortization")}</h4>
        <AmortizationChart data={data} />
        {data.outlookNote && <p className="muted roi-outlook-note">{data.outlookNote}</p>}
      </div>

      <div className="card">
        <div className="roi-bom-head">
          <h4>{t("roi.bom.title")}</h4>
          <a className="roi-pdf-btn" href="/api/roi/bom.pdf" download>
            {t("roi.bom.downloadPdf")}
          </a>
        </div>
        {mainBom.map((r) => (
          <BomRow key={r.asin} r={r} />
        ))}
        <div className="roi-total-row">
          <span>{t("roi.bom.totalInvested")}</span>
          <span className="roi-total">{fmtEur(data.totalInvestedEur)}</span>
        </div>
        <p className="muted">
          {t("roi.bom.pricesNote", {
            date: data.bom.find((r) => r.priceSnapshotDate)?.priceSnapshotDate ?? "n/a",
          })}{" "}
          <span className="roi-est">~</span> {t("roi.bom.estimatedNote")}
        </p>
      </div>

      {extendedBom.length > 0 && (
        <div className="card">
          <h4>{t("roi.extended.title")}</h4>
          {extendedBom.map((r) => (
            <BomRow key={r.asin} r={r} />
          ))}
          <p className="muted">{t("roi.extended.note")}</p>
        </div>
      )}

      <h4>{t("roi.projection.title")}</h4>
      <div className="tiles roi-proj">
        {[
          ...data.projections.map((p) => ({ years: p.years, key: `y${p.years}`, proj: p })),
          ...(data.daysToPayback != null && breakEvenYear != null
            ? [{ years: data.daysToPayback / 365.25, key: "be" }]
            : []),
        ]
          // Break-even tile sorts INTO the year sequence (2026-10-03, user
          // request: "put the break even tile in the right order of years,
          // make it look like the others, just highlighted").
          .sort((a, b) => a.years - b.years)
          .map((entry) =>
            entry.proj ? (
              <div className="tile" key={entry.key}>
                <div className="tile-title">
                  {entry.proj.years} {t(entry.proj.years === 1 ? "roi.projection.year" : "roi.projection.years")}
                </div>
                <div className="tile-main">{fmtEur(entry.proj.cumulativeSavingsEur)}</div>
                <div className={`tile-sub ${entry.proj.profitEur >= 0 ? "roi-pos" : "roi-neg"}`}>
                  {t("roi.projection.profit", {
                    sign: entry.proj.profitEur >= 0 ? "+" : "−",
                    eur: fmtEur(Math.abs(entry.proj.profitEur)),
                  })}
                </div>
              </div>
            ) : (
              <div className="tile roi-be" key={entry.key}>
                <div className="tile-title">
                  {t("roi.projection.breakEven")} {breakEvenYear}
                </div>
                {/* Same shape as the year tiles: cumulative savings at the
                    break-even point (≈ the invested sum by construction),
                    then the profit earned inside that year. */}
                <div className="tile-main">{fmtEur(breakEvenCumulativeEur ?? data.totalInvestedEur)}</div>
                {breakEvenYearProfitEur != null && (
                  <div className={`tile-sub ${breakEvenYearProfitEur >= 0 ? "roi-pos" : "roi-neg"}`}>
                    {/* Same sub-line shape as the year tiles ("+€X profit")
                        — 2026-10-03, user request. */}
                    {t("roi.projection.profit", {
                      sign: breakEvenYearProfitEur >= 0 ? "+" : "−",
                      eur: fmtEur(Math.abs(breakEvenYearProfitEur)),
                    })}
                  </div>
                )}
              </div>
            ),
          )}
      </div>

      <p className="muted">
        {t("roi.assumptions", {
          source: baseline.source === "ai" ? "AI" : "PVGIS",
          date: fmtDate(baseline.createdAt.slice(0, 10)),
          daily: fmtEur(baseline.avgDailySavingsEur),
          kwh: Math.round(baseline.annualPvKwh),
          pct: Math.round(baseline.selfConsumptionRatio * 100),
          tariff: data.tariffEurPerKwh,
          reasoning: baseline.reasoning,
          measured: fmtEur(data.measuredAvgDailySavingsEur),
          days: data.measuredDays,
        })}
      </p>
    </div>
  );
}

// One BOM/extended-list row — shared so both sections render identically
// (thumbnail, name, qty × unit price, line total, "not counted" tag for
// excluded rows).
function BomRow({ r }) {
  const t = useT();
  return (
    <a
      className={`roi-bom-row${r.excluded ? " excluded" : ""}`}
      href={r.url}
      target="_blank"
      rel="noopener noreferrer"
      title={t("roi.bom.viewProduct", { name: r.name })}
    >
      <img className="roi-bom-thumb" src={`/api/roi/image/${r.asin}`} alt="" loading="lazy" />
      <span className="roi-bom-name">
        {r.estimated ? <span className="roi-est">~</span> : null}
        {r.name}
        {r.excluded ? <span className="roi-excl-tag">{t("roi.bom.notCounted")}</span> : null}
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
  const t = useT();
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
          name: t("roi.chart.measured"),
          type: "line",
          showSymbol: false,
          lineStyle: { color: "#5fce80", width: 2 },
          itemStyle: { color: "#5fce80" },
          data: measured,
        },
        {
          name: t("roi.chart.outlook"),
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
              formatter: t("roi.chart.invested", { eur: fmtEur(data.totalInvestedEur) }),
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
                  formatter: t("roi.chart.breakEven", { date: fmtDate(data.outlookPaybackDate) }),
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
    // t in deps: re-render the chart's labels when the language changes.
  }, [data, t]);

  return <div ref={ref} className="roi-chart" />;
}
