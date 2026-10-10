import mqtt from "mqtt";

// Realtime battery (Solarbank) monitoring over Anker's AWS-IoT-style MQTT,
// the same channel the Anker mobile app uses — replaces 30 s REST polling
// with ~3-5 s push telemetry. Protocol facts from the community client
// (thomluther/anker-solix-api); quirks noted inline.

// Wire envelope: every MQTT payload is JSON, {head: {...}, payload: "<json>"},
// and the inner payload's `data` is the base64-encoded binary device message.
// The binary message layout (header + TLV fields + XOR checksum):
//   FF 09    fixed Anker Solix prefix
//   XX XX    total message length, LE, INCLUDING the trailing checksum byte
//   03 0x 0f pattern (03 00 0f = send, 03 01 0f = receive)
//   XX XX    message type (04 05 = Solarbank 2 telemetry, 00 57 = realtime trigger)
//   XX       optional increment byte (absent when byte 9 is a field name a0-a9)
//   fields   TLV: 1-byte name (a1..fe), 1-2 byte LE length (includes the type
//            byte), optional 1-byte type tag (< 0x10), value bytes
//   XX       XOR checksum over all preceding bytes
// Value type tags: 00 str, 01 ui (1B), 02 sile (2B signed LE), 03 var
// (4B signed LE), 04 bin, 05 sfle (4B float LE).
const MSGTYPE_TELEMETRY = "0405";
const MSGTYPE_REALTIME_TRIGGER = "0057";
// 040a = Solarbank 2 EXPANSION data (param_info topic): per-pack SOC/SOH/
// temperature/SN for up to 5 expansion batteries (community _A17C1_040a).
// Only streams while the realtime trigger is active (the trigger we already
// re-send every 4 min for 0405 covers it).
const MSGTYPE_EXPANSION = "040a";

// Field map for message 0405 on A17C3 (Solarbank 2 E1600 Plus) — shared with
// A17C1 in the community SOLIXMQTTMAP (_A17C1_0405). factor: raw × factor.
// SEMANTICS (verified live 2026-09-27): b7 bat_discharge_power is CELLS-ONLY
// (0 during pure PV passthrough) while d3 output_power is the TOTAL inverter
// output — scen_info carries both under the same names. The merge below must
// prefer d3 for outputW or MQTT/REST alternate between two different
// quantities and every downstream value flickers 0 ↔ total.
const FIELDS_0405 = {
  a3: { key: "mainSoc", factor: 1 }, // main_battery_soc (controller only)
  ad: { key: "soc", factor: 1 }, // battery_soc (controller + expansions avg)
  aa: { key: "temperatureC", factor: 1, signed: true }, // main device temp, °C
  ab: { key: "pvW", factor: 0.1 }, // photovoltaic_power
  ac: { key: "acOutputW", factor: 0.1 }, // ac_output_power
  b0: { key: "chargeW", factor: 0.01 }, // bat_charge_power
  b7: { key: "dischargeW", factor: 0.01 }, // bat_discharge_power — CELLS-only!
  d3: { key: "outputW", factor: 0.1 }, // output_power (TOTAL — the one to use)
  c4: { key: "homeLoadW", factor: 0.1 }, // home_demand ≈ home_load_power
  // Per-string PV (community _A17C1_0405: ca-cd, deciwatts like the other
  // power fields). scen_info's pv_power block is NOT a live per-string
  // channel (verified 2026-10-02: values frozen for 20+ min while
  // photovoltaic_power moved) — MQTT is the only truthful per-string source.
  ca: { key: "pv1W", factor: 0.1 }, // pv_1_power
  cb: { key: "pv2W", factor: 0.1 }, // pv_2_power
  cc: { key: "pv3W", factor: 0.1 }, // pv_3_power
  cd: { key: "pv4W", factor: 0.1 }, // pv_4_power
  // (c4 used to be mapped to "toHomeW" — home_demand ≠ scen_info's
  // to_home_load, the same alternating-semantics bug as b7/d3; REST owns
  // toHomeW now.)
};

