// Config-drift watchdog (2026-10-09, user request — worry: someone taking
// over the Anker cloud account and silently changing device settings). The
// account is a remote write-channel into the house's power system that
// cannot be closed from our side (the devices always listen to Anker's
// cloud MQTT), so the defense here is DETECTION: snapshot the
// security-relevant settings, notice when they change without us, and
// alert through the existing activity channel (ActivityBell) within
// seconds (plugs) to minutes (schedule).
//
// Watched in v1:
//   - battery schedule (param_type 6, read every SCHEDULE_CHECK_MS —
//     ~0.3 req/min, no rate-limit pressure),
//   - smart-plug membership (sn + name + tag; rides the existing scene
//     poll at zero extra cost). Plug on/off state is NOT watched: the
//     scene parse only gives connectivity, and watts are telemetry, not
//     settings.
//   - SOC floors were already covered by floor_changed in
//     battery-params.js before this module existed.
//
// Self-change attribution: our own write paths (power-plan's preset
// writes and its restore-on-disable) call adoptSchedule() with exactly
// what they wrote, which updates the baseline and opens a short grace
// window in which BOTH the old and the new value are accepted — the
// cloud takes a moment to propagate a write, and without the grace the
// next read would "detect" our own write's old value as drift.
//
// No auto-rollback: a drift can also be the owner's own legitimate
// Anker-app change, and auto-reverting would fight them. The UI offers
// explicit PIN-protected accept (adopt the new config as baseline) and
// revert (write the baseline schedule back) actions instead.

const KV_KEY = "config_watchdog";
export const SCHEDULE_CHECK_MS = 5 * 60 * 1000;
const WRITE_GRACE_MS = 3 * 60 * 1000;

// Canonical comparison for JSON blobs whose key order the cloud may
// reshuffle between reads — sorted recursive stringify.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// Compact human-facing summary of a schedule for the activity entry.
function summarizeSchedule(parsed) {
  const plan = parsed?.custom_rate_plan?.[0];
  const powers = (plan?.ranges ?? []).map((r) => r.power);
  return {
    mode: parsed?.mode_type ?? null,
    powers,
    reservedSoc: parsed?.reserved_soc ?? null,
  };
}

function summaryText(s) {
  if (!s) return "?";
  return `mode ${s.mode}, ${s.powers.join("/")} W, reserve ${s.reservedSoc}%`;
}

export class ConfigWatchdog {
  constructor({ readSchedule, writeSchedule, kvGet, kvSet, activity, now = () => Date.now() }) {
    this.readSchedule = readSchedule;
    this.writeSchedule = writeSchedule;
    this.kvGet = kvGet;
    this.kvSet = kvSet;
    this.activity = activity;
    this.now = now;
    this.lastScheduleCheckAt = 0;
    // Last values actually observed on the device/cloud — accept() adopts
    // these as the new baseline.
    this.observed = { schedule: null, scheduleSummary: null, plugs: null, accountPlugs: null };
    const saved = kvGet(KV_KEY)?.value;
    this.state = saved ?? {
      baseline: { schedule: null, scheduleSummary: null, plugs: null },
      pending: [], // [{field, at, from, to}]
      alerted: {}, // field -> canonical value last alerted for (alert-once)
      grace: null, // {prevSchedule, until}
    };
  }

  save() {
    try {
      this.kvSet(KV_KEY, this.state);
    } catch {
      /* kv write failed — non-fatal, next change retries */
    }
  }

  drift(field, from, to) {
    const entry = { field, at: this.now(), from, to };
    this.state.pending = [...this.state.pending.filter((p) => p.field !== field), entry];
    this.activity("config_drift", { field, from, to });
  }

  // --- schedule (5-min cadence, gated internally so the caller can tick often)

  async checkSchedule({ force = false } = {}) {
    if (!force && this.now() - this.lastScheduleCheckAt < SCHEDULE_CHECK_MS) return;
    this.lastScheduleCheckAt = this.now();
    const { parsed } = await this.readSchedule();
    const canon = stableStringify(parsed);
    const summary = summarizeSchedule(parsed);
    this.observed.schedule = canon;
    this.observed.scheduleSummary = summary;
    const b = this.state.baseline;
    if (b.schedule === null) {
      // First ever read — silently adopt whatever the device currently
      // holds as the trusted baseline.
      b.schedule = canon;
      b.scheduleSummary = summary;
      this.save();
      return;
    }
    if (canon === b.schedule) {
      // Back in sync (or never drifted) — a pending schedule drift that
      // reverted itself clears, and our own write's propagation ended.
      if (this.state.alerted.schedule !== undefined || this.state.grace) {
        this.state.alerted.schedule = undefined;
        this.state.grace = null;
        this.state.pending = this.state.pending.filter((p) => p.field !== "schedule");
        this.save();
      }
      return;
    }
    const g = this.state.grace;
    if (g && this.now() < g.until && canon === g.prevSchedule) return; // write still propagating
    if (this.state.alerted.schedule === canon) return; // already alerted for this exact value
    this.state.alerted.schedule = canon;
    this.drift("schedule", summaryText(b.scheduleSummary), summaryText(summary));
    this.save();
  }

