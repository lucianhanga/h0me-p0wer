import { createECDH, createCipheriv, createHash } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

    // Reuse a persisted token across restarts: fresh logins are rate-limited
    // and repeated ones get the account temporarily locked (error 10019).
    // Stored next to the database (the /data volume in Docker).
    const dbDir = path.dirname(
      process.env.DB_PATH ??
        path.join(path.dirname(fileURLToPath(import.meta.url)), "data.db"),
    );
    this.tokenFile = path.join(dbDir, ".token-cache.json");
    try {
      const cached = JSON.parse(readFileSync(this.tokenFile, "utf8"));
      if (cached.expiresAt && Date.now() < cached.expiresAt - 3600 * 1000) {
        this.authToken = cached.authToken;
        this.gtoken = cached.gtoken;
        this.tokenExpiresAt = cached.expiresAt;
        console.log("[cloud] using cached auth token");
      }
    } catch {
      /* no usable cache — will log in */
    }
  }

  saveTokenCache() {
    try {
      writeFileSync(
        this.tokenFile,
        JSON.stringify({
          authToken: this.authToken,
          gtoken: this.gtoken,
          expiresAt: this.tokenExpiresAt,
        }),
      );
      chmodSync(this.tokenFile, 0o600); // writeFileSync only applies mode on creation
    } catch {
      /* cache write failed — non-fatal */
    }
  }

  // Token lifecycle, centralized: reuse a valid token, dedupe concurrent
  // logins (every fresh login counts against a heavily rate-limited endpoint),
  // and cool down after failures so a locked account isn't hammered further.
  async ensureToken() {
    if (this.authToken && Date.now() < (this.tokenExpiresAt ?? 0) - 60 * 1000) {
      return;
    }
    if (this.loginPromise) return this.loginPromise;
    if (this.loginCooldownUntil && Date.now() < this.loginCooldownUntil) {
      throw new AnkerApiError(
        `login cooldown active until ${new Date(this.loginCooldownUntil).toLocaleTimeString()} ` +
          `(previous failure; avoiding account lockout)`,
      );
    }
    this.loginPromise = this.login()
      .catch((err) => {
        // Escalating backoff: repeated attempts extend Anker's rate-limit
        // window, so each consecutive failure cools down twice as long.
        this.loginFailures = (this.loginFailures ?? 0) + 1;
        const cooldownMs = Math.min(
          10 * 60 * 1000 * 2 ** (this.loginFailures - 1),
          60 * 60 * 1000,
        );
        this.loginCooldownUntil = Date.now() + cooldownMs;
        throw err;
      })
      .finally(() => {
        this.loginPromise = null;
      });
    return this.loginPromise;
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
    // API returns epoch seconds; normalize to ms.
    this.tokenExpiresAt =
      data.token_expires_at < 1e12 ? data.token_expires_at * 1000 : data.token_expires_at;
    this.loginFailures = 0;
    this.saveTokenCache();
    console.log(`[cloud] logged in as ${data.nick_name ?? this.email} (${data.country_code})`);
    return data;
  }

  async post(endpoint, body = {}, isRetry = false) {
    await this.ensureToken();

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
    // Auth failure mid-session: drop the token and retry once with a fresh one.
    if ((response.status === 401 || response.status === 403) && !isRetry) {
      this.authToken = null;
      return this.post(endpoint, body, true);
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

  // Live battery (Solarbank) status from the site's scene info. The site id
  // is looked up once and cached (rate limits are tight).
  async getBatteryInfo() {
    if (!this.siteId) {
      const sites = await this.getSiteList();
      this.siteId = sites?.site_list?.[0]?.site_id ?? null;
      if (!this.siteId) return null;
    }
    const scene = await this.getSceneInfo(this.siteId);
    const sb = scene?.solarbank_info?.solarbank_list?.[0];
    if (!sb) return null;
    const num = (v) => (v === "" || v == null ? 0 : Number(v));
    return {
      ts: Date.now(),
      sn: sb.device_sn,
      name: sb.device_name,
      soc: num(sb.battery_power), // state of charge, percent
      outputW: num(sb.output_power), // discharging into home
      chargeW: num(sb.bat_charge_power), // charging
      pvW: num(sb.photovoltaic_power), // solar input
      toHomeW: num(scene.solarbank_info.to_home_load),
      siteId: this.siteId,
    };
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