// Solarbank 4 (AE103) 0405 — community _AE103_0405 (2026-09-28). DIFFERENT
// wire layout than the Solarbank 2 family (do NOT reuse the map above — the
// blind reuse decoded soc=0 on real hardware, which is why AE103 was
// REST-only until now): the SOC lives in a3 (ad is output_power there!),
// temperature in a5, and ALL power fields are raw watts (the community map
// carries no FACTOR for them, parser default = 1). New useful channels the
// SB2 family doesn't have: c4 grid_power_signed (the docked system's grid
// flow as the SB4 sees it) and ac battery_power_signed.
const FIELDS_0405_AE103 = {
  a3: { key: "soc", factor: 1 }, // battery_soc (unit total, incl. packs)
  a4: { key: "batteryStatus", factor: 1 }, // 0 standby, 2 charging, ? discharging
  a5: { key: "temperatureC", factor: 1, signed: true }, // main device temp, °C
  ab: { key: "pvW", factor: 1 }, // photovoltaic_power (raw W on AE103)
  ac: { key: "batteryPowerSignedW", factor: 1 }, // battery_power_signed (verified: + charge / − discharge)
  ad: { key: "outputW", factor: 1 }, // output_power (TOTAL inverter output)
  ae: { key: "acOutputSignedW", factor: 1 }, // ac_output_power_signed
  bb: { key: "heatingPower", factor: 1 },
  bc: { key: "gridToBatteryW", factor: 1 },
  bd: { key: "maxLoadW", factor: 1 },
  // Dock-era caveat (verified 2026-09-28): behind a Power Dock c4/c5 are
  // unit-local, NOT whole-system channels — c4 read exactly −outputW and
  // c5 read 0 while the house drew ~350 W. scen_info remains the source
  // for whole-house home_load_power; these are kept for debugging only.
  c4: { key: "gridSignedW", factor: 1 }, // grid_power_signed (unit-local behind dock)
  c5: { key: "homeLoadW", factor: 1 }, // home_demand (0 behind a dock)
  c6: { key: "pv1W", factor: 1 },
  c7: { key: "pv2W", factor: 1 },
  c8: { key: "pv3W", factor: 1 },
  c9: { key: "pv4W", factor: 1 },
};

// Smart Plug Gen 2 (A17X8) 0405 — community _A17X8_0405 (2026-10-10, for
// the account-level/site-less plug ingestion: Anker caps a home energy
// system at 10 Gen-2 plugs, so plugs 11+ live on the account WITHOUT a
// site and never appear in scen_info — MQTT is their only telemetry
// channel). Streams ~5 s under the same 0057 realtime trigger. ab is the
// plug's cumulative energy counter (kWh) — semantics logged live before
// being trusted for daily-kWh math.
const FIELDS_0405_A17X8 = {
  a4: { key: "on", factor: 1 }, // ac_output_power_switch: 0 off, 1 on
  a8: { key: "voltageV", factor: 0.1 },
  a9: { key: "currentA", factor: 0.01 },
  aa: { key: "watts", factor: 0.1 }, // power
  ab: { key: "totalKwh", factor: 0.001 }, // output_energy (cumulative?)
};

function fields0405For(pn) {
  if (pn === "AE103") return FIELDS_0405_AE103;
  if (pn === "A17X8") return FIELDS_0405_A17X8;
  return FIELDS_0405;
}

// Round like the community client: decimals derived from the factor.
function applyFactor(raw, factor) {
  if (factor === 1) return raw;
  const decimals = Math.max(0, Math.round(-Math.log10(factor)));
  return Math.round(raw * factor * 10 ** decimals) / 10 ** decimals;
}

