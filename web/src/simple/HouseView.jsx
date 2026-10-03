import { useMemo } from "react";
import { useT } from "../i18n/LanguageProvider.jsx";
import { buildFlowModel } from "../flow/model.js";
import { useTweenedWatts } from "../useTweenedValue.js";

// The artistic view (2026-10-03, user request): the house picture with the
// live energy flow drawn ON it — animated along the connections ALREADY
// PAINTED in the picture (iteration 2, user request): the two roof cable
// bundles feed the solarbanks directly, each solarbank connects to the
// Power Dock, the dock's own vertical cable feeds the house, and the
// junction → meter → pylon chain on the right is the grid. Values come
// from the SAME buildFlowModel the basic diagram uses — the WHAT can
// never drift, only the HOW.
//
// Geometry: percent of the 1536×1024 image (web/public/house.jpg), traced
// against the painted hardware at native resolution. The SVG uses
// viewBox 0 0 100 100 preserveAspectRatio="none", so all coordinates are
// plain image percents; labels are HTML (SVG text would distort).
const PV_POS = { x: 50, y: 18 };
const HOME_POS = { x: 33, y: 46 };
const GRID_POS = { x: 95.5, y: 75.5 };

// Battery stack overlays — each rect covers the solarbank AND its BP5000
// below it in the picture (one fill for the unit's total SOC).
const BATT_RECTS = [
  { pn: "AE103", left: 43, top: 69.3, width: 8.8, height: 21.5 }, // Solarbank 4 (left, bigger)
  { pn: "A17C1", left: 66.5, top: 70.5, width: 8.7, height: 20.3 }, // Solarbank 2 Pro (right)
];

// The painted roof cable bundles (verified against the user's highlighted
// pictures 2026-10-03): left → Solarbank 4 Pro, right → Solarbank 2 —
// each with the bend where it curves from the roof edge into the
// vertical wall run.
const PV_CABLES = [
  { pn: "AE103", d: "M 46.5 36.8 L 47 37.5 Q 47.3 38 47.3 39.2 L 47.3 69.3", lx: 43.5, ly: 52 },
  { pn: "A17C1", d: "M 69.5 32.7 L 70.6 33.2 Q 71.4 33.5 71.4 34.7 L 71.4 70.5", lx: 74.5, ly: 52 },
];

// Each solarbank's own cable to the Power Dock — the UPPER (red) cables
// of the picture; the LOWER (blue-marked) pair is deliberately not drawn
// (user's annotated image 2026-10-03: blue = not required to display).
const UNIT_EDGE = {
  AE103: { d: "M 52.1 72.3 Q 54 75 55.7 74.2", dRev: "M 55.7 74.2 Q 54 75 52.1 72.3", lx: 53.8, ly: 69.5 },
  A17C1: { d: "M 66.4 69.8 Q 64 71.5 61.5 72.3", dRev: "M 61.5 72.3 Q 64 71.5 66.4 69.8", lx: 64, ly: 68.5 },
};

// The dock's own vertical wall cable (x ≈ 58.4) — it carries
// EVERYTHING between the battery system and the house, so the three
// logical flows run as hair-offset parallel dashes on it: PV→home (green,
// up), battery→home (purple, up), home→battery = grid charging (orange,
// down).
const DOCK_CABLE = {
  "pv-home": { d: "M 58.1 69.3 L 58.1 55", color: "#5fce80", lx: 54.5, ly: 57 },
  "batt-home": { d: "M 58.7 69.3 L 58.7 55", color: "#c084fc", lx: 62, ly: 57 },
  "home-batt": { d: "M 58.4 55 L 58.4 69.3", color: "#f7a44f", lx: 58.4, ly: 50.5 },
};

