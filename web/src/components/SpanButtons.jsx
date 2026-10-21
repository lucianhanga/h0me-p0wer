import { SHORTCUTS } from "../graph/spans.js";

export default function SpanButtons({ active, onSelect, t }) {
  return SHORTCUTS.map((s) => (
    <button
      key={s.labelKey}
      className={active === s.ms ? "span-active" : ""}
      onClick={() => onSelect(s.ms)}
    >
      {t(s.labelKey)}
    </button>
  ));
}