// Parse the binary device message into {msgtype, fields: {name: {type, value}}}.
// Returns null on structural errors (caller treats them as noise, not fatal).
// Exported for testing.
export function parseDeviceMessage(buf) {
  if (buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0x09) return null;
  const declared = buf.readUInt16LE(2);
  const msgtype = buf.subarray(7, 9).toString("hex");
  // Optional increment byte: when byte 9 is NOT in a0..a9 it is an increment
  // counter; a0..a9 means the fields already start there (field names).
  let idx = buf[9] >= 0xa0 && buf[9] <= 0xa9 ? 9 : 10;
  const end = Math.min(buf.length, declared) - 1; // last byte = XOR checksum
  let xor = 0;
  for (let i = 0; i <= end; i++) xor ^= buf[i];
  if (xor !== 0) return null; // checksum covers the checksum byte itself → 0

  const fields = {};
  while (idx >= 9 && idx < end) {
    const name = buf[idx];
    let lenBytes = 1;
    let fLength = buf[idx + 1];
    if (fLength === undefined) break;
    // Long str/bin fields use a 2-byte LE length (type tag then sits at +3).
    // Heuristic from the community parser: if the byte at +3 is a str(00) or
    // bin(04) tag and the 2-byte length fits the remaining message, use it.
    const len2 = buf.readUInt16LE(idx + 1);
    const tag3 = buf[idx + 3];
    if ((tag3 === 0x00 || tag3 === 0x04) && len2 > 3 && idx + 3 + len2 <= end + 1) {
      if (tag3 === 0x00) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(
            buf.subarray(idx + 4, idx + 3 + len2),
          );
          lenBytes = 2;
          fLength = len2;
        } catch {
          /* 1-byte length was right */
        }
      } else {
        lenBytes = 2;
        fLength = len2;
      }
    }
    if (fLength < 1 || idx + 1 + lenBytes + fLength > end + 1) break;
    const tagOff = idx + 1 + lenBytes;
    let type = -1; // -1 = no type tag, raw single-byte value
    let value;
    if (fLength > 1 && buf[tagOff] < 0x10) {
      type = buf[tagOff];
      value = buf.subarray(tagOff + 1, tagOff + fLength);
    } else {
      value = buf.subarray(tagOff, tagOff + fLength);
    }
    fields[name.toString(16).padStart(2, "0")] = { type, value };
    idx += 1 + lenBytes + fLength;
  }
  return { msgtype, fields };
}

// Decode a TLV value by its type tag, as a number (or string for type 00).
function decodeValue({ type, value }) {
  switch (type) {
    case 0x00:
      return value.toString("utf8").replaceAll("\0", "").trim();
    case 0x01:
      return value[0];
    case 0x02:
      return value.readInt16LE(0);
    case 0x03:
      return value.length >= 4 ? value.readInt32LE(0) : value.readIntLE(0, value.length);
    case 0x05:
      return value.length === 4 ? value.readFloatLE(0) : null;
    case -1:
      return value[0]; // no type tag: single-byte unsigned
    default:
      return null; // bin/strb/json — not needed for telemetry
  }
}

// Decode a 040a expansion message into {ts, packCount, mainSoc, packs}.
// Field layout (community _A17C1_040a): a2 = pack count, a3 = main battery
// SOC, then per pack idx 1..5 field a{3+idx} is ONE composite bin field —
// byte offsets within its payload: 0: controller SN (str 16), 18: battery
// status (ui), 19: temperature (ui, two's complement), 21: SOC (ui),
// 22: SOH (ui), 27: pack SN (str 17). Exported for testing.
export function decodeExpansionData(fields) {
  const packCount = fields.a2 ? decodeValue(fields.a2) : null;
  const mainSoc = fields.a3 ? decodeValue(fields.a3) : null;
  const packs = [];
  for (let idx = 1; idx <= 5; idx++) {
    const f = fields[(0xa3 + idx).toString(16)];
    if (!f?.value || f.value.length < 44) continue;
    const v = f.value; // composite bytes (type 0x04 bin), offsets per the map
    const readStr = (off, len) =>
      v.subarray(off, off + len).toString("utf8").replaceAll("\0", "").trim();
    packs.push({
      controllerSn: readStr(0, 16) || null,
      status: v[18],
      temperatureC: v[19] > 127 ? v[19] - 256 : v[19],
      soc: v[21],
      soh: v[22],
      sn: readStr(27, 17) || null,
    });
  }
  return { ts: Date.now(), packCount, mainSoc, packs };
}

