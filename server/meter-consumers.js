import { MeterPoller } from "./modbus.js";
import { upsertPlugDailyRow, plugDayKwhFromSamples } from "./db.js";

// Appliance consumers on the second Smart Meter (h-solar-meter-multi-1,
// AE1X0 at METER_MULTI_IP, Modbus TCP enabled 2026-10-18): each phase of
// that meter feeds a different appliance, so per-phase active power maps
// directly to consumers (user's assignment):
//   L1         → microwave
//   L2 + L3    → heating (underfloor pump + district-heat device)
// Data rides the SAME plug machinery as the smart plugs and the HmIP
// "house light" aggregate: per-consumer watts in plug_samples (7-day
// retention → power curves + Rest-of-home math) and daily kWh in plug_daily
// (forever → Consume tiles, /api/plugs todayKwh).
const CONSUMERS = [
  { sn: "meter-multi-microwave", name: "microwave", phases: [0] },
  { sn: "meter-multi-heating", name: "heating", phases: [1, 2] },
];

const DAY_MS = 86400000;

export class MeterConsumers {
  constructor({ host, port = 502, pollIntervalMs = 5000, onSample }) {
    this.host = host;
    this.onSample = onSample;
    this.poller = new MeterPoller(host, port, {
      pollIntervalMs,
      // Connect-read-disconnect per cycle — leaves the meter's single
      // Modbus connection free for the Anker app/other clients.
      transient: true,
    });
    this.poller.onSnapshot((state) => this.#handle(state));
    this.dailyTimer = null;
    this.lastDailyWriteDay = null;
  }

  start() {
    this.poller.start();
    // Daily kWh upserts once a minute (cheap, same pattern as the site-less
    // plugs): today's running total + yesterday's final total on rollover.
    this.dailyTimer = setInterval(() => this.#writeDaily(), 60 * 1000);
    this.dailyTimer.unref();
  }

  stop() {
    this.poller.stop();
    if (this.dailyTimer) clearInterval(this.dailyTimer);
    // Finalize the last day's numbers on shutdown.
    this.#writeDaily();
  }

  getStates() {
    const { snapshot, connected } = this.poller.getState();
    return CONSUMERS.map((c) => {
      const watts = snapshot ? this.#wattsFor(c, snapshot) : null;
      return {
        sn: c.sn,
        name: c.name,
        tag: "Meter",
        typeTag: "Phases",
        watts,
        online: Boolean(snapshot),
        external: false, // plain consumer card (not an aggregate flip)
        ts: snapshot?.timestamp ? new Date(snapshot.timestamp).getTime() : null,
        meterConnected: connected,
      };
    });
  }

  #wattsFor(c, snapshot) {
    const w = c.phases.reduce((a, i) => a + (snapshot.primary?.phases?.[i]?.power ?? 0), 0);
    // Negative phase power means export (not an appliance load) — clamp at 0.
    return Math.max(0, Math.round(w * 10) / 10);
  }

  #handle(state) {
    if (!state.snapshot) return;
    const ts = Date.now();
    const rows = CONSUMERS.map((c) => ({ sn: c.sn, watts: this.#wattsFor(c, state.snapshot) }));
    try {
      this.onSample(ts, rows);
    } catch (err) {
      console.warn("[meter-consumers] failed to persist samples:", err.message);
    }
  }

  #writeDaily() {
    const now = new Date();
    const today = now.toLocaleDateString("sv");
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(dayStart.getTime() - DAY_MS);
    for (const c of CONSUMERS) {
      try {
        // Today's running kWh from the samples (trapezoid + gap clamp).
        upsertPlugDailyRow(today, c.sn, c.name, plugDayKwhFromSamples(c.sn, dayStart.getTime(), now.getTime()));
        // On the first write of a new day, also finalize yesterday.
        if (this.lastDailyWriteDay && this.lastDailyWriteDay !== today) {
          upsertPlugDailyRow(
            this.lastDailyWriteDay,
            c.sn,
            c.name,
            plugDayKwhFromSamples(c.sn, yesterdayStart.getTime(), dayStart.getTime()),
          );
        }
      } catch (err) {
        console.warn("[meter-consumers] daily kWh write failed:", err.message);
      }
    }
    this.lastDailyWriteDay = today;
  }
}
