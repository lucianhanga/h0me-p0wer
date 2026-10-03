import { useMemo } from "react";
import { useT } from "../i18n/LanguageProvider.jsx";
import { buildFlowModel } from "../flow/model.js";
import { useTweenedWatts } from "../useTweenedValue.js";

// The artistic view (2026-10-03, user request): the house picture with the
// live energy flow drawn ON it — PV production on the roof, the battery
// stacks as semi-transparent SOC fills (Solarbank 4 left, bigger; Solarbank
// 2 right), both connected to the Power Dock which pushes power to the
// house, and the grid symbol far right. Values come from the SAME
// buildFlowModel the basic diagram uses — the WHAT can never drift, only
// the HOW.
//
// Geometry: percent of the 1536×1024 image (web/public/house.jpg), so it
// scales with any display width while keeping full resolution for zooming.
const PV_POS = { x: 50, y: 18 };
const HOME_POS = { x: 33, y: 46 };
const DOCK_POS = { x: 58.5, y: 70 };
const GRID_POS = { x: 95, y: 68 };

// Battery stack overlays — aligned with the hardware in the picture:
// each rect covers the solarbank AND its BP5000 below it (one fill for
// the unit's total SOC).
const BATT_RECTS = [
  { pn: "AE103", left: 44.5, top: 63, width: 8.5, height: 27 }, // Solarbank 4 (left, bigger)
  { pn: "A17C1", left: 66.5, top: 63, width: 8.5, height: 27 }, // Solarbank 2 Pro (right)
];

// Edge paths in image-percent coordinates (SVG viewBox 0 0 100 100 with
// preserveAspectRatio="none" — plain image percents on both axes).
// Labels are HTML (lx/ly), never SVG text: non-uniform viewBox scaling
// would distort them.
const EDGE_PATHS = {
  "pv-batt": { d: "M 50 26 L 50 55 L 58.5 66", lx: 51.5, ly: 44 },
  "pv-home": { d: "M 44 26 L 44 38 L 36 43", lx: 40, ly: 34 },
  "batt-home": { d: "M 56 65 L 46 52", lx: 49, ly: 55 },
  "home-batt": { d: "M 46 52 L 56 65", lx: 49, ly: 55 },
  "grid-home": { d: "M 96 68 L 81 68", lx: 88, ly: 65 },
  "home-grid": { d: "M 81 68 L 96 68", lx: 88, ly: 65 },
};

// Per-unit connections to the Power Dock (horizontal, into the dock).
const UNIT_EDGE = {
  AE103: { from: { x: 53, y: 70 }, to: { x: 55.5, y: 70 }, lx: 54.2, ly: 66.5 },
  A17C1: { from: { x: 66, y: 70 }, to: { x: 62.5, y: 70 }, lx: 64.2, ly: 66.5 },
};

const lvlColor = (soc) =>
  soc == null ? "#8b98a5" : soc > 90 ? "#6bb8f5" : soc > 50 ? "#5fce80" : soc >= 20 ? "#f7a44f" : "#e5544b";

// HTML edge label — no SVG text distortion, and it tweens like the basic
// variant's labels.
function EdgeLabel({ x, y, watts, color }) {
  const w = useTweenedWatts(watts ?? 0);
  if (w <= 0) return null;
  return (
    <div className="hv-edge-label" style={{ left: `${x}%`, top: `${y}%`, color }}>
      {w} W
    </div>
  );
}

function Edge({ id, def, watts, color }) {
  const active = (watts ?? 0) > 0;
  return (
    <path
      d={def.d}
      fill="none"
      stroke={active ? color : "#2a3238"}
      strokeWidth={active ? 0.7 : 0.5}
      strokeDasharray={active ? "1.6 1.6" : undefined}
      className={active ? "flow-edge-anim" : undefined}
    />
  );
}

