import { useEffect, useState } from "react";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import BatteryTab from "../battery/BatteryTab.jsx";
import { usePolledResource } from "../usePolledResource.js";

// Strategy tab: choose how the power-plan controller prioritizes PV vs
// battery vs grid. Polls the same GET /api/power-plan PowerPlanCard.jsx uses
// (one poll loop, shared shape). No enable/disable control here on purpose —
// that stays exclusively on the Live tab's Power Plan card; see AGENTS.md.
const STRATEGIES = [
  {
    key: "house_priority",
    label: "House priority",
    desc: "The device runs Anker's native Self-Consumption Mode: it follows the smart meter locally and covers house demand from PV + battery first — sub-second, zero export, exactly like the Anker app. h0me-p0wer only switches the mode on and monitors; the SOC limits from the Anker app apply. This is the default mode.",
  },
  {
    key: "battery_priority",
    label: "Battery priority",
    desc: "PV charges the battery first; the house draws from the grid meanwhile. Once the battery is full, PV alone is ramped toward the house's demand (leaving a small grid margin) — the battery is never discharged under this strategy, so a full battery stays full.",
  },
  {
    key: "anker_app",
    label: "Anker app",
    desc: "h0me-p0wer writes nothing — the device runs whatever schedule you've configured directly in the Anker mobile app. Unlike turning the power plan off entirely (Live tab), this keeps everything else — live numbers, the Strategy tab itself — active; it just stops overwriting the preset, so anything you set in the Anker app stays in effect.",
  },
];
const TRIGGER_DESC = {
  house_priority:
    "Automatically applies House priority's behavior above — the device's native self-consumption mode.",
  battery_priority:
    "Automatically applies Battery priority's behavior above — the battery only ever charges, never discharges.",
};

// Strategy help modal (2026-09-17, user request): reuses the Ask feature's
// modal chrome (.ask-backdrop/.ask-panel/.ask-close are generic despite the
// name). Explicitly covers Auto vs. Manual too — not just the two
// strategies — since "Manual silently overrides whichever strategy is
// selected" was the exact thing that confused a user this same session.
function StrategyHelp({ onClose }) {
  return (
    <div className="ask-backdrop" onClick={onClose}>
      <div className="ask-panel card" onClick={(e) => e.stopPropagation()}>
        <button className="ask-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h4 style={{ marginTop: 0 }}>Distribution strategies</h4>
        <p>
          <strong>House priority</strong> — the device runs Anker's native Self-Consumption Mode:
          it follows the smart meter locally and covers house demand from PV + battery first,
          sub-second, with zero export — exactly like the Anker app. h0me-p0wer only switches the
          mode on and monitors; the SOC limits configured in the Anker app apply (the 25 W grid
          target and floor margin are only used by the preset-based modes below). This is the
          default mode.
        </p>
        <p className="muted">
          Use it for everyday operation: minimize grid import continuously, with the fastest
          possible reaction — the device itself regulates, not the cloud.
        </p>
        <p>
          <strong>Battery priority</strong> — while the battery isn't full, PV is deliberately
          withheld from the house so it charges the battery instead; house demand is covered from
          the grid meanwhile. Once the battery is full, PV alone is ramped toward the house's
          demand (leaving a small grid margin) — the battery itself is never discharged under this
          strategy, so a full battery stays full.
        </p>
        <p className="muted">
          Use it to prioritize a full battery — e.g. ahead of expected grid outages, or to bank
          today's sun rather than spend it immediately.
        </p>
        <p>
          <strong>Anker app</strong> — h0me-p0wer writes nothing at all; the device runs whatever
          schedule you've set directly in the Anker mobile app. Different from turning the whole
          power plan off on the Live tab: that restores a one-time snapshot from whenever this app
          first took over, which goes stale the moment you edit anything afterward. This mode never
          writes, so your Anker-app settings stay in effect for as long as you leave it selected.
        </p>
        <p className="muted">
          Use it when you want to hand control back to Anker's own automation (e.g. its AI mode) or
          test a manual schedule there without this app fighting you over it.
        </p>
        <h4>Battery discharge trigger</h4>
        <p>
          <strong>Auto</strong> — the strategy selected above decides continuously.
        </p>
        <p>
          <strong>Manual</strong> — a fixed Discharge / Don't discharge toggle overrides whichever
          strategy is selected, until you switch it back to Auto.
        </p>
        <p className="muted">
          Manual fully replaces the strategy pick above while it's active — a common source of
          confusion if you forget it's on. If the battery isn't behaving like your selected
          strategy, check here first. Doesn't apply to Anker app mode — there's nothing for it to
          override there, since h0me-p0wer isn't writing anything.
        </p>
      </div>
    </div>
  );
}

