import ModbusRTU from "modbus-serial";
import { BATCH_RANGES, REGISTERS, METER_TYPE_NAMES, decodeValue } from "./registers.js";

const RETRY_DELAY_MS = 3000; // wait after a failed cycle (both modes)

const MODBUS_HINT =
  "Enable Modbus TCP in the Anker app: Smart Meter Gen 2 -> Settings -> " +
  "Three-Party Control Settings -> Modbus TCP";

export class MeterPoller {
  // transient=true: connect-read-disconnect each cycle instead of holding a
  // permanent connection — lets two instances (dev + prod) share the meter's
  // single Modbus connection by only occupying it ~1 s per poll.
  constructor(host, port = 502, { pollIntervalMs = 5000, transient = false } = {}) {
    this.host = host;
    this.port = port;
    this.pollIntervalMs = pollIntervalMs;
    this.transient = transient;
    this.client = new ModbusRTU();
    this.connected = false;
    this.snapshot = null; // last successful reading
    this.lastError = null; // last error message, when not connected
    this.listeners = new Set();
    this.timer = null;
    this.stopped = false;
  }

  onSnapshot(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.getState());
  }

  getState() {
    // In transient mode the socket closes after every poll, so "connected"
    // can't mean "socket open" — it must mean "healthy": a successful read
    // within the last ~2 poll cycles. Otherwise the UI flaps between
    // offline/online between polls.
    const healthy = this.transient
      ? this.lastSuccessAt != null &&
        Date.now() - this.lastSuccessAt < 2.2 * this.pollIntervalMs
      : this.connected;
    return {
      connected: healthy,
      error: healthy ? null : this.lastError,
      hint: healthy ? null : MODBUS_HINT,
      snapshot: this.snapshot,
    };
  }

  async start() {
    this.stopped = false;
    this.loop();
  }

  // Poll loop as a setTimeout chain: cycle → (disconnect) → wait interval →
  // next cycle. On failure, retry after RETRY_DELAY_MS instead of a full
  // interval. No overlapping polls by construction.
  async loop() {
    if (this.stopped) return;
    this.lastCycleOk = false;
    try {
      await this.poll();
    } finally {
      const delay = this.lastCycleOk ? this.pollIntervalMs : RETRY_DELAY_MS;
      this.timer = setTimeout(() => this.loop(), delay);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.disconnect();
  }

  disconnect() {
    try {
      this.client.close(() => {});
    } catch {
      /* already closed */
    }
  }

  async connect() {
    if (this.stopped) return;
    try {
      this.client = new ModbusRTU();
      await this.client.connectTCP(this.host, { port: this.port });
      this.client.setID(1);
      this.client.setTimeout(5000);
      if (!this.connected) {
        console.log(`[modbus] connected to ${this.host}:${this.port}`);
      }
      this.connected = true;
      this.lastError = null;
    } catch (err) {
      this.connected = false;
      this.lastError = `cannot connect to ${this.host}:${this.port} (${err.message})`;
      console.warn(`[modbus] ${this.lastError}`);
      console.warn(`[modbus] ${MODBUS_HINT}`);
    }
  }

  async poll() {
    if (this.stopped || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.doPoll();
    } finally {
      this.pollInFlight = false;
    }
  }

  async doPoll() {
    if (!this.connected) {
      await this.connect();
      if (!this.connected) this.emit();
      return;
    }

    try {
      // Read all batch ranges into a single address -> value map.
      const values = new Map();
      for (const [start, end] of BATCH_RANGES) {
        const res = await this.client.readInputRegisters(start, end - start + 1);
        res.data.forEach((v, i) => values.set(start + i, v));
      }

      const decoded = {};
      for (const [key, cfg] of Object.entries(REGISTERS)) {
        const regs = [];
        for (let i = 0; i < cfg.count; i++) {
          regs.push(values.get(cfg.address + i) ?? 0);
        }
        let v = decodeValue(cfg.type, regs);
        if (typeof v === "number" && cfg.gain !== 1) v = v / cfg.gain;
        decoded[key] = v;
      }

      this.snapshot = {
        timestamp: new Date().toISOString(),        meter: {
          model: decoded.meter_model,
          sn: decoded.meter_sn,
          type: METER_TYPE_NAMES[decoded.meter_type] ?? `unknown (${decoded.meter_type})`,
          swVersion: decoded.meter_sw_version,
        },
        primary: {
          totalPower: decoded.primary_total_active_power,
          phases: [1, 2, 3].map((n) => ({
            power: decoded[`primary_phase_${n}_active_power`],
            current: decoded[`primary_phase_${n}_current`],
            voltage: decoded[`primary_phase_${n}_voltage`],
          })),
        },
        secondary: {
          totalPower: decoded.secondary_total_active_power,
          phases: [1, 2, 3].map((n) => ({
            power: decoded[`secondary_phase_${n}_active_power`],
            current: decoded[`secondary_phase_${n}_current`],
            voltage: decoded[`secondary_phase_${n}_voltage`],
          })),
        },
      };
      this.lastError = null;
      this.lastSuccessAt = Date.now();
      this.lastCycleOk = true;
    } catch (err) {
      this.connected = false;
      this.lastError = `read failed (${err.message})`;
      console.warn(`[modbus] ${this.lastError}, retrying in ${RETRY_DELAY_MS / 1000}s`);
      this.disconnect();
    } finally {
      // Transient mode: release the meter after every cycle so a second
      // instance can have its turn.
      if (this.transient) {
        this.disconnect();
        this.connected = false;
      }
    }

    this.emit();
  }
}
