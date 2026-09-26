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
// How long the (rarely-changing) account config is cached. Was 6 h —
// lowered to 1 h on 2026-09-22 after a user changed the discharge cutoff
// in the Anker app and our app kept showing the old value for hours. 3
// cloud calls per refresh; 24 refreshes/day is still trivially inside the
// rate budget, and the Battery tab's ↻ button (?refresh=1) bypasses the
// cache entirely for immediate pickup.
const CONFIG_TTL_MS = 3600 * 1000;

// A17C3 Solarbank 2 E1600 Plus hardware constants (datasheet).
export const CONSTANTS = {
  model: "A17C3",
  product: "Solarbank 2 E1600 Plus",
  capacityKwh: 1.6, // LFP
  maxAcOutputW: 800, // inverter AC output cap (DE balcony feed-in limit)
  maxPvInputW: 1200, // max PV DC input
};

// Per-model base specs (2026-09-26: the A17C1 Pro replaced the Plus). Both
// are 1.6 kWh base units with the same 800 W AC cap; the Pro takes 4 MPPT /
// 2400 W PV. Unknown pn → the A17C3 defaults (previous behavior).
const BASE_BY_PN = {
  A17C3: CONSTANTS,
  A17C1: {
    model: "A17C1",
    product: "Solarbank 2 E1600 Pro",
    capacityKwh: 1.6,
    maxAcOutputW: 800,
    maxPvInputW: 2400,
  },
};

// The cloud reports only the expansion-pack COUNT (sub_package_num), not
// the pack model — this account's pack is a BP5000 (5 kWh, per the BOM).
// Override via env if a different pack is ever attached.
const EXPANSION_PACK_KWH = Number(process.env.EXPANSION_PACK_KWH ?? 5.0);

// Effective hardware constants for the CURRENT device: base by pn plus
// expansion-pack capacity. storedKwh / ETA / the gauge's "X of Y kWh" all
// derive from capacityKwh, so they follow automatically.
export function resolveConstants(pn, expansionPacks = 0) {
  const base = BASE_BY_PN[pn] ?? CONSTANTS;
  const packs = Number(expansionPacks ?? 0);
  return {
    ...base,
    capacityKwh: Math.round((base.capacityKwh + packs * EXPANSION_PACK_KWH) * 100) / 100,
    expansionPacks: packs,
    expansionPackKwh: EXPANSION_PACK_KWH,
  };
}

const numOrNull = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));

// Derived flow split (2026-09-16 bugfix): `outputW` is the TOTAL inverter AC
// output — pvThrough + cellDischarge combined, per the validated flow model
// (AGENTS.md "Flow model") — NOT battery discharge power on its own.
// Anything that wants to know whether the battery is actually discharging
// must use `cellsW`, not raw `outputW`. Previously only `/api/flow`
// (index.js) computed this; `/api/battery/params` exposed raw `outputW`
// directly, and BatteryTab.jsx's charge/discharge gauge compared raw
// chargeW vs outputW — misreading pure PV pass-through (chargeW=0,
// outputW>0) as "discharging", disagreeing with the Live tab's flow
// diagram (which correctly showed idle/no cells activity). Both routes now
// share this one derivation so they can't drift apart again.
export function deriveBatteryFlow({ pvW = 0, chargeW = 0, outputW = 0 }) {
  const pvToBattery = Math.min(pvW, chargeW);
  // PV pass-through only exists while the inverter is actually outputting.
  const pvToHome = outputW > 0 ? Math.max(0, pvW - chargeW) : 0;
  const cellsW = Math.max(0, outputW - pvToHome);
  const gridChargeW = Math.max(0, chargeW - pvToBattery);
  return { pvToBattery, pvToHome, cellsW, gridChargeW };
}

async function ensureSiteId(anker, getLiveBattery) {
  if (anker.siteId) return anker.siteId;
  const live = getLiveBattery();
  if (live?.siteId) {
    anker.siteId = live.siteId;
    return live.siteId;
  }
  // 2026-09-24: was site_list[0], which silently flipped to the new SB4 site
  // once the account gained a second site — resolveSiteId anchors on the
  // local meter's SN (or SITE_ID env) instead.
  return anker.resolveSiteId();
}

const CUTOFF_EP = "power_service/v1/app/compatible/get_power_cutoff";

// Bare Solarbank 2 systems (no power dock, e.g. this A17C3) don't expose
// charge_upper_limit/discharge_lower_limit via get_site_device_param at all
// (param 18/27 genuinely empty — confirmed against a matching community
// report, thomluther/anker-solix-api#304: "site_device_parm query with
// station parameter does not work for [SB2] yet"). The correct endpoint for
// this hardware is get_power_cutoff, keyed by device_sn (not site_id alone).
async function readPowerCutoff(anker, siteId, deviceSn) {
  if (!deviceSn) return null; // can't call it without a device_sn
  return anker.post(CUTOFF_EP, { site_id: siteId ?? "", device_sn: deviceSn });
}

