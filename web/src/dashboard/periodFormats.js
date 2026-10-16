// Shared bar-label formatters for the period tiles (Dashboard's SourceCard
// flip side, the simple view's Totals/Consume tiles). They MUST be
// module-level constants (2026-10-16, user report — "the tooltip closes
// after 1-2 s"): the chart components (BackBars, ConsumerBars) dispose and
// re-init ECharts whenever a prop changes identity, and an inline arrow
// here is a NEW function on every render — under the WS live push (1-3 Hz)
// that meant a chart re-init on every push, killing the open tooltip.
// All four use the browser locale ([]), so they never need rebuilding.
export const FMT_HOUR_MIN = (l) => new Date(l).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const FMT_WEEKDAY = (l) => new Date(`${l}T12:00:00`).toLocaleDateString([], { weekday: "short" });
export const FMT_DAY_OF_MONTH = (l) => (typeof l === "string" ? l.slice(8) : l);
export const FMT_MONTH_NAME = (l) => new Date(`${l}-15T12:00:00`).toLocaleDateString([], { month: "short" });

// ConsumersPeriodCard picks by period type.
export const PERIOD_FORMAT = {
  day: FMT_HOUR_MIN,
  week: FMT_WEEKDAY,
  month: FMT_DAY_OF_MONTH,
  year: FMT_MONTH_NAME,
};