  // --- plug membership (called on every scene poll)

  onScene(info) {
    if (!info?.plugs) return;
    const plugs = {};
    for (const p of info.plugs) plugs[p.sn] = { name: p.name ?? "", tag: p.tag ?? "" };
    this.observed.plugs = plugs;
    const b = this.state.baseline;
    if (b.plugs === null) {
      b.plugs = plugs;
      this.save();
      return;
    }
    const changes = [];
    for (const [sn, cur] of Object.entries(plugs)) {
      const old = b.plugs[sn];
      if (!old) changes.push(`plug added: ${cur.name || sn}`);
      else if (old.name !== cur.name) changes.push(`plug renamed: ${old.name} → ${cur.name}`);
    }
    for (const [sn, old] of Object.entries(b.plugs)) {
      if (!plugs[sn]) changes.push(`plug removed: ${old.name || sn}`);
    }
    if (!changes.length) return;
    const canon = stableStringify(plugs);
    if (this.state.alerted.plugs === canon) return;
    this.state.alerted.plugs = canon;
    this.drift("plugs", `${Object.keys(b.plugs).length} plug(s)`, changes.join("; "));
    this.save();
  }

  // --- account-level plug membership (site-less plugs, 2026-10-10):
  // Anker caps a system at 10 Gen-2 plugs, so extras live on the account
  // without a site — they never pass through onScene(). Same membership
  // watch, separate baseline, fed by the 15-min bind_devices discovery.

  onAccountPlugs(plugs) {
    if (!plugs) return;
    const map = {};
    for (const p of plugs) map[p.sn] = { name: p.name ?? "" };
    const b = this.state.baseline;
    if (b.accountPlugs === undefined) b.accountPlugs = null; // legacy states
    if (b.accountPlugs === null) {
      b.accountPlugs = map;
      this.save();
      return;
    }
    this.observed.accountPlugs = map;
    const changes = [];
    for (const [sn, cur] of Object.entries(map)) {
      const old = b.accountPlugs[sn];
      if (!old) changes.push(`account plug added: ${cur.name || sn}`);
      else if (old.name !== cur.name) changes.push(`plug renamed: ${old.name} → ${cur.name}`);
    }
    for (const [sn, old] of Object.entries(b.accountPlugs)) {
      if (!map[sn]) changes.push(`plug removed from account: ${old.name || sn}`);
    }
    if (!changes.length) return;
    const canon = stableStringify(map);
    if (this.state.alerted.accountPlugs === canon) return;
    this.state.alerted.accountPlugs = canon;
    this.drift("accountPlugs", `${Object.keys(b.accountPlugs).length} on account`, changes.join("; "));
    this.save();
  }

  // --- self-change attribution: our own writers report what they wrote

  adoptSchedule(raw) {
    let canon = null;
    try {
      canon = stableStringify(JSON.parse(raw));
    } catch {
      return; // unparseable — better no baseline update than a corrupt one
    }
    const b = this.state.baseline;
    this.state.grace = { prevSchedule: b.schedule, until: this.now() + WRITE_GRACE_MS };
    b.schedule = canon;
    try {
      b.scheduleSummary = summarizeSchedule(JSON.parse(raw));
    } catch {
      /* summary stays stale — cosmetic only */
    }
    this.state.alerted.schedule = undefined;
    this.state.pending = this.state.pending.filter((p) => p.field !== "schedule");
    this.save();
  }

  // --- owner actions (PIN checked by the routes, not here)

  // Adopt the currently observed config as the new trusted baseline.
  accept() {
    const b = this.state.baseline;
    if (this.observed.schedule) {
      b.schedule = this.observed.schedule;
      b.scheduleSummary = this.observed.scheduleSummary;
    }
    if (this.observed.plugs) b.plugs = this.observed.plugs;
    if (this.observed.accountPlugs) b.accountPlugs = this.observed.accountPlugs;
    this.state.pending = [];
    this.state.alerted = {};
    this.state.grace = null;
    this.save();
  }

  // Write the baseline schedule back to the device. Plugs have no write
  // path in this codebase, so revert covers the schedule only.
  async revertSchedule() {
    const b = this.state.baseline;
    if (!b.schedule) throw new Error("no baseline schedule to revert to");
    await this.writeSchedule(JSON.parse(b.schedule));
    // The device's current (drifted) value becomes the "previous" for the
    // grace window, so propagation lag of OUR revert doesn't re-alert.
    this.state.grace = { prevSchedule: this.observed.schedule, until: this.now() + WRITE_GRACE_MS };
    this.state.alerted.schedule = undefined;
    this.state.pending = this.state.pending.filter((p) => p.field !== "schedule");
    this.save();
  }

  getState() {
    const b = this.state.baseline;
    return {
      baselineSet: b.schedule !== null || b.plugs !== null,
      baseline: { schedule: b.scheduleSummary, plugs: b.plugs },
      pending: this.state.pending,
      lastScheduleCheckAt: this.lastScheduleCheckAt,
    };
  }
}