export default function StrategyTab() {
  // Same endpoint, same 10s cadence as Live tab's PowerPlanCard.jsx — was
  // two independently hand-rolled poll loops before this migration; still
  // two separate requests (this hook doesn't dedupe across components,
  // just the code), but see AGENTS.md for why that's an intentionally
  // separate concern from what this item scoped in.
  const { data: state, setData: setState } = usePolledResource("/api/power-plan", {
    intervalMs: 10000,
  });
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showHelp, setShowHelp] = useState(false);

  // Ticks once a second so the step-up hold bar below counts down smoothly
  // between the 10s /api/power-plan polls, instead of jumping in 10s steps.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
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
      setState(s.data);
    } catch (err) {
      alert(`Strategy update failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <p className="muted">loading…</p>;

  const d = state.lastDecision;
  const isAnkerApp = state.strategy === "anker_app";
  // Native self-consumption: house_priority + auto — the decision came from
  // the native path (no preset writes), so the target/preset cards don't
  // apply; show the same live-numbers card as Anker app mode instead.
  const isNative = !isAnkerApp && d?.nativeMode === true;
  const isManual = !isAnkerApp && state.trigger === "manual";
  const activeStrategy = STRATEGIES.find((s) => s.key === state.strategy);

  // Step-up hold countdown: the controller found a higher target but is
  // deliberately waiting out STEP_UP_HOLD_MS before writing it (anti-wobble
  // hysteresis — see server/power-plan.js). Recomputed every tick of nowMs
  // so the bar fills smoothly rather than jumping once per 10s poll.
  const hold = d?.holdProgress;
  let holdPct = 0;
  let holdRemainingS = 0;
  if (hold && d?.at) {
    const startedAt = d.at - hold.heldMs;
    const elapsedMs = Math.min(hold.totalMs, Math.max(0, nowMs - startedAt));
    holdPct = Math.min(100, (elapsedMs / hold.totalMs) * 100);
    holdRemainingS = Math.max(0, Math.ceil((hold.totalMs - elapsedMs) / 1000));
  }

  return (
    <div>
      <UpdatedStamp at={d?.at}>
        {state.enabled ? "power plan active" : "power plan off — set on the Live tab"}
      </UpdatedStamp>

      <h4 className="strategy-head">
        Distribution strategy
        <button
          className="help-btn"
          onClick={() => setShowHelp(true)}
          title="What do these strategies do?"
          aria-label="Strategy help"
        >
          ?
        </button>
      </h4>
      {showHelp && <StrategyHelp onClose={() => setShowHelp(false)} />}
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
      {!isAnkerApp && (
        <div className="callout-warn">
          <span className="callout-icon">⚠</span>
          <p>
            <strong>Frequent grid outages?</strong> Prefer Battery priority — it keeps the battery
            topped up instead of continuously drawing it down near its floor, so there's more
            charge in reserve whenever the grid actually goes out.
          </p>
        </div>
      )}

      {!isAnkerApp && (
        <>
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
        </>
      )}

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
              ? `Battery continuously tops up the house via preset control, leaving ~${state.gridTargetW ?? 25} W from the grid, until you switch this off.`
              : "Battery never discharges (same behavior as Battery priority once full) — PV passes through to the house, the rest comes from the grid."}
          </p>
        </>
      )}

      {d && (isAnkerApp || isNative) && (
        <div className="cards">
          <div className="card">
            <div className="card-label">
              {isAnkerApp ? "Live numbers (not being written)" : "Native self-consumption active"}
            </div>
            <div className="card-value" style={{ fontSize: "1rem" }}>
              PV {d.pvW} W · house {d.demandW} W · SOC {d.soc}%
            </div>
            <div className="card-label">
              {d.wrote ? `mode written (${d.reason})` : d.reason}
              {state.lastWriteAt ? ` · last write ${new Date(state.lastWriteAt).toLocaleTimeString()}` : ""}
            </div>
          </div>
        </div>
      )}

      {d && !isAnkerApp && !isNative && (
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

      {hold && (
        <div className="hold-progress">
          <div className="hold-progress-label">
            <span>Stepping up to {d.targetW} W</span>
            <span>{holdRemainingS}s</span>
          </div>
          <div className="hold-progress-track">
            <div className="hold-progress-fill" style={{ width: `${holdPct}%` }} />
          </div>
        </div>
      )}

      {/* In native self-consumption (house_priority + auto) the device
          enforces its own Anker-app discharge cutoff with no app-side
          margin — the gauge's floor marker must show that, not the
          preset-path margin that only battery_priority / manual use. */}
      <BatteryTab
        dischargeTolerancePct={
          state.strategy === "house_priority" && state.trigger === "auto"
            ? 0
            : state.dischargeTolerancePct
        }
      />
    </div>
  );
}
