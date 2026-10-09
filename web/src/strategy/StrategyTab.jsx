import { useEffect, useState } from "react";
import UpdatedStamp from "../components/UpdatedStamp.jsx";
import BatteryTab from "../battery/BatteryTab.jsx";
import { usePolledResource } from "../usePolledResource.js";
import { useT } from "../i18n/LanguageProvider.jsx";

// Strategy tab: choose how the power-plan controller prioritizes PV vs
// battery vs grid. Polls the same GET /api/power-plan PowerPlanCard.jsx uses
// (one poll loop, shared shape). No enable/disable control here on purpose —
// that stays exclusively on the Live tab's Power Plan card; see AGENTS.md.
const STRATEGIES = [
  { key: "house_priority", i18n: "strategy.housePriority" },
  { key: "battery_priority", i18n: "strategy.batteryPriority" },
  { key: "anker_app", i18n: "strategy.ankerApp" },
];
const TRIGGER_DESC_KEY = {
  house_priority: "strategy.housePriority.triggerDesc",
  battery_priority: "strategy.batteryPriority.triggerDesc",
};

// Strategy help modal (2026-09-17, user request): reuses the Ask feature's
// modal chrome (.ask-backdrop/.ask-panel/.ask-close are generic despite the
// name). Explicitly covers Auto vs. Manual too — not just the two
// strategies — since "Manual silently overrides whichever strategy is
// selected" was the exact thing that confused a user this same session.
function StrategyHelp({ onClose }) {
  const t = useT();
  return (
    <div className="ask-backdrop" onClick={onClose}>
      <div className="ask-panel card" onClick={(e) => e.stopPropagation()}>
        <button className="ask-close" onClick={onClose} aria-label={t("ask.close")}>
          ×
        </button>
        <h4 style={{ marginTop: 0 }}>{t("strategy.help.title")}</h4>
        <p>
          <strong>{t("strategy.housePriority.label")}</strong> {t("strategy.help.houseLead")}
        </p>
        <p className="muted">{t("strategy.help.houseUse")}</p>
        <p>
          <strong>{t("strategy.batteryPriority.label")}</strong> {t("strategy.help.batteryLead")}
        </p>
        <p className="muted">{t("strategy.help.batteryUse")}</p>
        <p>
          <strong>{t("strategy.ankerApp.label")}</strong> {t("strategy.help.ankerLead")}
        </p>
        <p className="muted">{t("strategy.help.ankerUse")}</p>
        <h4>{t("strategy.trigger.title")}</h4>
        <p>
          <strong>{t("strategy.trigger.auto")}</strong> {t("strategy.help.autoLead")}
        </p>
        <p>
          <strong>{t("strategy.trigger.manual")}</strong> {t("strategy.help.manualLead")}
        </p>
        <p className="muted">{t("strategy.help.manualNote")}</p>
      </div>
    </div>
  );
}