// The grid chain on the right: SB2 → house junction box → meter → pylon.
const GRID_EDGE = {
  "grid-home": { d: "M 96.5 71 L 79.5 71", color: "#f7a44f", lx: 87.5, ly: 67.8 },
  "home-grid": { d: "M 79.5 71 L 96.5 71", color: "#f7a44f", lx: 87.5, ly: 67.8 },
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

function Cable({ d, watts, color }) {
  const active = (watts ?? 0) > 0;
  return (
    <path
      d={d}
      fill="none"
      stroke={active ? color : "#2a3238"}
      strokeWidth={active ? 0.7 : 0.5}
      strokeLinecap="round"
      strokeDasharray={active ? "1.6 1.6" : undefined}
      className={active ? "flow-edge-anim" : undefined}
    />
  );
}

// One battery stack: a semi-transparent fill (height = unit SOC) over the
// hardware in the picture, tinted by level, with the flow sheen while
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

function Chip({ pos, color, children }) {
  return (
    <div className="hv-chip" style={{ left: `${pos.x}%`, top: `${pos.y}%`, color, transform: "translate(-50%, -50%)" }}>
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
      <img src="/house.png" alt={t("simple.houseAlt")} draggable="false" />
      <svg className="hv-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {/* The painted roof cables: PV DC into each solarbank (the unit's
            own pvW — what the panels on its strings deliver right now). */}
        {PV_CABLES.map((c) => (
          <Cable key={c.pn} d={c.d} watts={unitOf(c.pn)?.live?.pvW ?? 0} color="#5fce80" />
        ))}
        {/* Each solarbank ↔ Power Dock: discharge = unit → dock,
            charge = dock → unit. */}
        {BATT_RECTS.map((rect) => {
          const u = unitOf(rect.pn);
          const geo = UNIT_EDGE[rect.pn];
          const chargeW = u?.live?.chargeW ?? 0;
          const cellsW = u?.live?.cellsW ?? 0;
          const discharging = cellsW > chargeW && cellsW > 0;
          const w = discharging ? cellsW : chargeW > 0 ? chargeW : 0;
          // d = unit → dock (discharging), dRev = dock → unit (charging).
          return <Cable key={rect.pn} d={discharging ? geo.d : geo.dRev} watts={w} color="#c084fc" />;
        })}
        {/* The dock's vertical house cable: the three logical flows as
            parallel dashes. */}
        {Object.entries(DOCK_CABLE).map(([id, def]) => (
          <Cable key={id} d={def.d} watts={edgeWatts[id] ?? 0} color={def.color} />
        ))}
        {/* Grid chain: junction → meter → pylon (dominant direction). */}
        {Object.entries(GRID_EDGE).map(([id, def]) => (
          <Cable key={id} d={def.d} watts={edgeWatts[id] ?? 0} color={def.color} />
        ))}
      </svg>

      {/* HTML labels (outside the distorted SVG coordinate space). */}
      {PV_CABLES.map((c) => (
        <EdgeLabel key={c.pn} x={c.lx} y={c.ly} watts={unitOf(c.pn)?.live?.pvW ?? 0} color="#5fce80" />
      ))}
      {BATT_RECTS.map((rect) => {
        const u = unitOf(rect.pn);
        const geo = UNIT_EDGE[rect.pn];
        const chargeW = u?.live?.chargeW ?? 0;
        const cellsW = u?.live?.cellsW ?? 0;
        const w = cellsW > chargeW ? cellsW : chargeW > 0 ? chargeW : 0;
        return <EdgeLabel key={rect.pn} x={geo.lx} y={geo.ly} watts={w} color="#c084fc" />;
      })}
      {Object.entries({ ...DOCK_CABLE, ...GRID_EDGE }).map(([id, def]) => (
        <EdgeLabel key={id} x={def.lx} y={def.ly} watts={edgeWatts[id] ?? 0} color={def.color} />
      ))}

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
      <Chip pos={GRID_POS} color="#f7a44f">
        <div className="hv-chip-label">{t("flow.grid")}</div>
      </Chip>
    </div>
  );
}
