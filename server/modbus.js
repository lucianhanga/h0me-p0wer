import ModbusRTU from "modbus-serial";
import { BATCH_RANGES, REGISTERS, METER_TYPE_NAMES, decodeValue } from "./registers.js";

const POLL_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 10000;

const MODBUS_HINT =
  "Enable Modbus TCP in the Anker app: Smart Meter Gen 2 -> Settings -> " +
  "Three-Party Control Settings -> Modbus TCP";

export class MeterPoller {
  constructor(host, port = 502) {
    this.host = host;
    this.port = port;
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
    return {
      connected: this.connected,
      error: this.connected ? null : this.lastError,
      hint: this.connected ? null : MODBUS_HINT,
      snapshot: this.snapshot,
    };
  }

  async start() {
    this.stopped = false;
    await this.connect();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
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
    if (this.stopped) return;
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
        timestamp: new Date().toISOString(),
        meter: {
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
    } catch (err) {
      this.connected = false;
      this.lastError = `read failed (${err.message})`;
      console.warn(`[modbus] ${this.lastError}, reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
      try {
        this.client.close(() => {});
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }

    this.emit();
  }
}