// Decode a 040a expansion message from a SOLARBANK 4 (AE103) — community
// _AE103_040a. Different layout than the SB2 family's 040a: a2 = pack count
// (shows 2 even with 1 pack installed), a3 = TOTAL battery SOC, then field
// a4 is the MAIN pack composite and a5..a9 the expansion packs (one per
// field). Composite byte offsets: 0: controller SN (str 16), 26: temperature
// (ui, two's complement), 27: battery status (0 standby / 1 discharging /
// 2 charging), 28: SOC (ui), 29: SOH (ui). Exported for testing.
export function decodeExpansionDataAE103(fields) {
  const packCount = fields.a2 ? decodeValue(fields.a2) : null;
  const totalSoc = fields.a3 ? decodeValue(fields.a3) : null;
  const readPack = (hex) => {
    const f = fields[hex];
    if (!f?.value || f.value.length < 30) return null;
    const v = f.value;
    return {
      controllerSn: v.subarray(0, 16).toString("utf8").replaceAll("\0", "").trim() || null,
      status: v[27],
      temperatureC: v[26] > 127 ? v[26] - 256 : v[26],
      soc: v[28],
      soh: v[29],
      sn: null, // the AE103 040a composite carries no separate pack SN
    };
  };
  const main = readPack("a4");
  const packs = [];
  for (let idx = 1; idx <= 5; idx++) {
    const p = readPack((0xa4 + idx).toString(16));
    if (p) packs.push(p);
  }
  return { ts: Date.now(), packCount, mainSoc: main?.soc ?? null, main, packs };
}

// Build the realtime-trigger command (0057): the device streams 0405 telemetry
// every ~3-5 s for `timeoutSec` after receiving it. Field layout per the
// community CMD_REALTIME_TRIGGER (CMD_COMMON + a2 toggle + a3 timeout):
//   a1 01 22        fixed pattern byte
//   a2 02 01 01     ui: realtime on
//   a3 05 03 <u32>  var: timeout seconds
//   fe 05 03 <u32>  var: unix timestamp
// Exported for testing.
export function buildRealtimeTrigger(timeoutSec) {
  const body = [
    0xa1, 0x01, 0x22,
    0xa2, 0x02, 0x01, 0x01,
    0xa3, 0x05, 0x03,
  ];
  const timeout = Buffer.alloc(4);
  timeout.writeUInt32LE(timeoutSec);
  const ts = Buffer.alloc(4);
  ts.writeUInt32LE(Math.floor(Date.now() / 1000));
  const msg = Buffer.concat([
    Buffer.from([0xff, 0x09, 0x00, 0x00, 0x03, 0x00, 0x0f, 0x00, 0x57]),
    Buffer.from(body),
    timeout,
    Buffer.from([0xfe, 0x05, 0x03]),
    ts,
  ]);
  msg.writeUInt16LE(msg.length + 1, 2); // length includes the checksum byte
  let xor = 0;
  for (const b of msg) xor ^= b;
  return Buffer.concat([msg, Buffer.from([xor])]);
}

export class AnkerMqtt {
  constructor(ankerClient, batterySn, pn = "A17C3") {
    this.anker = ankerClient;
    this.sn = batterySn;
    this.pn = pn;
    // A17X8 = smart plug — the 0405 mapping below emits {watts, on, ...}
    // instead of battery channels.
    this.kind = pn === "A17X8" ? "plug" : "battery";
    this.onData = null; // set by caller: ({ts, soc, outputW, chargeW, pvW, toHomeW, temperatureC})
    this.client = null;
    this.mqttInfo = null;
    this.connected = false;
    this.stopped = false;
    this.backoffMs = 5000;
    this.loggedFirstData = false;
    this.reconnectTimer = null;
    this.triggerTimer = null;
    this.watchdogTimer = null;
    this.lastDataAt = null; // last telemetry message received
    this.connectedAt = null;
  }

