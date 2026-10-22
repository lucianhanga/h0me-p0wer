import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";
import Glyph from "../components/Glyph.jsx";

// "Running now" (2026-10-22, user request): the tail of the simple view's
// first section — one AI-written sentence on which big appliances are
// currently running (washing machine, dryer, dishwasher, cooking…). The
// server regenerates the sentence ONLY on start/end transitions; the per-
// consumer watt chips refresh with each 30 s poll. Hidden when nothing big
// is running (no placeholder noise).
export default function RunningNow() {
  const t = useT();
  const { data } = usePolledResource("/api/big-consumers", {
    intervalMs: 30000,
    keepLastGoodOnError: true,
  });
  if (!data?.available) return null;
  return (
    <div className="running-now">
      <Glyph name="home" size={16} className="running-now-icon" />
      <span className="running-now-text">{data.text ?? t("simple.runningNow")}</span>
      <span className="running-now-chips">
        {(data.active ?? []).map((c) => (
          <span key={c.name} className="running-now-chip">
            {c.name} {c.watts} W
          </span>
        ))}
      </span>
    </div>
  );
}
