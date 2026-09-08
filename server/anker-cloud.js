import { createECDH, createCipheriv, createHash } from "node:crypto";

const API = "https://ankerpower-api-eu.anker.com";

// Fixed Anker API public key (P-256, uncompressed), from the community
// reverse-engineered client.
const ANKER_PUBLIC_KEY =
  "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a" +
  "3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

function timezoneString() {
  const offset = -new Date().getTimezoneOffset(); // minutes east of UTC
  const sign = offset >= 0 ? "+" : "-";
  const total = Math.abs(offset);
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `GMT${sign}${hours}:${minutes}`;
}

function timezoneMilliseconds() {
  return -new Date().getTimezoneOffset() * 60 * 1000;
}

function md5(value) {
  return createHash("md5").update(value, "utf8").digest("hex");
}

// ECDH P-256 against Anker's fixed public key, then AES-256-CBC with the
// shared secret as key and its first 16 bytes as IV (PKCS#7 padding is the
// Node default). Returns the ephemeral public key and encrypted password.
function createLoginCrypto(password) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();

  const clientPublicKey = ecdh.getPublicKey(undefined, "uncompressed").toString("hex");
  const sharedSecret = ecdh.computeSecret(Buffer.from(ANKER_PUBLIC_KEY, "hex"));

  const cipher = createCipheriv("aes-256-cbc", sharedSecret, sharedSecret.subarray(0, 16));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(password, "utf8")),
    cipher.final(),
  ]).toString("base64");

  return { clientPublicKey, encryptedPassword: encrypted };
}

export class AnkerApiError extends Error {
  constructor(message, { code = null, httpStatus = null, rateLimited = false } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.rateLimited = rateLimited;
  }
}

export class AnkerClient {
  constructor(email, password, country = "DE") {
    this.email = email;
    this.password = password;
    this.country = country;
    this.authToken = null;
    this.gtoken = null;
    this.tokenExpiresAt = null;
  }

  get configured() {
    return Boolean(this.email && this.password);
  }

  baseHeaders() {
    const headers = {
      "content-type": "application/json",
      "model-type": "DESKTOP",
      "app-name": "anker_power",
      "os-type": "android",
      country: this.country,
      timezone: timezoneString(),
    };
    if (this.authToken) {
      headers["x-auth-token"] = this.authToken;
      headers["gtoken"] = this.gtoken;
    }
    return headers;
  }

  async login() {
    if (!this.configured) {
      throw new AnkerApiError("ANKER_EMAIL / ANKER_PASSWORD not set in .env");
    }
    const { clientPublicKey, encryptedPassword } = createLoginCrypto(this.password);

    const response = await fetch(`${API}/passport/login`, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({
        ab: this.country,
        client_secret_info: { public_key: clientPublicKey },
        enc: 0,
        email: this.email,
        password: encryptedPassword,
        time_zone: timezoneMilliseconds(),
        transaction: String(Date.now()),
      }),
    });

    if (!response.ok) {
      throw new AnkerApiError(`login HTTP error ${response.status}`, {
        httpStatus: response.status,
      });
    }
    const result = await response.json();
    if (result.code !== 0) {
      throw new AnkerApiError(`login failed: ${result.code} ${result.msg}`, { code: result.code });
    }

    const data = result.data;
    this.authToken = data.auth_token;
    this.gtoken = md5(data.user_id);
    this.tokenExpiresAt = data.token_expires_at;
    console.log(`[cloud] logged in as ${data.nick_name ?? this.email} (${data.country_code})`);
    return data;
  }

  async post(endpoint, body = {}) {
    if (!this.authToken) await this.login();

    const response = await fetch(`${API}/${endpoint}`, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      throw new AnkerApiError("rate limited by Anker cloud (HTTP 429), try again in a minute", {
        httpStatus: 429,
        rateLimited: true,
      });
    }
    if (!response.ok) {
      throw new AnkerApiError(`${endpoint} HTTP error ${response.status}`, {
        httpStatus: response.status,
      });
    }

    const result = await response.json();
    if (result.code !== 0) {
      throw new AnkerApiError(`${endpoint} failed: ${result.code} ${result.msg}`, {
        code: result.code,
      });
    }
    return result.data;
  }

  getSiteList() {
    return this.post("power_service/v1/site/get_site_list", {});
  }

  getSceneInfo(siteId) {
    return this.post("power_service/v1/site/get_scen_info", { site_id: siteId });
  }

  listDevices() {
    return this.post("power_service/v1/site/list_user_devices", {});
  }

  getBindDevices() {
    return this.post("power_service/v1/app/get_relate_and_bind_devices", {});
  }

  getEnergyAnalysis({ siteId, deviceSn = "", deviceType = "grid", type = "day", startTime, endTime = "" }) {
    return this.post("power_service/v1/site/energy_analysis", {
      site_id: siteId,
      device_sn: deviceSn,
      device_type: deviceType,
      type,
      start_time: startTime,
      end_time: endTime,
    });
  }

  // Device-level history (works without a site, e.g. standalone Smart Meter).
  // type=day:   start_time "yyyy-MM-dd"              -> 20-min power trend (W)
  // type=week:  start_time + end_time (7-day range)  -> daily import/export (kWh)
  // type=month: start_time "yyyy-MM"                 -> daily import/export (kWh)
  // type=year:  start_time "yyyy"                    -> monthly import/export (kWh)
  getDeviceEnergyAnalysis({ deviceSn, deviceType = "grid", type = "day", startTime, endTime = "" }) {
    return this.post("power_service/v2/device/energy_analysis", {
      device_sn: deviceSn,
      device_type: deviceType,
      type,
      start_time: startTime,
      end_time: endTime,
    });
  }
}
