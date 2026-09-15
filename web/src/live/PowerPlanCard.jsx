import { useEffect, useRef, useState } from "react";

// Power Plan card: shows the controller state and lets the user take over /
// hand back the Solarbank output preset. Disabling restores the exact
// schedule the device had before the controller was enabled.
export default function PowerPlanCard() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const load = () =>
      fetch("/api/power-plan")
        .then((r) => r.json())
        .then((s) => mounted.current && setState(s))
        .catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, []);

  const act = async (action) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/power-plan/${action}`, { method: "POST" });
      const s = await r.json();
      if (!r.ok) throw new Error(s.error ?? `HTTP ${r.status}`);
      setState(s);
    } catch (err) {
      alert(`Power plan ${action} failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const d = state?.lastDecision;
  return (
    <div className="power-plan">
      <div className="power-plan-head">
        <h3>Power Plan</h3>
        {state?.enabled ? (
          <button disabled={busy} onClick={() => act("disable")}>
            {state.canRestore ? "Disable & restore Anker schedule" : "Disable"}
          </button>
        ) : (
          <button disabled={busy} onClick={() => act("enable")}>
            Take over output control
          </button>
        )}
      </div>
      <p className="muted">
        {state == null
          ? "loading…"
          : state.enabled
            ? "Active — the app sets the battery output preset."
            : "Off — the Anker app schedule is in control."}
      </p>
      {state?.enabled && d && (
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
              {state.lastWriteAt
                ? ` · last write ${new Date(state.lastWriteAt).toLocaleTimeString()}`
                : ""}
            </div>
          </div>
        </div>
      )}
      {state?.lastError && <p className="muted">last error: {state.lastError}</p>}
    </div>
  );
}
