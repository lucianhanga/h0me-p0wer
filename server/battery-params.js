// Battery params route: ONE endpoint aggregating everything the Battery tab
// shows — live values (from the 10 s scen_info sync / DB fallback), the
// slow-changing device configuration (Anker get_site_device_param), the
// scen_info feature switches, and the A17C3 hardware constants.
//
// The configuration is cached 6 h in the kv store: get_site_device_param
// shares Anker's tight per-endpoint rate limits and these values change only
// when the user edits them in the app. `?refresh=1` forces a refetch.

import { kvGet, kvSet } from "./db.js";

const CONFIG_KV_KEY = "battery_config";
const CONFIG_TTL_MS = 6 * 3600 * 1000;

// A17C3 Solarbank 2 E1600 Plus hardware constants (datasheet).
const CONSTANTS = {
  model: "A17C3",
  product: "Solarbank 2 E1600 Plus",
  capacityKwh: 1.6, // LFP
  maxAcOutputW: 800, // inverter AC output cap (DE balcony feed-in limit)
  maxPvInputW: 1200, // max PV DC input
};

const numOrNull = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));

async function ensureSiteId(anker, getLiveBattery) {
  if (anker.siteId) return anker.siteId;
  const live = getLiveBattery();
  if (live?.siteId) {
    anker.siteId = live.siteId;
    return live.siteId;
  }
  const sites = await anker.getSiteList();
  anker.siteId = sites?.site_list?.[0]?.site_id ?? null;
  return anker.siteId;
}

async function readParam(anker, siteId, paramType) {
  const resp = await anker.post("power_service/v1/site/get_site_device_param", {
    site_id: siteId,
    param_type: paramType,
  });
  const raw = resp?.param_data ?? resp?.data?.param_data ?? null;
  return typeof raw === "string" && raw ? JSON.parse(raw) : null;
}

// param_type 27: charge/discharge limits + backup reserve (Solarbank 2
// family). param_type 18: station settings — EMPTY on this single-battery
// system; read once and included only when present.
async function fetchConfig(anker, getLiveBattery) {
  const siteId = await ensureSiteId(anker, getLiveBattery);
  if (!siteId) throw new Error("no Anker site found");

  const config = {
    chargeUpperLimitPct: null,
    dischargeLowerLimitPct: null,
    backupReservePct: null,
    backupReserveSwitch: null,
    socCalibrationEnable: null,
    station: null,
  };
  try {
    const p27 = await readParam(anker, siteId, "27");
    if (p27) {
      config.chargeUpperLimitPct = numOrNull(p27.charge_upper_limit);
      config.dischargeLowerLimitPct = numOrNull(p27.discharge_lower_limit);
      config.backupReservePct = numOrNull(p27.backup_reserve);
      config.backupReserveSwitch = p27.backup_reserve_switch ?? null;
      config.socCalibrationEnable = p27.soc_calibration_enable ?? null;
      config.raw27 = p27;
    }
  } catch (err) {
    config.error27 = err.message;
  }
  try {
    const p18 = await readParam(anker, siteId, "18");
    if (p18 && Object.keys(p18).length) config.station = p18;
  } catch (err) {
    config.error18 = err.message;
  }
  // Fallbacks when the device exposes nothing (verified 2026-09-15 on the
  // A17C3: param 27/18/30 all EMPTY). The SB2 schedule (param_type 6, same
  // endpoint the power plan uses) carries `reserved_soc`; the discharge
  // floor otherwise defaults to the observed 10 % (battery stops there
  // overnight), charge ceiling to 100 %.
  if (config.dischargeLowerLimitPct == null) {
    try {
      const sched = await readParam(anker, siteId, "6");
      const reserved = numOrNull(sched?.reserved_soc);
      config.dischargeLowerLimitPct = reserved != null && reserved > 0 ? reserved : 10;
      config.limitsSource = reserved != null && reserved > 0 ? "schedule" : "default";
    } catch {
      config.dischargeLowerLimitPct = 10;
      config.limitsSource = "default";
    }
  }
  if (config.chargeUpperLimitPct == null) config.chargeUpperLimitPct = 100;
  if (config.backupReservePct == null) config.backupReservePct = config.dischargeLowerLimitPct;
  return config;
}

// Shared config resolver: 6 h cache (kv store), same cache the Battery tab
// route reads/writes — so the power-plan controller and the Battery tab
// never disagree about the account's configured charge/discharge limits.
export async function resolveBatteryConfig(anker, getLiveBattery, { forceRefresh = false } = {}) {
  const cached = kvGet(CONFIG_KV_KEY);
  const fromCache = () =>
    cached ? { ...cached.value, fetchedAt: cached.fetchedAt, source: "cache" } : null;
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CONFIG_TTL_MS) {
    return fromCache();
  }
  if (!anker.configured) return fromCache();
  try {
    const fresh = await fetchConfig(anker, getLiveBattery);
    kvSet(CONFIG_KV_KEY, fresh);
    return { ...fresh, fetchedAt: Date.now(), source: "cloud" };
  } catch (err) {
    console.warn(`[battery-params] config fetch failed: ${err.message}`);
    return fromCache(); // stale cache beats nothing
  }
}

// Discharge floor (SOC%, "reserve") + charge ceiling (SOC%, "max charging")
// for callers that only need the two limits, not the full config payload —
// the power-plan controller uses these instead of guessing/hardcoding.
export async function getBatteryLimits(anker, getLiveBattery) {
  const config = await resolveBatteryConfig(anker, getLiveBattery);
  return {
    dischargeFloorPct: config?.dischargeLowerLimitPct ?? 10,
    chargeCeilingPct: config?.chargeUpperLimitPct ?? 100,
  };
}

export function registerBatteryParamsRoute(app, { anker, getLiveBattery }) {
  app.get("/api/battery/params", async (req, res) => {
    const b = getLiveBattery() ?? null;
    const live = b
      ? {
          ts: b.ts ?? null,
          name: b.name ?? "Solarbank",
          sn: b.sn ?? null,
          soc: b.soc ?? null,
          outputW: b.outputW ?? 0,
          chargeW: b.chargeW ?? 0,
          pvW: b.pvW ?? 0,
          pv1W: b.pv1W ?? 0,
          pv2W: b.pv2W ?? 0,
          toHomeW: b.toHomeW ?? null,
          gridToHomeW: b.gridToHomeW ?? null,
          pvToGridW: b.pvToGridW ?? null,
          homeLoadW: b.homeLoadW ?? null,
          heatingPower: b.heatingPower ?? null,
          chargingStatus: b.chargingStatus ?? null,
          errCode: b.errCode ?? null,
          // Charging beyond what PV covers = grid-sourced (usually 0).
          gridToBatteryW: Math.max(0, (b.chargeW ?? 0) - Math.min(b.pvW ?? 0, b.chargeW ?? 0)),
          storedKwh: b.soc != null ? Math.round(((b.soc / 100) * CONSTANTS.capacityKwh) * 100) / 100 : null,
        }
      : null;

    const config = await resolveBatteryConfig(anker, getLiveBattery, {
      forceRefresh: req.query.refresh === "1",
    });

    const fs = b?.featureSwitch ?? null;
    res.json({
      ok: true,
      data: {
        live,
        config,
        features: {
          raw: fs,
          zeroExport: fs?.["0w_feed"] ?? null,
          socEnable: fs?.soc_enable ?? null,
          multiPv: fs?.multi_pv ?? null,
          heating: fs?.heating ?? null,
        },
        constants: CONSTANTS,
      },
    });
  });
}
