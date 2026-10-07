import SectionTitle from "../components/SectionTitle.jsx";
import ConsumersPeriodCard from "../components/ConsumersPeriodCard.jsx";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";

// Simple view's Consume section (2026-10-07, user request): like Totals —
// one tile per period (day / week / month) — but split by consumer. The
// tiles (components/ConsumersPeriodCard.jsx, shared with the Dashboard)
// round-robin ring → bars → list and navigate the past. The whole section
// hides on plug-less accounts.
export default function ConsumersSection() {
  const t = useT();
  // Section-level probe: hides the whole Consume section on plug-less
  // accounts (cards fetch their own type/offset afterwards).
  const { data } = usePolledResource("/api/stats/consumers?type=day&offset=0", {
    intervalMs: 60000,
    keepLastGoodOnError: true,
  });
  if (!data?.plugs?.length) return null;

  return (
    <>
      <SectionTitle>{t("nav.plugs")}</SectionTitle>
      <div className="simple-periods">
        <ConsumersPeriodCard type="day" title={t("dashboard.today")} />
        <ConsumersPeriodCard type="week" title={t("dashboard.thisWeek")} />
        <ConsumersPeriodCard type="month" title={t("dashboard.thisMonth")} />
        <ConsumersPeriodCard type="year" title={t("dashboard.thisYear")} />
      </div>
    </>
  );
}
