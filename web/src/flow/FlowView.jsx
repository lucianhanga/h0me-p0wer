import { useMemo } from "react";
import { useT } from "../i18n/LanguageProvider.jsx";
import { buildFlowModel } from "./model.js";
import BasicVariant from "./variants/basic.jsx";

// The generic live-flow control (2026-09-29, user request: "design a
// control for the graph and reuse it in both view types — a generic one
// which can be specialized"). ONE component renders the flow diagram
// everywhere (expert Live tab, simple view). The WHAT (channels, nodes,
// edges) is model.js; the HOW (positions, shapes, icons, animation) is a
// VARIANT — registered below. Specializing = adding a new entry to
// VARIANTS (e.g. an artistic variant with icon nodes) — the model and the
// data path never change.
const VARIANTS = {
  basic: BasicVariant,
};

export default function FlowView({ flow, variant = "basic" }) {
  const t = useT();
  const model = useMemo(() => buildFlowModel(flow, t), [flow, t]);
  if (!model) return <p className="muted">{t("common.loading")}</p>;
  const Renderer = VARIANTS[variant] ?? BasicVariant;
  return <Renderer model={model} />;
}
