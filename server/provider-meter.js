import { fetchJson, localDate } from "./welcome-sources.js";
import {
  getFirstProviderMeterSample,
  getLatestProviderMeterSample,
  getProviderMeterSamples,
  saveProviderMeterSample,
} from "./db.js";
import { integrateGridImportKwh } from "./energy-grid.js";

const DERIVE_WINDOW_MS = 60 * 1000;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

export function parseProviderStatus(payload) {
  const sensor = Object.values(payload?.StatusSNS ?? {}).find(
    (v) => v && typeof v === "object" && Number.isFinite(Number(v.ImportActive)),
  );
  if (!sensor) throw new Error("provider meter response has no ImportActive value");
  return {
    importKwh: Number(sensor.ImportActive),
    exportKwh: Number(sensor.ExportActive ?? 0),
    reportedPowerW: Number(sensor.Power ?? 0),
    meterNumber: sensor.Meter_Number ?? null,
  };
}

export function derivePowerW(previous, current) {
  const dtS = (current.ts - previous.ts) / 1000;
  const deltaKwh = current.importKwh - previous.importKwh;
  if (dtS < 1 || deltaKwh < 0) return null;
  return Math.round(((deltaKwh * 1000 * 3600) / dtS) * 10) / 10;
}

export function accuracyDelta({ providerImportKwh, gen2ImportKwh }) {
  const deviationKwh = r3(gen2ImportKwh - providerImportKwh);
  return {
    providerImportKwh: r3(providerImportKwh),
    gen2ImportKwh: r3(gen2ImportKwh),
    deviationKwh,
    deviationPct: providerImportKwh > 0 ? r2((deviationKwh / providerImportKwh) * 100) : null,
  };
}

export class ProviderMeterPoller {
  constructor({ url, intervalMs = 10000 } = {}) {
    this.url = url ?? "";
    this.intervalMs = intervalMs;
    this.latest = null;
    this.lastWarnAt = 0;
  }

  async pollOnce() {
    const payload = await fetchJson(this.url, { timeoutMs: 8000 });
    const parsed = parseProviderStatus(payload);
    const ts = Date.now();
    let derivedPowerW = null;
    if (!(parsed.reportedPowerW !== 0)) {
      const history = getProviderMeterSamples(ts - DERIVE_WINDOW_MS, ts - 1);
      const baseline = history.find((r) => r.importKwh <= parsed.importKwh);
      if (baseline) derivedPowerW = derivePowerW(baseline, { ...parsed, ts });
    }
    const meterReported = parsed.reportedPowerW !== 0;
    const sample = {
      ts,
      ...parsed,
      derivedPowerW: meterReported ? null : derivedPowerW,
      powerSource: meterReported ? "meter" : derivedPowerW != null ? "derived" : "unavailable",
    };
    saveProviderMeterSample(sample);
    this.latest = sample;
    return sample;
  }

  start() {
    if (!this.url) return;
    this.pollOnce().catch((err) => this.warn(err));
    this.timer = setInterval(() => this.pollOnce().catch((err) => this.warn(err)), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  warn(err) {
    if (Date.now() - this.lastWarnAt < 5 * 60 * 1000) return;
    this.lastWarnAt = Date.now();
    console.warn(`[provider-meter] poll failed: ${err.message}`);
  }
}

export function getProviderState() {
  const latest = getLatestProviderMeterSample();
  if (!latest) return { available: false };
  const first = getFirstProviderMeterSample();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayRows = getProviderMeterSamples(dayStart.getTime(), Date.now());
  const hasFullDay = dayRows.length > 0 && dayRows[0].ts - dayStart.getTime() <= 30000;
  const powerW = latest.reportedPowerW !== 0 ? latest.reportedPowerW : latest.derivedPowerW;
  const staleS = Math.max(0, Math.round((Date.now() - latest.ts) / 1000));
  return {
    available: staleS <= 60,
    staleS,
    ts: latest.ts,
    meterNumber: latest.meterNumber,
    importKwh: latest.importKwh,
    exportKwh: latest.exportKwh,
    reportedPowerW: latest.reportedPowerW,
    derivedPowerW: latest.derivedPowerW,
    powerW,
    powerSource: latest.powerSource,
    trackingSince: first?.ts ?? latest.ts,
    trackedImportKwh: first ? r3(latest.importKwh - first.importKwh) : 0,
    trackedExportKwh: first ? r3(latest.exportKwh - first.exportKwh) : 0,
    todayImportKwh: hasFullDay ? r3(latest.importKwh - dayRows[0].importKwh) : null,
    todayExportKwh: hasFullDay ? r3(latest.exportKwh - dayRows[0].exportKwh) : null,
    date: localDate(),
  };
}

export function providerTimeseries(fromMs, toMs, bucketMs) {
  const rows = getProviderMeterSamples(fromMs, toMs);
  const buckets = new Map();
  for (const r of rows) {
    const bt = Math.floor(r.ts / bucketMs) * bucketMs;
    const power = r.reportedPowerW !== 0 ? r.reportedPowerW : r.derivedPowerW;
    if (!buckets.has(bt)) buckets.set(bt, { powerSum: 0, powerCount: 0, importKwh: r.importKwh, exportKwh: r.exportKwh });
    const b = buckets.get(bt);
    if (power != null) {
      b.powerSum += power;
      b.powerCount++;
    }
    b.importKwh = r.importKwh;
    b.exportKwh = r.exportKwh;
  }
  const out = [];
  for (let bt = Math.floor(fromMs / bucketMs) * bucketMs; bt < toMs; bt += bucketMs) {
    const b = buckets.get(bt);
    out.push({
      t: bt,
      power: b?.powerCount ? r2(b.powerSum / b.powerCount) : null,
      importKwh: b?.importKwh ?? null,
      exportKwh: b?.exportKwh ?? null,
    });
  }
  return out;
}

export function counterIncreaseBaseline(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].importKwh > rows[i - 1].importKwh) return rows[i];
  }
  return null;
}

