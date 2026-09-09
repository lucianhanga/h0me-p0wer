// Register map for the Anker SOLIX Smart Meter Gen 2 (product codes DNSL/DNSM,
// marketed as AE1X0). Taken from Anker's official Home Assistant integration
// device config. Registers are input registers (FC04), big-endian word order;
// the decoded raw value is divided by `gain`.

export const BATCH_RANGES = [
  [10620, 10646],
  [10666, 10677],
  [10696, 10712],
];

// key -> { address, type, gain, count, unit }
export const REGISTERS = {
  meter_model: { address: 10620, type: "STRING", gain: 1, count: 10, unit: "" },
  meter_type: { address: 10630, type: "UINT16", gain: 1, count: 1, unit: "" },
  meter_sw_version: { address: 10696, type: "VERSION", gain: 1, count: 2, unit: "" },
  meter_sn: { address: 10702, type: "STRING", gain: 1, count: 10, unit: "" },

  primary_total_active_power: { address: 10644, type: "INT32", gain: 1, count: 2, unit: "W" },
  primary_phase_1_active_power: { address: 10638, type: "INT32", gain: 1, count: 2, unit: "W" },
  primary_phase_1_current: { address: 10635, type: "INT16", gain: 100, count: 1, unit: "A" },
  primary_phase_1_voltage: { address: 10632, type: "UINT16", gain: 10, count: 1, unit: "V" },
  primary_phase_2_active_power: { address: 10640, type: "INT32", gain: 1, count: 2, unit: "W" },
  primary_phase_2_current: { address: 10636, type: "INT16", gain: 100, count: 1, unit: "A" },
  primary_phase_2_voltage: { address: 10633, type: "UINT16", gain: 10, count: 1, unit: "V" },
  primary_phase_3_active_power: { address: 10642, type: "INT32", gain: 1, count: 2, unit: "W" },
  primary_phase_3_current: { address: 10637, type: "INT16", gain: 100, count: 1, unit: "A" },
  primary_phase_3_voltage: { address: 10634, type: "UINT16", gain: 10, count: 1, unit: "V" },

  secondary_total_active_power: { address: 10675, type: "INT32", gain: 1, count: 2, unit: "W" },
  secondary_phase_1_active_power: { address: 10669, type: "INT32", gain: 1, count: 2, unit: "W" },
  secondary_phase_1_current: { address: 10666, type: "INT16", gain: 100, count: 1, unit: "A" },
  secondary_phase_1_voltage: { address: 10632, type: "UINT16", gain: 10, count: 1, unit: "V" },
  secondary_phase_2_active_power: { address: 10671, type: "INT32", gain: 1, count: 2, unit: "W" },
  secondary_phase_2_current: { address: 10667, type: "INT16", gain: 100, count: 1, unit: "A" },
  secondary_phase_2_voltage: { address: 10633, type: "UINT16", gain: 10, count: 1, unit: "V" },
  secondary_phase_3_active_power: { address: 10673, type: "INT32", gain: 1, count: 2, unit: "W" },
  secondary_phase_3_current: { address: 10668, type: "INT16", gain: 100, count: 1, unit: "A" },
  secondary_phase_3_voltage: { address: 10634, type: "UINT16", gain: 10, count: 1, unit: "V" },
};

export const METER_TYPE_NAMES = {
  1: "single_phase",
  2: "three_phase",
};

// Decode a slice of input registers into a JS value.
// `regs` are the raw 16-bit register values starting at the quantity's address.
export function decodeValue(type, regs) {
  switch (type) {
    case "UINT16":
      return regs[0];
    case "INT16": {
      const raw = regs[0] & 0xffff;
      return raw < 0x8000 ? raw : raw - 0x10000;
    }
    case "INT32":
      // JS bitwise ops yield a signed 32-bit result directly — no manual
      // two's-complement step (applying it again double-offsets negatives
      // into -4.29e9 garbage).
      return (regs[0] << 16) | regs[1];
    case "UINT32":
      // Avoid bitwise ops here: they would reinterpret as signed.
      return regs[0] * 0x10000 + regs[1];
    case "VERSION": {
      const bytes = [];
      for (const reg of regs.slice(0, 2)) {
        bytes.push((reg >> 8) & 0xff, reg & 0xff);
      }
      return bytes.slice(0, 4).join(".");
    }
    case "STRING": {
      const bytes = [];
      for (const reg of regs) {
        bytes.push((reg >> 8) & 0xff, reg & 0xff);
      }
      return Buffer.from(bytes).toString("utf8").replace(/\0+$/, "");
    }
    default:
      return regs[0];
  }
}