// One battery stack: a semi-transparent fill (height = unit SOC) over the
// hardware in the picture, tinted by level, with the flow streak while
// charging/discharging, plus the SOC figure and the unit's name.
function BatteryOverlay({ rect, unit, t }) {
  const soc = unit?.live?.soc ?? null;
  const chargeW = unit?.live?.chargeW ?? 0;
  const cellsW = unit?.live?.cellsW ?? 0;
  const mode = chargeW > cellsW ? "charging" : cellsW > chargeW ? "discharging" : "idle";
  const color = lvlColor(soc);
  return (
    <div
      className="hv-batt"
      style={{ left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
    >
      <div
        className={`hv-batt-fill ${mode === "charging" ? "hv-charging" : mode === "discharging" ? "hv-discharging" : ""}`}
        style={{ height: `${soc ?? 0}%`, background: color }}
      />
      <div className="hv-batt-text" style={{ color }}>
        <span className="hv-batt-soc">{soc != null ? `${Math.round(soc)} %` : "—"}</span>
        <span className="hv-batt-name">{unit?.live?.name ?? rect.pn}</span>
        {mode !== "idle" && (
          <span className="hv-batt-mode">
            {t(`battery.status.${mode}`, { w: `${Math.round(mode === "charging" ? chargeW : cellsW)} W` })}
          </span>
        )}
      </div>
    </div>
  );
}

function Chip({ pos, color, children, align = "center" }) {
  return (
    <div className="hv-chip" style={{ left: `${pos.x}%`, top: `${pos.y}%`, color, transform: `translate(-50%, -50%)`, textAlign: align }}>
      {children}
    </div>
  );
}

export default function HouseView({ flow, params }) {
  const t = useT();
  const model = useMemo(() => buildFlowModel(flow, t), [flow, t]);
  const edgeWatts = useMemo(
    () => Object.fromEntries((model?.edges ?? []).map((e) => [e.id, e.watts])),
    [model],
  );
  const units = (params?.batteries ?? []).filter((b) => b.member && b.live);
  const unitOf = (pn) => units.find((u) => u.live?.pn === pn);
  const d = flow?.diagram;

  return (
    <div className="house-view">
      <img src="/house.jpg" alt={t("simple.houseAlt")} draggable="false" />
      <svg className="hv-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {Object.entries(EDGE_PATHS).map(([id, def]) => {
          const colors = {
            "pv-batt": "#5fce80",
            "pv-home": "#5fce80",
            "batt-home": "#c084fc",
            "home-batt": "#f7a44f",
            "grid-home": "#f7a44f",
            "home-grid": "#f7a44f",
          };
          return <Edge key={id} id={id} def={def} watts={edgeWatts[id] ?? 0} color={colors[id]} />;
        })}
        {/* Per-unit flows into the Power Dock: discharge = unit → dock,
            charge = dock → unit. */}
        {BATT_RECTS.map((rect) => {
          const u = unitOf(rect.pn);
          const geo = UNIT_EDGE[rect.pn];
          const chargeW = u?.live?.chargeW ?? 0;
          const cellsW = u?.live?.cellsW ?? 0;
          const discharging = cellsW > chargeW && cellsW > 0;
          const charging = chargeW > 0 && chargeW >= cellsW;
          const w = discharging ? cellsW : charging ? chargeW : 0;
          const from = discharging ? geo.from : geo.to;
          const to = discharging ? geo.to : geo.from;
          return (
            <path
              key={rect.pn}
              d={`M ${from.x} ${from.y} L ${to.x} ${to.y}`}
              fill="none"
              stroke={w > 0 ? "#c084fc" : "#2a3238"}
              strokeWidth={w > 0 ? 0.7 : 0.5}
              strokeDasharray={w > 0 ? "1.6 1.6" : undefined}
              className={w > 0 ? "flow-edge-anim" : undefined}
            />
          );
        })}
      </svg>

      {/* HTML edge labels (outside the distorted SVG coordinate space). */}
      {Object.entries(EDGE_PATHS).map(([id, def]) => {
        const colors = {
          "pv-batt": "#5fce80",
          "pv-home": "#5fce80",
          "batt-home": "#c084fc",
          "home-batt": "#f7a44f",
          "grid-home": "#f7a44f",
          "home-grid": "#f7a44f",
        };
        return <EdgeLabel key={id} x={def.lx} y={def.ly} watts={edgeWatts[id] ?? 0} color={colors[id]} />;
      })}
      {BATT_RECTS.map((rect) => {
        const u = unitOf(rect.pn);
        const geo = UNIT_EDGE[rect.pn];
        const chargeW = u?.live?.chargeW ?? 0;
        const cellsW = u?.live?.cellsW ?? 0;
        const w = cellsW > chargeW ? cellsW : chargeW > 0 ? chargeW : 0;
        return <EdgeLabel key={rect.pn} x={geo.lx} y={geo.ly} watts={w} color="#c084fc" />;
      })}

      {BATT_RECTS.map((rect) => (
        <BatteryOverlay key={rect.pn} rect={rect} unit={unitOf(rect.pn)} t={t} />
      ))}

      <Chip pos={PV_POS} color="#5fce80">
        <div className="hv-chip-label">{t("flow.pv")}</div>
        <div className="hv-chip-value">{d?.pvW != null ? `${Math.round(d.pvW)} W` : "—"}</div>
      </Chip>
      <Chip pos={HOME_POS} color="#e8ecef">
        <div className="hv-chip-label">{t("flow.home")}</div>
        <div className="hv-chip-value">{d?.homeW != null ? `${Math.round(d.homeW)} W` : "—"}</div>
      </Chip>
      <Chip pos={DOCK_POS} color="#8b98a5">
        <div className="hv-chip-label hv-dock-label">{t("flow.powerDock")}</div>
      </Chip>
      <Chip pos={GRID_POS} color="#f7a44f">
        <div className="hv-chip-label">{t("flow.grid")}</div>
      </Chip>
    </div>
  );
}