// Samples where the official counter incremented. The meter reports whole
// kWh only, so every event is an EXACTLY known reference quantity — the
// right anchor for accuracy windows (2026-10-22, user request): clock-based
// windows chop fractional kWh at both ends and showed a meaningless
// "4.000 vs 4.573 kWh" deviation; change-anchored windows compare the two
// meters over exactly the same energy.
function changeEvents(rows) {
  const events = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].importKwh > rows[i - 1].importKwh) events.push(rows[i]);
  }
  return events;
}

function accuracyForSpan(key, from, to, providerImportKwh) {
  const gen2ImportKwh = integrateGridImportKwh(from, to, 3);
  return {
    key,
    available: true,
    from,
    to,
    ...accuracyDelta({ providerImportKwh, gen2ImportKwh }),
  };
}

export function accuracyWindows(nowMs = Date.now()) {
  const first = getFirstProviderMeterSample();
  if (!first) {
    return ["lastChange", "24h", "tracked"].map((key) => ({
      key,
      available: false,
      reason: "waiting-official-change",
    }));
  }
  const events = changeEvents(getProviderMeterSamples(first.ts, nowMs));
  const lastChange = events[events.length - 1];
  const prevChange = events[events.length - 2];
  const waiting = { available: false, reason: "waiting-official-change" };

  // Last official increment: previous change → latest change (official
  // delta is exactly one counter step, normally 1 kWh).
  const lastChangeWin =
    lastChange && prevChange
      ? accuracyForSpan(
          "lastChange",
          prevChange.ts,
          lastChange.ts,
          r3(lastChange.importKwh - prevChange.importKwh),
        )
      : { key: "lastChange", ...waiting };

  // ≈24 h, bounded by official changes on BOTH ends (2026-10-22, user
  // catch): starting at the first SAMPLE instead of the first change
  // credited a whole official kWh whose energy was mostly consumed BEFORE
  // the window opened (gen2 rightly measured only the tail — a fake −0.918
  // kWh "deviation"; every complete change→change block matches gen2 within
  // ±0.001). So: last change at or before now−24h (fallback: the FIRST
  // CHANGE, never the first sample) → latest change.
  const dayWin = (() => {
    if (!lastChange || !prevChange) return { key: "24h", ...waiting };
    const boundary = [...events].reverse().find((e) => e.ts <= nowMs - 86400000) ?? events[0];
    if (boundary.ts >= lastChange.ts) return { key: "24h", ...waiting };
    return accuracyForSpan(
      "24h",
      boundary.ts,
      lastChange.ts,
      r3(lastChange.importKwh - boundary.importKwh),
    );
  })();

  // Since tracking started: first observed official change → latest change
  // (change-anchored on both ends — same reason as the 24h window above).
  const trackedWin =
    lastChange && prevChange
      ? accuracyForSpan(
          "tracked",
          events[0].ts,
          lastChange.ts,
          r3(lastChange.importKwh - events[0].importKwh),
        )
      : { key: "tracked", ...waiting };

  return [lastChangeWin, dayWin, trackedWin];
}
