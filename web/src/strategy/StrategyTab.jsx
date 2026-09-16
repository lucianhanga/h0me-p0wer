import { useEffect, useRef, useState } from "react";
import UpdatedStamp from "../components/UpdatedStamp.jsx";

// Strategy tab: choose how the power-plan controller prioritizes PV vs
// battery vs grid. Polls the same GET /api/power-plan PowerPlanCard.jsx uses
// (one poll loop, shared shape). No enable/disable control here on purpose —
// that stays exclusively on the Live tab's Power Plan card; see AGENTS.md.
const STRATEGIES = [
  { key: "house_priority", label: "House priority" },
  { key: "battery_priority", label: "Battery priority" },
  { key: "grid_zero_besteffort", label: "Grid ≈ 0 (best effort)" },
];
const TRIGGERS = [
  { key: "pv_zero", label: "Until PV = 0" },
  { key: "grid_zero", label: "Immediately (keep grid ≈ 0)" },
];

export default function StrategyTab() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toleranceDraft, setToleranceDraft] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const load = () =>
      fetch("/api/power-plan")
        .then((r) => r.json())
        .then((s) => {
          if (!mounted.current) return;
          setState(s);
          setToleranceDraft((d) => (d === "" ? String(s.tolerancePct ?? 3) : d));
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, []);

  async function setStrategy(patch) {
    setBusy(true);
    try {
      const r = await fetch("/api/power-plan/strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const s = await r.json();
      if (!r.ok) throw new Error(s.error ?? `HTTP ${r.status}`);
      setState(s);
    } catch (err) {
      alert(`Strategy update failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <p className="muted">loading…</p>;

  const d = state.lastDecision;
  const isGridZero = state.strategy === "grid_zero_besteffort";
  const effectiveFloor =
    d?.dischargeFloorPct != null ? d.dischargeFloorPct + (d.tolerancePct ?? 3) : null;

  return (
    <div>
      <UpdatedStamp at={d?.at}>
        {state.enabled ? "power plan active" : "power plan off — set on the Live tab"}
      </UpdatedStamp>

      <h4>Distribution strategy</h4>
      <div className="controls">
        {STRATEGIES.map((s) => (
          <button
            key={s.key}
            className={state.strategy === s.key ? "span-active" : ""}
            disabled={busy}
            onClick={() => setStrategy({ strategy: s.key })}
          >
            {s.label}
          </button>
        ))}
      </div>

      {!isGridZero && (
        <>
          <h4>Discharge trigger</h4>
          <div className="controls">
            {TRIGGERS.map((t) => (
              <button
                key={t.key}
                className={state.trigger === t.key ? "span-active" : ""}
                disabled={busy}
                onClick={() => setStrategy({ trigger: t.key })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </>
      )}

      {isGridZero && (
        <>
          <h4>Tolerance above the discharge floor</h4>
          <div className="controls">
            <input
              type="number"
              min="0"
              max="20"
              step="1"
              value={toleranceDraft}
              onChange={(e) => setToleranceDraft(e.target.value)}
            />
            <button
              disabled={busy}
              onClick={() => setStrategy({ tolerancePct: Number(toleranceDraft) })}
            >
              Save
            </button>
          </div>
          <p className="muted">
            Stops discharging at (discharge floor + tolerance) instead of the account's own
            floor — a safety margin since this strategy ignores the normal reserve guard.
          </p>
        </>
      )}

      {d && (
        <div className="cards">
          <div className="card">
            <div className="card-label">Target output</div>
            <div className="card-value">{d.targetW} W</div>
            <div className="card-label">
              preset {state.lastWrittenPower != null ? `${state.lastWrittenPower} W` : "—"}
            </div>
          </div>
          <div className="card">
            <div className="card-label">Decision inputs</div>
            <div className="card-value" style={{ fontSize: "1rem" }}>
              PV {d.pvW} W · house {d.demandW} W · SOC {d.soc}%
            </div>
            <div className="card-label">
              {d.wrote ? `preset written (${d.reason})` : d.reason}
              {state.lastWriteAt ? ` · last write ${new Date(state.lastWriteAt).toLocaleTimeString()}` : ""}
            </div>
          </div>
          <div className="card">
            <div className="card-label">
              {state.strategy === "battery_priority" ? "Charge ceiling" : "Discharge floor"}
            </div>
            {state.strategy === "battery_priority" ? (
              <>
                <div className="card-value">{d.chargeCeilingPct}%</div>
                <div className="card-label">{d.atChargeCeiling ? "at ceiling — serving house" : "charging"}</div>
              </>
            ) : isGridZero ? (
              <>
                <div className="card-value">{effectiveFloor}%</div>
                <div className="card-label">floor {d.dischargeFloorPct}% + tolerance {d.tolerancePct}%</div>
              </>
            ) : (
              <>
                <div className="card-value">{d.dischargeFloorPct}%</div>
                <div className="card-label">account's configured reserve</div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
