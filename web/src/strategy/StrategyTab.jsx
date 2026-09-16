import { useEffect, useRef, useState } from "react";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import BatteryTab from "../battery/BatteryTab.jsx";

// Strategy tab: choose how the power-plan controller prioritizes PV vs
// battery vs grid. Polls the same GET /api/power-plan PowerPlanCard.jsx uses
// (one poll loop, shared shape). No enable/disable control here on purpose —
// that stays exclusively on the Live tab's Power Plan card; see AGENTS.md.
const STRATEGIES = [
  {
    key: "house_priority",
    label: "House priority",
    desc: "The battery continuously tops up the house, leaving only a small grid target — down to the discharge floor plus a safety margin. This is the default, always-on mode.",
  },
  {
    key: "battery_priority",
    label: "Battery priority",
    desc: "PV charges the battery first; the house draws from the grid meanwhile. Once the battery is full (or PV stops), any PV passes straight through to the house — the battery is never discharged under this strategy.",
  },
];
const TRIGGER_DESC = {
  house_priority:
    "Automatically applies House priority's behavior above — the battery keeps topping up the house.",
  battery_priority:
    "Automatically applies Battery priority's behavior above — the battery only ever charges, never discharges.",
};

export default function StrategyTab() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const load = () =>
      fetch("/api/power-plan")
        .then((r) => r.json())
        .then((s) => {
          if (mounted.current) setState(s);
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
  const isManual = state.trigger === "manual";
  const activeStrategy = STRATEGIES.find((s) => s.key === state.strategy);

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
      {activeStrategy && <p className="muted">{activeStrategy.desc}</p>}
      <div className="callout-warn">
        <span className="callout-icon">⚠</span>
        <p>
          <strong>Frequent grid outages?</strong> Prefer Battery priority — House priority
          continuously draws the battery down near its floor as normal behavior, leaving little
          in reserve at any given moment; Battery priority keeps it topped up instead. Without a
          Power Dock accessory, this Solarbank 2 Plus has no dedicated off-grid output of its
          own — check the Anker app to confirm your setup actually delivers stored power during
          an outage before relying on it.
        </p>
      </div>

      <h4>Battery discharge trigger</h4>
      <div className="controls">
        <button
          className={state.trigger === "auto" ? "span-active" : ""}
          disabled={busy}
          onClick={() => setStrategy({ trigger: "auto" })}
        >
          Auto
        </button>
        <button
          className={state.trigger === "manual" ? "span-active" : ""}
          disabled={busy}
          onClick={() => setStrategy({ trigger: "manual" })}
        >
          Manual
        </button>
      </div>
      <p className="muted">
        {isManual
          ? "Manual overrides the distribution strategy above entirely — the toggle below decides, regardless of which strategy is selected."
          : (TRIGGER_DESC[state.strategy] ?? TRIGGER_DESC.house_priority)}
      </p>

      {isManual && (
        <>
          <div className="controls">
            <button
              className={state.manualDischarge ? "span-active" : ""}
              disabled={busy}
              onClick={() => setStrategy({ manualDischarge: true })}
            >
              Discharge
            </button>
            <button
              className={!state.manualDischarge ? "span-active" : ""}
              disabled={busy}
              onClick={() => setStrategy({ manualDischarge: false })}
            >
              Don't discharge
            </button>
          </div>
          <p className="muted">
            {state.manualDischarge
              ? "Battery continuously tops up the house (same behavior as House priority), until you switch this off."
              : "Battery never discharges (same behavior as Battery priority once full) — PV passes through to the house, the rest comes from the grid."}
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
        </div>
      )}

      <BatteryTab />
    </div>
  );
}
