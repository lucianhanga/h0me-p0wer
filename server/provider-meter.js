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

function providerDelta(fromMs, toMs) {
  const rows = getProviderMeterSamples(fromMs, toMs);
  const baseline = counterIncreaseBaseline(rows);
  if (!baseline) return null;
  const last = rows[rows.length - 1];
  return {
    from: baseline.ts,
    to: last.ts,
    baselineImportKwh: baseline.importKwh,
    providerImportKwh: r3(last.importKwh - baseline.importKwh),
    providerExportKwh: r3(last.exportKwh - baseline.exportKwh),
  };
}

function accuracyForWindow(key, fromMs, toMs) {
  const delta = providerDelta(fromMs, toMs);
  if (!delta) return { key, available: false, reason: "waiting-official-change" };
  const gen2ImportKwh = integrateGridImportKwh(delta.from, delta.to, 3);
  return {
    key,
    available: true,
    from: delta.from,
    to: delta.to,
    baselineImportKwh: delta.baselineImportKwh,
    providerExportKwh: delta.providerExportKwh,
    ...accuracyDelta({ providerImportKwh: delta.providerImportKwh, gen2ImportKwh }),
  };
}

export function accuracyWindows(nowMs = Date.now()) {
  const windows = [
    ["1h", nowMs - 3600000],
    ["24h", nowMs - 86400000],
  ];
  const first = getFirstProviderMeterSample();
  if (first) windows.push(["tracked", first.ts]);
  return windows.map(([key, from]) => accuracyForWindow(key, from, nowMs));
}
