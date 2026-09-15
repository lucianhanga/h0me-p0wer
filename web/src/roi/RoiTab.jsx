import { useEffect, useRef, useState } from "react";
import echarts from "../echarts.js";
import UpdatedStamp from "../components/UpdatedStamp.jsx";

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
// (measured, DB only), and when the savings cross the investment.
export default function RoiTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);

  useEffect(() => {
    const load = () => {
      fetch("/api/roi")
        .then((r) => r.json())
        .then((res) => {
          if (!res.ok) throw new Error(res.error);
          setData(res.data);
          setUpdatedAt(new Date());
        })
        .catch((e) => setError(String(e.message ?? e)));
    };
    load();
    const timer = setInterval(load, 300000); // daily-grain data; 5 min is plenty
    return () => clearInterval(timer);
  }, []);

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <p className="muted">loading…</p>;

  const monthsToPayback = data.paybackDate
    ? Math.max(
        0,
        Math.round((new Date(`${data.paybackDate}T12:00:00`).getTime() - Date.now()) / (30.44 * DAY_MS)),
      )
    : null;

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
          <div className="tile-title">Avg per day</div>
          <div className="tile-main">{fmtEur(data.avgDailySavingsEur)}</div>
          <div className="tile-sub">measured average</div>
        </div>
        <div className="tile">
          <div className="tile-title">Projected per year</div>
          <div className="tile-main">{fmtEur(data.projectedAnnualSavingsEur)}</div>
          <div className="tile-sub">avg × 365</div>
        </div>
        <div className="tile">
          <div className="tile-title">Payback</div>
          <div className="tile-main">{data.paybackDate ? fmtDate(data.paybackDate) : "—"}</div>
          <div className="tile-sub">
            {monthsToPayback != null ? `in ${monthsToPayback} months` : "no savings measured yet"}
          </div>
        </div>
      </div>

      <div className="card">
        <h4>Amortization</h4>
        <AmortizationChart data={data} />
      </div>

      <div className="card">
        <div className="roi-bom-head">
          <h4>Investment (bill of materials)</h4>
          <a className="roi-pdf-btn" href="/api/roi/bom.pdf" download>
            Download PDF
          </a>
        </div>
        {data.bom.map((r) => (
          <a
            className={`roi-bom-row${r.excluded ? " excluded" : ""}`}
            key={r.asin}
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`${r.name} — open on Amazon`}
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

      <h4>Projection (at the measured daily average)</h4>
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
        Assumptions: constant tariff €{data.tariffEurPerKwh}/kWh, no panel degradation, savings =
        avoided grid import (PV direct-to-home + battery cells discharge), projection = measured
        daily average over {data.measuredDays} days. Today is excluded (unfinished).
      </p>
    </div>
  );
}

// Cumulative savings vs. investment: solid line = measured days, dashed =
// projection at the measured daily average; orange dashed = total invested;
// marker = break-even (payback date).
function AmortizationChart({ data }) {
  const ref = useRef(null);

  useEffect(() => {
    const measured = data.series.map((s) => [
      new Date(`${s.date}T00:00:00`).getTime(),
      s.cumulativeEur,
    ]);
    const last = measured.length
      ? measured[measured.length - 1]
      : [new Date(`${data.installDate}T00:00:00`).getTime(), 0];

    // Projection horizon: a bit past payback, else one year out.
    let endMs;
    if (data.paybackDate) {
      const paybackMs = new Date(`${data.paybackDate}T00:00:00`).getTime();
      endMs = paybackMs + Math.max(30 * DAY_MS, 0.1 * (paybackMs - last[0]));
    } else {
      endMs = last[0] + 365 * DAY_MS;
    }
    const projection = [last];
    for (let t = last[0] + DAY_MS, v = last[1]; t <= endMs; t += DAY_MS) {
      v = Math.round((v + data.avgDailySavingsEur) * 100) / 100;
      projection.push([t, v]);
    }

    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: { top: 28, right: 16, bottom: 8, left: 8, containLabel: true },
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
          name: "Projection",
          type: "line",
          showSymbol: false,
          lineStyle: { color: "#5fce80", width: 2, type: "dashed", opacity: 0.7 },
          itemStyle: { color: "#5fce80" },
          data: projection,
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
          markPoint: data.paybackDate
            ? {
                symbol: "circle",
                symbolSize: 9,
                itemStyle: { color: "#f7a44f" },
                label: {
                  formatter: `break-even\n${fmtDate(data.paybackDate)}`,
                  color: "#e8ecef",
                  fontSize: 10,
                  position: "top",
                },
                data: [
                  {
                    coord: [
                      new Date(`${data.paybackDate}T00:00:00`).getTime(),
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
