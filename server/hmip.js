// HmIP (Homematic IP) meter aggregation (2026-10-12, user request): the
// HmIP bridge exposes per-device metering (power_w instantaneous,
// energy_wh monotonic counter per device, stale_seconds freshness) over a
// plain REST GET. h0me-p0wer polls it and treats ALL devices as ONE
// aggregate consumer named "house light" — surfaced like a site-less plug
// (samples into plug_samples, daily kWh into plug_daily, colorIdx, Consume
// tiles) with zero frontend changes.
//
// Poll cadence 10 s: the bridge allows 5 s (reads hit its DB, zero radio
// traffic) but values update at best every ~30 s — 10 s is gentle and
// plenty. Daily kWh prefers the counter-delta (robust across server
// downtime); a negative delta means a device was re-taught (counter
// reset) — re-anchor and log instead of writing garbage.
//
// Never throws: the consumer simply shows offline/stale when the bridge
// is unreachable or unconfigured (HMIP_API_URL / HMIP_API_KEY in .env).

const SN = "hmip-house-light";
const NAME = "house light";
const POLL_MS = 10 * 1000;
const TIMEOUT_MS = 6000;
const FRESH_S = 180; // a device is stale past 3 min (bridge updates ~30 s best case)

export class HmipPoller {
  constructor({ kvGet, kvSet, onSample, onDailyKwh } = {}) {
    this.kvGet = kvGet;
    this.kvSet = kvSet;
    this.onSample = onSample ?? (() => {});
    this.onDailyKwh = onDailyKwh ?? (() => {});
    this.state = null; // last good aggregate
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
    let energyWh = 0;
    let anyEnergy = false;
    for (const d of devices) {
      if (typeof d?.power_w === "number") {
        watts += d.power_w;
        anyWatts = true;
      }
      if (typeof d?.energy_wh === "number") {
        energyWh += d.energy_wh;
        anyEnergy = true;
      }
    }
    this.state = {
      ts,
      watts: anyWatts ? Math.round(watts * 10) / 10 : null,
      energyWh: anyEnergy ? energyWh : null,
      deviceCount: devices.length,
    };
    this.lastError = null;
    this.onSample(ts, SN, this.state.watts);
    if (anyEnergy) this.#dailyKwh(ts, energyWh);
  }

  // Counter-delta daily kWh with a midnight anchor in kv — robust across
  // server downtime (samples only cover what we're up to see).
  #dailyKwh(ts, energyWh) {
    const date = new Date(ts).toLocaleDateString("sv");
    const anchor = this.kvGet("hmip_energy_anchor")?.value;
    if (anchor?.date !== date) {
      // Day rolled over (or first sighting): finalize the anchored day,
      // then anchor the new one. The first day starts at 0 — the anchor IS
      // the baseline, no history before it exists.
      if (anchor?.date && typeof anchor.wh === "number" && energyWh >= anchor.wh) {
        this.onDailyKwh(anchor.date, SN, NAME, Math.round((energyWh - anchor.wh) / 10) / 100);
      }
      this.kvSet("hmip_energy_anchor", { date, wh: energyWh });
      return;
    }
    if (energyWh < anchor.wh) {
      // Counter went backwards — a device was re-taught/reset. Re-anchor;
      // today's earlier delta is lost, not misreported.
      console.warn("[hmip] energy counter reset — re-anchoring");
      this.kvSet("hmip_energy_anchor", { date, wh: energyWh });
      return;
    }
    // Live "today so far" write, throttled to 1/min (readers: /api/plugs
    // todayKwh + the Consume tiles).
    if (ts - this.lastDailyWriteAt < 60 * 1000) return;
    this.lastDailyWriteAt = ts;
    this.onDailyKwh(date, SN, NAME, Math.round((energyWh - anchor.wh) / 10) / 100);
  }
}