  // True only when telemetry is actually flowing (not merely connected).
  isFresh(maxAgeMs = 120 * 1000) {
    return this.connected && this.lastDataAt != null && Date.now() - this.lastDataAt < maxAgeMs;
  }

  // Never rejects: any failure is logged and retried with backoff so MQTT can
  // never take down the REST baseline.
  async start() {
    this.stopped = false;
    try {
      this.mqttInfo = await this.anker.post("app/devicemanage/get_user_mqtt_info", {});
      if (!this.mqttInfo?.endpoint_addr) throw new Error("no endpoint_addr in mqtt info");
      this.#connect();
    } catch (err) {
      console.warn(`[mqtt] setup failed: ${err.message} — retrying in ${this.backoffMs / 1000}s`);
      this.#scheduleReconnect();
    }
  }

  #connect() {
    if (this.stopped) return;
    const info = this.mqttInfo;
    const clientId = `${info.thing_name}_${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;
    this.client = mqtt.connect({
      host: info.endpoint_addr,
      port: 8883,
      protocol: "mqtts",
      // Client-certificate auth, certs come straight from the REST response.
      ca: info.aws_root_ca1_pem,
      cert: info.certificate_pem,
      key: info.private_key,
      clientId,
      clean: true,
      reconnectPeriod: 0, // we handle reconnects ourselves (backoff below)
    });
    this.client.on("connect", () => {
      this.connected = true;
      this.connectedAt = Date.now();
      // NOTE: backoff is reset only when telemetry actually arrives (#onMessage),
      // not here — a connect that never delivers data must keep escalating.
      console.log(`[mqtt] connected to ${info.endpoint_addr}, subscribing to ${this.kind} ${this.sn}`);
      // Subscribe with the # wildcard (2026-09-26 bug, found live): the
      // A17C3 published telemetry on the BARE topic dt/.../sn/, but the
      // A17C1 (Pro) publishes on SUBTOPICS (dt/.../sn/param_info,
      // dt/.../sn/state_info) — a bare trailing-slash subscription matched
      // none of them, so after the Plus→Pro swap we received ZERO messages
      // while the broker was routing fine. Misdiagnosed for a day as the
      // third "broker stall". `sn/#` also matches the bare topic itself
      // (MQTT spec), so both device generations are covered.
      const topic = `dt/${info.app_name}/${this.pn}/${this.sn}/#`;
      this.client.subscribe(topic, (err) => {
        if (err) console.warn(`[mqtt] subscribe failed: ${err.message}`);
        else this.#sendRealtimeTrigger();
      });
      // The trigger expires (max 600 s) — re-send periodically while connected.
      this.triggerTimer = setInterval(() => this.#sendRealtimeTrigger(), 240 * 1000);
      this.triggerTimer.unref();
      // Stall watchdog: a half-open connection emits no close/error and the
      // publish calls fail silently, so detect missing telemetry and force a
      // reconnect (end() triggers the close handler below).
      this.watchdogTimer = setInterval(() => {
        const ref = this.lastDataAt ?? this.connectedAt;
        if (this.connected && ref != null && Date.now() - ref > 120 * 1000) {
          console.warn("[mqtt] no telemetry for 120s — connection stalled, forcing reconnect");
          try {
            this.client.end(true);
          } catch {
            /* already gone */
          }
        }
      }, 30 * 1000);
      this.watchdogTimer.unref();
    });
    this.client.on("message", (topic, payload) => this.#onMessage(topic, payload));
    this.client.on("error", (err) => {
      console.warn(`[mqtt] error: ${err.message}`);
    });
    this.client.on("close", () => {
      this.connected = false;
      clearInterval(this.triggerTimer);
      clearInterval(this.watchdogTimer);
      if (!this.stopped) {
        console.warn(`[mqtt] disconnected — reconnecting in ${this.backoffMs / 1000}s`);
        this.#scheduleReconnect();
      }
    });
  }

  #scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      // Re-run the full setup: the mqtt info (certs) may have been refreshed.
      this.start();
    }, this.backoffMs);
    this.reconnectTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60 * 1000);
  }

  #sendRealtimeTrigger() {
    if (!this.connected) return;
    try {
      const info = this.mqttInfo;
      const hexdata = buildRealtimeTrigger(300);
      // Publish envelope mirrors the app: JSON head + base64 hex command.
      const message = JSON.stringify({
        head: {
          version: "1.0.0.1",
          client_id: `android-${info.app_name}-${info.user_id ?? ""}-${info.certificate_id ?? ""}`,
          sess_id: "1234-5678",
          msg_seq: 1,
          seed: 1,
          timestamp: Math.floor(Date.now() / 1000),
          cmd_status: 2,
          cmd: 17,
          sign_code: 1,
          device_pn: this.pn,
          device_sn: this.sn,
        },
        payload: JSON.stringify({
          device_sn: this.sn,
          account_id: info.user_id ?? "",
          data: hexdata.toString("base64"),
        }),
      });
      this.client.publish(`cmd/${info.app_name}/${this.pn}/${this.sn}/req`, message, (err) => {
        if (err) console.warn(`[mqtt] realtime trigger publish failed: ${err.message}`);
      });
    } catch (err) {
      console.warn(`[mqtt] realtime trigger failed: ${err.message}`);
    }
  }

  #onMessage(topic, payload) {
    try {
      const envelope = JSON.parse(payload.toString());
      const inner = JSON.parse(envelope?.payload ?? "{}");
      if (!inner.data) {
        if (process.env.MQTT_DEBUG)
          console.log(`[mqtt] msg without data on ${topic}: ${payload.toString().slice(0, 200)}`);
        return;
      }
      const msg = parseDeviceMessage(Buffer.from(inner.data, "base64"));
      if (!msg) {
        if (process.env.MQTT_DEBUG)
          console.log(`[mqtt] unparseable device message: ${inner.data.slice(0, 120)}`);
        return; // bad checksum or not a Solix binary message
      }
      if (msg.msgtype === MSGTYPE_EXPANSION) {
        const exp = this.pn === "AE103"
          ? decodeExpansionDataAE103(msg.fields)
          : decodeExpansionData(msg.fields);
        this.lastDataAt = Date.now(); // device data = connection is alive
        this.backoffMs = 5000;
        if (!this.loggedFirstExpansion) {
          this.loggedFirstExpansion = true;
          console.log(
            `[mqtt] expansion data: ${exp.packs.length} pack(s)` +
              exp.packs.map((p) => ` soc=${p.soc}% soh=${p.soh}% sn=${p.sn ?? "?"}`).join(""),
          );
        }
        this.onExpansion?.(exp);
        return;
      }
      if (msg.msgtype !== MSGTYPE_TELEMETRY) {
        if (process.env.MQTT_DEBUG) console.log(`[mqtt] non-telemetry msgtype ${msg.msgtype}`);
        return;
      }

      const out = { ts: Date.now() };
      for (const [hexName, def] of Object.entries(fields0405For(this.pn))) {
        const f = msg.fields[hexName];
        if (!f) continue;
        let raw = decodeValue(f);
        // decodeValue()'s 1-byte paths (type 0x01, or no tag at all) return
        // the byte unsigned — for a field we know can go negative (only
        // temperature so far), undo the two's-complement wrap by hand rather
        // than making decodeValue() signed-by-default (would change every
        // other 1-byte field's semantics too).
        if (def.signed && (f.type === 0x01 || f.type === -1) && typeof raw === "number" && raw > 127) {
          raw -= 256;
        }
        if (typeof raw === "number" && Number.isFinite(raw)) {
          out[def.key] = applyFactor(raw, def.factor);
        }
      }
      // Smart plug (A17X8): entirely different channel set — watts, switch
      // state, voltage/current, and the energy counter. No REST payload to
      // merge with (site-less plugs never appear in scen_info), so forward
      // whatever arrived as-is.
      if (this.kind === "plug") {
        const data = { ts: out.ts };
        if (out.watts != null) data.watts = out.watts;
        if (out.on != null) data.on = out.on === 1;
        if (out.voltageV != null) data.voltageV = out.voltageV;
        if (out.currentA != null) data.currentA = out.currentA;
        if (out.totalKwh != null) data.totalKwh = out.totalKwh;
        if (!this.loggedFirstData) {
          this.loggedFirstData = true;
          console.log(
            `[mqtt] first plug telemetry (${this.sn}): ${data.watts ?? "?"} W, ` +
              `switch ${data.on ?? "?"}, energy counter ${data.totalKwh ?? "?"} kWh`,
          );
        }
        this.lastDataAt = Date.now();
        this.backoffMs = 5000;
        this.onData?.(data);
        return;
      }
      // Map onto the REST sync payload shape: outputW is the TOTAL inverter
      // output (d3 output_power on SB2, ad on AE103) — NOT the cells-only
      // b7 bat_discharge_power (b7 was preferred until 2026-09-27 and made
      // MQTT/REST alternate outputW between 0 and the total — the flicker
      // that cascaded through the flow diagram, Home line, gauge and
      // graphs). toHomeW is REST-only (c4 on SB2 is home_demand ≈ homeLoadW,
      // a different quantity than to_home_load). Only forward keys that
      // actually carry a value — a null would overwrite the REST channel's
      // value on the shared latestBattery object.
      const isAE103 = this.pn === "AE103";
      // Only forward keys that actually carry a value (2026-09-29 review):
      // a null/undefined field would overwrite the REST channel's value on
      // the shared member object — and REST no longer repairs it while this
      // unit's MQTT is fresh (the cross-source preservation rule).
      const data = { ts: out.ts };
      const socV = out.soc ?? out.mainSoc ?? null;
      if (socV != null) data.soc = socV;
      if (out.mainSoc != null) data.mainSoc = out.mainSoc;
      const outW = out.outputW ?? out.dischargeW ?? out.acOutputW ?? null;
      if (outW != null) data.outputW = outW;
      // AE103 has no separate charge field — ac battery_power_signed
      // carries the signed cell flow (verified live 2026-09-28: ac read
      // −380 while the unit discharged 380 W, so POSITIVE = charging).
      const chg = out.chargeW ?? (out.batteryPowerSignedW != null ? Math.max(0, out.batteryPowerSignedW) : null);
      if (chg != null) data.chargeW = chg;
      if (out.pvW != null) data.pvW = out.pvW;
      if (out.temperatureC != null) data.temperatureC = out.temperatureC;
      if (out.homeLoadW != null) data.homeLoadW = out.homeLoadW;
      // Per-string PV — both maps carry it now (A17C1 ca-cd ×0.1, AE103
      // c6-c9 raw W); MQTT is the ONLY truthful per-string source
      // (scen_info's pv_power block is frozen — verified 2026-10-02).
      for (const k of ["pv1W", "pv2W", "pv3W", "pv4W"]) {
        if (out[k] != null) data[k] = out[k];
      }
      // AE103 extras (raw pass-through; consumers pick what they know):
      // gridSignedW = the docked system's grid flow as the unit sees it,
      // batteryStatus, heatingPower, maxLoadW.
      if (isAE103) {
        for (const k of ["gridSignedW", "batteryStatus", "heatingPower", "maxLoadW", "batteryPowerSignedW"]) {
          if (out[k] != null) data[k] = out[k];
        }
      }
      if (!this.loggedFirstData) {
        this.loggedFirstData = true;
        console.log(
          `[mqtt] first telemetry: soc=${data.soc ?? "?"}% discharge=${data.outputW ?? "?"}W ` +
            `charge=${data.chargeW ?? "?"}W pv=${data.pvW ?? "?"}W`,
        );
      }
      this.lastDataAt = Date.now();
      this.backoffMs = 5000; // real data arrived — connection is healthy
      this.onData?.(data);
    } catch (err) {
      console.warn(`[mqtt] message parse failed: ${err.message}`);
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.triggerTimer);
    clearInterval(this.watchdogTimer);
    try {
      this.client?.end(true);
    } catch {
      /* already gone */
    }
    this.client = null;
    this.connected = false;
  }
}