async function readParam(anker, siteId, paramType) {
  const resp = await anker.post("power_service/v1/site/get_site_device_param", {
    site_id: siteId,
    param_type: paramType,
  });
  const raw = resp?.param_data ?? resp?.data?.param_data ?? null;
  // param_data is a JSON STRING for schedule param types (4/6/9/12/13) but
  // an already-parsed OBJECT for setting param types (16/18/23/26/27/28/29/
  // 30) — 2026-09-16 fix: this used to only handle the string case, so every
  // settings query (18, 27, ...) was silently discarded as "empty" even when
  // Anker returned real data, because typeof raw was "object", not "string".
  if (typeof raw === "string") return raw ? JSON.parse(raw) : null;
  if (raw && typeof raw === "object") return raw;
  return null;
}

// Limit sources tried in order, first non-null value per field wins
// (applyLimits below):
//   1. get_power_cutoff — the CORRECT source for bare Solarbank 2 systems
//      like this A17C3 (see readPowerCutoff's comment above).
//   2. param_type 18 (station settings) — where power-dock/other-generation
//      systems carry the same fields; expected empty on this hardware.
//   3. param_type 27 — Gen4-only equivalent ("no longer in 18" per Anker's
//      own Gen4 migration); expected empty on this hardware too, kept for
//      forward compatibility if the account ever gets a Gen4 device.
// 2026-09-16: previously only tried 18/27, both confirmed genuinely empty on
// this account (not a parsing bug — readParam() correctly handles
// object-shaped param_data as of the same date) — get_power_cutoff added
// because it's the endpoint that actually works for this device family.
async function fetchConfig(anker, getLiveBattery) {
  const siteId = await ensureSiteId(anker, getLiveBattery);
  if (!siteId) throw new Error("no Anker site found");
  const deviceSn = getLiveBattery()?.sn ?? null;

  const config = {
    chargeUpperLimitPct: null,
    dischargeLowerLimitPct: null,
    backupReservePct: null,
    backupReserveSwitch: null,
    socCalibrationEnable: null,
    station: null,
  };
  const applyLimits = (p) => {
    if (!p) return;
    if (config.chargeUpperLimitPct == null) {
      config.chargeUpperLimitPct = numOrNull(p.charge_upper_limit);
    }
    if (config.dischargeLowerLimitPct == null) {
      config.dischargeLowerLimitPct = numOrNull(p.discharge_lower_limit);
    }
    if (config.backupReservePct == null) config.backupReservePct = numOrNull(p.backup_reserve);
    if (config.backupReserveSwitch == null) config.backupReserveSwitch = p.backup_reserve_switch ?? null;
    if (config.socCalibrationEnable == null) {
      config.socCalibrationEnable = p.soc_calibration_enable ?? null;
    }
  };
  try {
    const cutoff = await readPowerCutoff(anker, siteId, deviceSn);
    if (cutoff) {
      // Priority corrected TWICE — the evidence trail: a 2026-09 firmware
      // update introduced the top-level discharge_lower_limit field (the
      // NEW SOC-limit system, cmd_type 1). Reading it first (original code)
      // silently moved the floor 10%→5% after that update, so 2026-09-22
      // flipped priority to the SELECTED power_cutoff_data profile (the
      // community client's approach). WRONG, settled by two live facts on
      // 2026-09-23: (1) the device physically stopped discharging at
      // exactly the top-level value (5%) overnight; (2) the user changed
      // the cutoff in the Anker app and the change landed in the TOP-LEVEL
      // field (→ 8%) while the selected profile stayed at 10% — so the
      // app writes the top-level field too. The top-level field is the
      // live one on this firmware; the selected profile is the legacy
      // fallback for older firmware that lacks the field entirely.
      if (config.dischargeLowerLimitPct == null) {
        const selected = (cutoff.power_cutoff_data ?? []).find((p) => Number(p?.is_selected) > 0);
        config.dischargeLowerLimitPct =
          numOrNull(cutoff.discharge_lower_limit) ??
          numOrNull(selected?.output_cutoff_data);
      }
      applyLimits(cutoff);
      config.powerCutoffRaw = cutoff;
      config.limitsSource ??= "power_cutoff";
    }
  } catch (err) {
    config.errorCutoff = err.message;
  }
  try {
    const p18 = await readParam(anker, siteId, "18");
    if (p18) {
      config.station = p18;
      applyLimits(p18);
      config.limitsSource ??= "account";
    }
  } catch (err) {
    config.error18 = err.message;
  }
  try {
    const p27 = await readParam(anker, siteId, "27");
    if (p27) {
      applyLimits(p27);
      config.raw27 = p27;
      config.limitsSource ??= "account";
    }
  } catch (err) {
    config.error27 = err.message;
  }
  // Fallback when the device exposes nothing on any of the above: SB2
  // schedule (param_type 6, JSON-string param_data) sometimes carries
  // `reserved_soc`; otherwise hardcode the observed defaults.
  if (config.dischargeLowerLimitPct == null) {
    try {
      const sched = await readParam(anker, siteId, "6");
      const reserved = numOrNull(sched?.reserved_soc);
      config.dischargeLowerLimitPct = reserved != null && reserved > 0 ? reserved : 10;
      config.limitsSource ??= reserved != null && reserved > 0 ? "schedule" : "default";
    } catch {
      config.dischargeLowerLimitPct = 10;
      config.limitsSource ??= "default";
    }
  }
  if (config.chargeUpperLimitPct == null) {
    config.chargeUpperLimitPct = 100;
    config.limitsSource ??= "default";
  }
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

export function registerBatteryParamsRoute(app, { anker, getLiveBattery, getSecondBattery }) {
  app.get("/api/battery/params", async (req, res) => {
    // try/catch REQUIRED on every async Express 4 handler (2026-09-22 code
    // review): Express 4 doesn't forward rejected handler promises to its
    // error middleware — a rejection here (e.g. from the config fetch)
    // would be an UNHANDLED rejection and crash the process.
    try {
      const b = getLiveBattery() ?? null;
      const flow = b ? deriveBatteryFlow(b) : null;
      const constants = resolveConstants(b?.pn, b?.expansionPacks);
      const live = b
        ? {
            ts: b.ts ?? null,
            name: b.name ?? "Solarbank",
            sn: b.sn ?? null,
            pn: b.pn ?? null,
            expansionPacks: b.expansionPacks ?? 0,
            soc: b.soc ?? null,
            outputW: b.outputW ?? 0,
            chargeW: b.chargeW ?? 0,
            // Actual battery discharge power — use this, not outputW, to
            // decide "is the battery discharging" (see deriveBatteryFlow).
            cellsW: flow.cellsW,
            pvW: b.pvW ?? 0,
            pv1W: b.pv1W ?? 0,
            pv2W: b.pv2W ?? 0,
            pv3W: b.pv3W ?? null, // 4 MPPT only on the Pro (A17C1) — null on
            pv4W: b.pv4W ?? null, // older hardware, so the UI can tell
            temperatureC: b.temperatureC ?? null,
            toHomeW: b.toHomeW ?? null,
            gridToHomeW: b.gridToHomeW ?? null,
            pvToGridW: b.pvToGridW ?? null,
            homeLoadW: b.homeLoadW ?? null,
            heatingPower: b.heatingPower ?? null,
            chargingStatus: b.chargingStatus ?? null,
            errCode: b.errCode ?? null,
            // Charging beyond what PV covers = grid-sourced (usually 0).
            gridToBatteryW: flow.gridChargeW,
            storedKwh: b.soc != null ? Math.round(((b.soc / 100) * constants.capacityKwh) * 100) / 100 : null,
          }
        : null;

      const config = await resolveBatteryConfig(anker, getLiveBattery, {
        forceRefresh: req.query.refresh === "1",
      });

      const fs = b?.featureSwitch ?? null;
      const primary = {
        live,
        config,
        features: {
          raw: fs,
          zeroExport: fs?.["0w_feed"] ?? null,
          socEnable: fs?.soc_enable ?? null,
          multiPv: fs?.multi_pv ?? null,
          heating: fs?.heating ?? null,
        },
        constants,
      };

      // Second battery (2026-09-24): the account gained a Solarbank 4 on a
      // SEPARATE site — monitored read-only (REST scen_info, memory only, no
      // control/config/history). Live-only payload; config/features/constants
      // are null because none of those endpoints are verified for AE103.
      const b2 = getSecondBattery?.() ?? null;
      const flow2 = b2 ? deriveBatteryFlow(b2) : null;
      const secondary = b2
        ? {
            live: {
              ts: b2.ts ?? null,
              name: b2.name ?? "Solarbank",
              sn: b2.sn ?? null,
              soc: b2.soc ?? null,
              outputW: b2.outputW ?? 0,
              chargeW: b2.chargeW ?? 0,
              cellsW: flow2.cellsW,
              pvW: b2.pvW ?? 0,
              pv1W: b2.pv1W ?? 0,
              pv2W: b2.pv2W ?? 0,
              chargingStatus: b2.chargingStatus ?? null,
              gridToBatteryW: flow2.gridChargeW,
              storedKwh: null, // capacity unknown for this hardware
            },
            config: null,
            features: null,
            constants: null,
          }
        : null;

      res.json({
        ok: true,
        data: {
          ...primary,
          batteries: secondary ? [primary, secondary] : [primary],
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message ?? err) });
    }
  });
}
