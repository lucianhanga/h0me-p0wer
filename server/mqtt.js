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

// Field map for message 0405 on A17C3 (Solarbank 2 E1600 Plus) — shared with
// A17C1 in the community SOLIXMQTTMAP (_A17C1_0405). factor: raw × factor.
const FIELDS_0405 = {
  a3: { key: "mainSoc", factor: 1 }, // main_battery_soc (controller only)
  ad: { key: "soc", factor: 1 }, // battery_soc (controller + expansions avg)
  ab: { key: "pvW", factor: 0.1 }, // photovoltaic_power
  ac: { key: "acOutputW", factor: 0.1 }, // ac_output_power
  b0: { key: "chargeW", factor: 0.01 }, // bat_charge_power
  b7: { key: "dischargeW", factor: 0.01 }, // bat_discharge_power
  d3: { key: "outputW", factor: 0.1 }, // output_power (total)
  c4: { key: "toHomeW", factor: 0.1 }, // home_demand
};

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
    this.onData = null; // set by caller: ({ts, soc, outputW, chargeW, pvW, toHomeW})
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
      console.log(`[mqtt] connected to ${info.endpoint_addr}, subscribing to battery ${this.sn}`);
      const topic = `dt/${info.app_name}/${this.pn}/${this.sn}/`;
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
      if (msg.msgtype !== MSGTYPE_TELEMETRY) {
        if (process.env.MQTT_DEBUG) console.log(`[mqtt] non-telemetry msgtype ${msg.msgtype}`);
        return;
      }

      const out = { ts: Date.now() };
      for (const [hexName, def] of Object.entries(FIELDS_0405)) {
        const f = msg.fields[hexName];
        if (!f) continue;
        const raw = decodeValue(f);
        if (typeof raw === "number" && Number.isFinite(raw)) {
          out[def.key] = applyFactor(raw, def.factor);
        }
      }
      // Map onto the REST sync payload shape: discharge = dedicated field,
      // falling back to total output power; SOC prefers the pack average.
      const data = {
        ts: out.ts,
        soc: out.soc ?? out.mainSoc ?? null,
        outputW: out.dischargeW ?? out.outputW ?? out.acOutputW ?? 0,
        chargeW: out.chargeW ?? 0,
        pvW: out.pvW ?? 0,
        toHomeW: out.toHomeW ?? null,
      };
      if (!this.loggedFirstData) {
        this.loggedFirstData = true;
        console.log(
          `[mqtt] first telemetry: soc=${data.soc}% discharge=${data.outputW}W ` +
            `charge=${data.chargeW}W pv=${data.pvW}W`,
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
