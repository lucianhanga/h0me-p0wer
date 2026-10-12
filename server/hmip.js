// HmIP (Homematic IP) meter aggregation (2026-10-12, user request): the
// HmIP bridge exposes per-device metering (power_w instantaneous,
// energy_wh monotonic counter per device, stale_seconds freshness) over a
// plain REST GET. h0me-p0wer polls it and treats ALL devices as ONE
// aggregate consumer named "house light" — surfaced like a site-less plug
// (samples into plug_samples, daily kWh into plug_daily, colorIdx, Consume
// tiles) with zero frontend changes.
//
// Poll cadence 30 s (2026-10-12, user request): the bridge allows 5 s
// reads (they hit its DB, zero radio traffic) but its values update at
// best every ~30 s anyway (≥10 W changes; 2–3 min idle) — polling faster
// than the data can change buys nothing.
// Daily kWh prefers the counter-delta (robust across server downtime); a
// negative delta means a device was re-taught (counter reset) — re-anchor
// and log instead of writing garbage.
//
// Never throws: the consumer simply shows offline/stale when the bridge
// is unreachable or unconfigured (HMIP_API_URL / HMIP_API_KEY in .env).

const SN = "hmip-house-light";
const NAME = "house light";
const POLL_MS = 30 * 1000;
const TIMEOUT_MS = 6000;
const FRESH_S = 180; // a device is stale past 3 min (bridge updates ~30 s best case)

export class HmipPoller {
  constructor({ kvGet, kvSet, onSample, onDailyKwh } = {}) {
    this.kvGet = kvGet;
    this.kvSet = kvSet;
    this.onSample = onSample ?? (() => {});
    this.onDailyKwh = onDailyKwh ?? (() => {});
    this.state = null; // last good aggregate
    this.devices = new Map(); // per-device registry (flip face)
    this.lastError = null;
    this.wasUp = null;
    this.timer = null;
    this.lastDailyWriteAt = 0;
  }

  get configured() {
    return Boolean(process.env.HMIP_API_URL && process.env.HMIP_API_KEY);
  }

  getState() {
    if (!this.configured) return null;
    const fresh = this.state && Date.now() - this.state.ts < FRESH_S * 1000;
    return {
      sn: SN,
      name: NAME,
      tag: "HmIP",
      typeTag: "Aggregate",
      watts: fresh ? this.state.watts : null,
      online: Boolean(fresh),
      external: true,
      ts: this.state?.ts ?? null,
      deviceCount: this.state?.deviceCount ?? 0,
      lastError: fresh ? null : (this.lastError ?? "stale"),
    };
  }