export default function StrategyTab() {
  const t = useT();
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
  // PIN gate for strategy changes (2026-09-27, user request — the PIN lives
  // server-side in .env STRATEGY_PIN, default 0000): first change per tab
  // session asks for the PIN, then it's kept in sessionStorage. A 403 (e.g.
  // the PIN changed server-side) re-asks with an error.
  const [pendingPatch, setPendingPatch] = useState(null);
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState(false);
  // Lockout state (2026-10-01, user request): after 3 wrong PINs the server
  // blacklists this IP — the modal switches to a locked message instead of
  // re-asking forever.
  const [pinLocked, setPinLocked] = useState(false);
  const [pinAttemptsLeft, setPinAttemptsLeft] = useState(null);

  // Ticks once a second so the step-up hold bar below counts down smoothly
  // between the 10s /api/power-plan polls, instead of jumping in 10s steps.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function postStrategy(patch, pin) {
    const r = await fetch("/api/power-plan/strategy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...patch, pin }),
    });
    const s = await r.json();
    if (r.status === 403) return { pinRejected: true, locked: !!s.locked, attemptsLeft: s.attemptsLeft ?? null };
    if (!r.ok) throw new Error(s.error ?? `HTTP ${r.status}`);
    return { data: s.data };
  }

  function askPin(patch, withError) {
    setPendingPatch(patch);
    setPinError(withError);
    setPinValue("");
  }

  async function setStrategy(patch) {
    const pin = sessionStorage.getItem("strategyPin");
    if (pin == null) return askPin(patch, false);
    setBusy(true);
    try {
      const res = await postStrategy(patch, pin);
      if (res.pinRejected) {
        sessionStorage.removeItem("strategyPin");
        if (res.locked) return setPinLocked(true);
        return askPin(patch, true);
      }
      setState(res.data);
    } catch (err) {
      alert(t("strategy.updateFailed", { error: err.message }));
    } finally {
      setBusy(false);
    }
  }

  async function submitPin() {
    const pin = pinValue.trim();
    if (!pin || !pendingPatch) return;
    setBusy(true);
    try {
      const res = await postStrategy(pendingPatch, pin);
      if (res.pinRejected) {
        if (res.locked) return setPinLocked(true);
        setPinError(true);
        setPinAttemptsLeft(res.attemptsLeft);
        setPinValue("");
        return;
      }
      sessionStorage.setItem("strategyPin", pin);
      setPendingPatch(null);
      setPinError(false);
      setPinAttemptsLeft(null);
      setState(res.data);
    } catch (err) {
      alert(t("strategy.updateFailed", { error: err.message }));
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <p className="muted">{t("common.loading")}</p>;

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

  // (The last-write timestamp renders bottom-right inside the decision
  // cards themselves — see .decision-ts.)

  return (
    <div>
      <UpdatedStamp at={d?.at}>
        {state.enabled ? t("strategy.stamp.active") : t("strategy.stamp.off")}
      </UpdatedStamp>

      <h4 className="strategy-head">
        {t("strategy.title")}
        <button
          className="help-btn"
          onClick={() => setShowHelp(true)}
          title={t("strategy.helpTip")}
          aria-label={t("strategy.helpAria")}
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
            {t(`${s.i18n}.label`)}
          </button>
        ))}
      </div>
      {activeStrategy && <p className="muted">{t(`${activeStrategy.i18n}.desc`)}</p>}
      {!isAnkerApp && (
        <div className="callout-warn">
          <span className="callout-icon">⚠</span>
          <p>
            <strong>{t("strategy.outage.title")}</strong> {t("strategy.outage.body")}
          </p>
        </div>
      )}

      {!isAnkerApp && (
        <>
          <h4>{t("strategy.trigger.title")}</h4>
          <div className="controls">
            <button
              className={state.trigger === "auto" ? "span-active" : ""}
              disabled={busy}
              onClick={() => setStrategy({ trigger: "auto" })}
            >
              {t("strategy.trigger.auto")}
            </button>
            <button
              className={state.trigger === "manual" ? "span-active" : ""}
              disabled={busy}
              onClick={() => setStrategy({ trigger: "manual" })}
            >
              {t("strategy.trigger.manual")}
            </button>
          </div>
          <p className="muted">
            {isManual
              ? t("strategy.trigger.manualOverride")
              : t(TRIGGER_DESC_KEY[state.strategy] ?? TRIGGER_DESC_KEY.house_priority)}
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
              {t("strategy.trigger.discharge")}
            </button>
            <button
              className={!state.manualDischarge ? "span-active" : ""}
              disabled={busy}
              onClick={() => setStrategy({ manualDischarge: false })}
            >
              {t("strategy.trigger.dontDischarge")}
            </button>
          </div>
          <p className="muted">
            {state.manualDischarge
              ? t("strategy.trigger.dischargeDesc", { w: state.gridTargetW ?? 25 })
              : t("strategy.trigger.dontDischargeDesc")}
          </p>
        </>
      )}

      {d && (isAnkerApp || isNative) && (
        <div className="cards cards-single">
          <div className="card decision-card">
            <div className="decision-title">
              {isAnkerApp ? t("strategy.liveNumbers.title") : t("strategy.native.title")}
            </div>
            <div className="decision-reason">
              {d.wrote ? t("strategy.native.modeWritten", { reason: d.reason }) : d.reason}
            </div>
            <div className="decision-metrics">
              <span>
                <span className="decision-metric-label">{t("strategy.metric.pv")}</span>
                <b>{d.pvW} W</b>
              </span>
              <span>
                <span className="decision-metric-label">{t("strategy.metric.house")}</span>
                <b>{d.demandW} W</b>
              </span>
              <span>
                <span className="decision-metric-label">{t("strategy.metric.soc")}</span>
                <b>{d.soc} %</b>
              </span>
            </div>
            {/* Timestamp bottom-right (2026-09-28, user request) — out of
                the reason line so the decision text reads clean. */}
            {state.lastWriteAt && (
              <div className="decision-ts">
                {t("strategy.lastWrite", { time: new Date(state.lastWriteAt).toLocaleTimeString() })}
              </div>
            )}
          </div>
        </div>
      )}

      {d && !isAnkerApp && !isNative && (
        <div className="cards">
          <div className="card">
            <div className="card-label">{t("strategy.decision.targetTitle")}</div>
            <div className="card-value">{d.targetW} W</div>
            <div className="card-label">
              {t("strategy.decision.preset", {
                w: state.lastWrittenPower != null ? `${state.lastWrittenPower} W` : "—",
              })}
            </div>
          </div>
          <div className="card decision-card">
            <div className="card-label">{t("strategy.decision.inputsTitle")}</div>
            <div className="card-value" style={{ fontSize: "1rem" }}>
              {t("strategy.liveLine", { pv: d.pvW, house: d.demandW, soc: d.soc })}
            </div>
            <div className="card-label">
              {d.wrote ? t("strategy.decision.presetWritten", { reason: d.reason }) : d.reason}
            </div>
            {state.lastWriteAt && (
              <div className="decision-ts">
                {t("strategy.lastWrite", { time: new Date(state.lastWriteAt).toLocaleTimeString() })}
              </div>
            )}
          </div>
        </div>
      )}

      {hold && (
        <div className="hold-progress">
          <div className="hold-progress-label">
            <span>{t("strategy.hold.steppingUp", { w: d.targetW })}</span>
            <span>{t("strategy.hold.seconds", { s: holdRemainingS })}</span>
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

      {pendingPatch && (
        <div className="ask-backdrop" onClick={() => setPendingPatch(null)}>
          <div className="ask-panel card" onClick={(e) => e.stopPropagation()}>
            <button className="ask-close" onClick={() => setPendingPatch(null)} aria-label={t("ask.close")}>
              ×
            </button>
            {pinLocked ? (
              <>
                <h4>{t("pin.lockedTitle")}</h4>
                <p className="pin-error">{t("pin.locked")}</p>
                <div className="controls">
                  <button type="button" onClick={() => setPendingPatch(null)}>
                    {t("pin.cancel")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h4>{t("pin.title")}</h4>
                <p className="muted">{t("pin.body")}</p>
                {pinError && (
                  <p className="pin-error">
                    {t("pin.wrong")}
                    {pinAttemptsLeft != null && ` — ${t("pin.attemptsLeft", { n: pinAttemptsLeft })}`}
                  </p>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitPin();
                  }}
                >
                  <input
                    className="pin-input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    autoFocus
                    value={pinValue}
                    onChange={(e) => setPinValue(e.target.value)}
                  />
                  <div className="controls">
                    <button type="submit" disabled={busy || !pinValue.trim()}>
                      {t("pin.submit")}
                    </button>
                    <button type="button" onClick={() => setPendingPatch(null)}>
                      {t("pin.cancel")}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