  start() {
    if (!this.configured) {
      console.log("[hmip] HMIP_API_URL/HMIP_API_KEY not set — house-light consumer disabled");
      return;
    }
    this.poll(); // first poll immediately (never rejects)
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  async poll() {
    const url = process.env.HMIP_API_URL;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const resp = await fetch(url, {
        headers: { "X-Api-Key": process.env.HMIP_API_KEY },
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const devices = await resp.json();
      if (!Array.isArray(devices)) throw new Error("unexpected payload (not an array)");
      this.#aggregate(devices);
      if (this.wasUp !== true) {
        this.wasUp = true;
        console.log(`[hmip] bridge up — ${devices.length} metering device(s) aggregated as "${NAME}"`);
      }
    } catch (err) {
      this.lastError = err.message;
      if (this.wasUp !== false) {
        this.wasUp = false;
        console.warn(`[hmip] poll failed: ${err.message}`);
      }
    }
  }

  #aggregate(devices) {
    const ts = Date.now();
    let watts = 0;
    let anyWatts = false;
    const perEnergy = new Map(); // sn -> energy_wh, devices WITH a counter
    const sampleRows = [];
    const seen = new Map();
    for (const d of devices) {
      if (typeof d?.power_w === "number") {
        watts += d.power_w;
        anyWatts = true;
      }
      // Per-device registry + samples (2026-10-12, user request): the
      // aggregate card's flip face lists the sub-consumers with their
      // per-period values — those rows read plug_samples under per-device
      // SNs, which feed nothing else (names for tiles come from plug_daily,
      // untouched, so the devices never become standalone consumers).
      const sn = d?.parent ? `hmip-${d.parent}` : null;
      if (sn) {
        if (typeof d.energy_wh === "number") perEnergy.set(sn, d.energy_wh);
        seen.set(sn, {
          sn,
          name: d.name ?? sn,
          room: d.room ?? "",
          watts: typeof d.power_w === "number" ? d.power_w : null,
          energyWh: typeof d.energy_wh === "number" ? d.energy_wh : null,
          staleS: typeof d.stale_seconds === "number" ? d.stale_seconds : null,
          ts,
        });
        sampleRows.push({ sn, watts: typeof d.power_w === "number" ? d.power_w : null });
      }
    }
    this.devices = seen;
    const energyWh = perEnergy.size ? [...perEnergy.values()].reduce((a, v) => a + v, 0) : null;
    this.state = {
      ts,
      watts: anyWatts ? Math.round(watts * 10) / 10 : null,
      energyWh,
      deviceCount: devices.length,
    };
    this.lastError = null;
    sampleRows.push({ sn: SN, watts: this.state.watts });
    this.onSample(ts, sampleRows);
    if (perEnergy.size) this.#dailyKwh(ts, perEnergy);
  }

  // The aggregate card's flip face: every device seen in the last poll,
  // freshest data the bridge has (independent of the aggregate's own
  // freshness gate).
  getDevices() {
    return this.devices ? [...this.devices.values()] : [];
  }

  // Counter-delta daily kWh with a midnight anchor in kv — robust across
  // server downtime (samples only cover what we're up to see). The anchor
  // is PER DEVICE (2026-10-12 review): summing counters first meant one
  // device missing from a single poll dropped the total, looked like a
  // counter reset, and re-anchored the day — losing the day's energy.
  // Now a missing device simply doesn't contribute to that poll, and a
  // reset (backwards counter) re-anchors only that device.
  #dailyKwh(ts, perEnergy) {
    const date = new Date(ts).toLocaleDateString("sv");
    const anchor = this.kvGet("hmip_energy_anchor")?.value;
    if (anchor?.date !== date) {
      // Day rolled over (or first sighting): finalize the anchored day,
      // then anchor the new one. The first day starts at 0 — the anchor IS
      // the baseline, no history before it exists.
      if (anchor?.date && anchor.per) {
        let deltaWh = 0;
        for (const [sn, aw] of Object.entries(anchor.per)) {
          const cw = perEnergy.get(sn);
          if (typeof cw === "number" && cw >= aw) deltaWh += cw - aw;
        }
        if (deltaWh > 0) this.onDailyKwh(anchor.date, SN, NAME, Math.round(deltaWh / 10) / 100);
      }
      this.kvSet("hmip_energy_anchor", { date, per: Object.fromEntries(perEnergy) });
      return;
    }
    const per = anchor.per ?? {};
    this.lastEnergy ??= new Map();
    let dirty = false;
    for (const [sn, cw] of perEnergy) {
      const aw = per[sn];
      if (aw == null || cw < aw) {
        // New device first seen today, or counter went backwards
        // (re-taught/reset): anchor it now — today's earlier delta for
        // THIS device is lost, not misreported; others are unaffected.
        if (aw != null) console.warn(`[hmip] energy counter reset on ${sn} — re-anchoring`);
        per[sn] = cw;
        dirty = true;
      }
      this.lastEnergy.set(sn, cw);
    }
    if (dirty) this.kvSet("hmip_energy_anchor", { date, per });
    // Today so far = Σ(last-known counter − midnight anchor) over EVERY
    // device seen today. A device missing from this poll keeps its frozen
    // last-known contribution (2026-10-12 review: computing from only the
    // current poll dipped the daily figure whenever a device flaked out).
    let todayWh = 0;
    for (const [sn, cw] of this.lastEnergy) {
      const aw = per[sn];
      if (typeof aw === "number" && cw >= aw) todayWh += cw - aw;
    }
    // Live "today so far" write, throttled to 1/min (readers: /api/plugs
    // todayKwh + the Consume tiles).
    if (ts - this.lastDailyWriteAt < 60 * 1000) return;
    this.lastDailyWriteAt = ts;
    this.onDailyKwh(date, SN, NAME, Math.round(todayWh / 10) / 100);
  }
}
