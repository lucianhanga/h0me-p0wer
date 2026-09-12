# AI Welcome Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 5th, default "Welcome" tab that serves an AI-written morning briefing (weather, sun, PV production estimate, day bookends, savings) backed by one structured AI call, max 4×/day.

**Architecture:** Server gathers facts deterministically (Nominatim geocode, Open-Meteo forecast, PVGIS climatology, SQLite consumption/battery data), then makes ONE OpenAI-compatible chat completion (`response_format: json_schema`, model/base-url/key from env) and caches the result 6 h. Degrades to stale cache → deterministic fallback (`aiPowered: false`) — the tab never renders empty.

**Tech Stack:** Node 20+ ESM (`node:sqlite`, global `fetch`, no new dependencies), Express 4, React + Vite (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-12-ai-welcome-tab-design.md` — read it first; this plan implements it task by task.

## Global Constraints

- **No new npm dependencies** anywhere (server or web). `fetch` + `AbortController` are global in Node 20+.
- **No test framework exists in this repo — do not create one.** Each task's verification is the scripted command given in its steps (`node --check`, `node -e` assertions, `curl`, vite build, headless screenshot). This follows the repo convention.
- Branch: `feature/ai-welcome-tab` (already exists, spec commit on it). One commit per task.
- Server files are ESM (`"type": "module"`), no build step; keep the existing flat `server/*.js` layout and code style (2-space indent, no comments unless they record a hard-won fact).
- `.env` is git-ignored and never read into chat/logs; new real values are appended only in Task 6. `.env.example` gets placeholders only.
- `AI_API_KEY` must never appear in `/api/*` responses or the client bundle.
- Cloud period dates are account-local days: format with a local-components `localDate()` (copy the 4-line helper — do NOT import it from `index.js`, that would be a circular import).
- Upstream fetch timeouts: 10 s (weather/geocode/PVGIS), 30 s (AI). Failures never crash the server.
- AI cache TTL: **6 h** (max 4 AI calls/day). PVGIS cache: 24 h. Geocode: permanent (keyed by address).

---

### Task 1: DB layer — welcome KV store + sunrise battery query

**Files:**
- Modify: `server/db.js` (append at the end)

**Interfaces:**
- Produces: `kvGet(key) → {value: any, fetchedAt: number} | null` (JSON-decoded), `kvSet(key, value)` (JSON-encodes, `fetched_at = Date.now()`), `getFirstBatteryAfter(fromMs) → {ts, soc} | null` (first `battery_snapshots` row with `ts >= fromMs`).

- [ ] **Step 1: Append to `server/db.js`**

```js
// --- Welcome tab: key-value cache (geocode, PVGIS, AI result) --------------

db.exec(`
  CREATE TABLE IF NOT EXISTS welcome_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )
`);

const kvGetStmt = db.prepare(`SELECT value, fetched_at FROM welcome_store WHERE key = ?`);
const kvSetStmt = db.prepare(
  `INSERT OR REPLACE INTO welcome_store (key, value, fetched_at) VALUES (?, ?, ?)`,
);

export function kvGet(key) {
  const r = kvGetStmt.get(key);
  return r ? { value: JSON.parse(r.value), fetchedAt: r.fetched_at } : null;
}

export function kvSet(key, value) {
  kvSetStmt.run(key, JSON.stringify(value), Date.now());
}

// First battery sample at/after a moment (start-of-day SOC at sunrise).
const selectFirstBatteryAfter = db.prepare(
  `SELECT ts, soc FROM battery_snapshots WHERE ts >= ? AND soc IS NOT NULL ORDER BY ts ASC LIMIT 1`,
);

export function getFirstBatteryAfter(fromMs) {
  return selectFirstBatteryAfter.get(fromMs) ?? null;
}
```

- [ ] **Step 2: Verify against a throwaway DB**

Run:
```bash
cd server && DB_PATH=/tmp/welcome-test.db node -e "
const db = await import('./db.js');
db.kvSet('geo:test', { lat: 48.2 });
console.log('kvGet:', JSON.stringify(db.kvGet('geo:test')));
console.log('kvGet missing:', db.kvGet('nope'));
db.saveBatterySnapshot({ ts: 1000, soc: 42, outputW: 0, chargeW: 0, pvW: 0, toHomeW: 0 });
console.log('firstAfter:', JSON.stringify(db.getFirstBatteryAfter(500)));
console.log('firstAfter none:', db.getFirstBatteryAfter(2000));
" --input-type=module
```
Expected: `kvGet: {"value":{"lat":48.2},...}`, `kvGet missing: null`, `firstAfter: {"ts":1000,"soc":42}`, `firstAfter none: undefined`. Then `rm -f /tmp/welcome-test.db`.

- [ ] **Step 3: Syntax check + commit**

```bash
node --check server/db.js
git add server/db.js && git commit -m "Welcome tab: KV cache table + sunrise battery query"
```

---

### Task 2: `server/welcome-sources.js` — config parsing + cardinal mapping

**Files:**
- Create: `server/welcome-sources.js`

**Interfaces:**
- Produces:
  - `CARDINALS` — 16-point map `{ N: 0, NNE: 22.5, …, SSW: 202.5, …, NNW: 337.5 }`.
  - `cardinalToAspect(sym) → number` — PVGIS aspect (0 = south, + = west); throws on invalid symbol.
  - `parseWelcomeConfig(env) → config | null` — returns `null` when `HOME_ADDRESS` is unset; throws on invalid `PV_ORIENTATION` / non-numeric PV values.
  - `localDate(d)` — local-components `yyyy-MM-dd` (copy from index.js, do not import).

- [ ] **Step 1: Create `server/welcome-sources.js`**

```js
// Data sources for the Welcome tab: config, geocoding, weather, PVGIS.
// All fetches time out fast and never throw past the route handler's catch.

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const CARDINALS = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

// PVGIS aspect convention: 0 = south, negative = east, positive = west.
export function cardinalToAspect(sym) {
  const deg = CARDINALS[sym?.toUpperCase()?.trim()];
  if (deg == null) {
    throw new Error(
      `PV_ORIENTATION must be one of ${Object.keys(CARDINALS).join(", ")} — got "${sym}"`,
    );
  }
  return deg - 180;
}

export function parseWelcomeConfig(env = process.env) {
  if (!env.HOME_ADDRESS) return null; // tab shows setup instructions
  const peakKwp = Number(env.PV_PEAK_KWP ?? 1);
  const tiltDeg = Number(env.PV_TILT_DEG ?? 17);
  if (!(peakKwp > 0) || !(tiltDeg >= 0 && tiltDeg <= 90)) {
    throw new Error(`PV_PEAK_KWP/PV_TILT_DEG not numeric: ${env.PV_PEAK_KWP}/${env.PV_TILT_DEG}`);
  }
  return {
    address: env.HOME_ADDRESS,
    pv: {
      peakKwp,
      orientation: (env.PV_ORIENTATION ?? "S").toUpperCase().trim(),
      aspect: cardinalToAspect(env.PV_ORIENTATION ?? "S"),
      tiltDeg,
      panelType: env.PV_PANEL_TYPE ?? "unknown c-Si",
    },
    ai: {
      apiKey: env.AI_API_KEY ?? "",
      baseUrl: (env.AI_BASE_URL ?? "https://api.kimi.com/coding/v1").replace(/\/$/, ""),
      model: env.AI_MODEL ?? "k3",
      language: env.AI_LANGUAGE ?? "en",
    },
    tariff: Number(env.TARIFF_EUR_PER_KWH ?? 0.3),
  };
}
```

- [ ] **Step 2: Verify mapping + config**

Run:
```bash
cd server && node -e "
const s = await import('./welcome-sources.js');
console.log('SSW →', s.cardinalToAspect('SSW'));   // 22.5
console.log('S →', s.cardinalToAspect('S'));       // 0
console.log('SE →', s.cardinalToAspect('se'));     // -45
try { s.cardinalToAspect('SSX'); } catch (e) { console.log('invalid OK:', e.message.slice(0, 40)); }
console.log('no address:', s.parseWelcomeConfig({}));
const c = s.parseWelcomeConfig({ HOME_ADDRESS: 'Braunaugenstr. 53, 80939 Muenchen', PV_ORIENTATION: 'SSW', PV_PEAK_KWP: '1', PV_TILT_DEG: '17', TARIFF_EUR_PER_KWH: '0.30' });
console.log('config:', JSON.stringify(c.pv), c.ai.baseUrl, c.tariff);
" --input-type=module
```
Expected: `22.5`, `0`, `-45`, invalid throws, `no address: null`, config shows `aspect: 22.5`, default base URL `https://api.kimi.com/coding/v1`, tariff `0.3`.

- [ ] **Step 3: Commit**

```bash
node --check server/welcome-sources.js
git add server/welcome-sources.js && git commit -m "Welcome tab: config parsing + cardinal→PVGIS aspect mapping"
```

---

### Task 3: External fetchers — geocode, weather, PVGIS (with KV caching)

**Files:**
- Modify: `server/welcome-sources.js` (append)

**Interfaces:**
- Consumes: `kvGet`/`kvSet` from `server/db.js` (Task 1).
- Produces:
  - `fetchJson(url, { timeoutMs = 10000, headers = {} })` — throws on non-2xx or timeout.
  - `geocode(address) → { lat, lon, displayName }` — permanent KV cache under `geo:${address}`.
  - `fetchWeather(lat, lon) → { daily: [...7], hourly: {...} }` — raw Open-Meteo shape, no cache (cached by the orchestrator).
  - `fetchPvgis(lat, lon, pv) → { monthly: [{month, kwh}], yearlyKwh }` — 24 h KV cache under `pvgis:...`.

- [ ] **Step 1: Append to `server/welcome-sources.js`**

```js
import { kvGet, kvSet } from "./db.js";

export async function fetchJson(url, { timeoutMs = 10000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url.slice(0, 80)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Nominatim usage policy: identify the app, don't re-geocode — hence the
// permanent per-address cache.
export async function geocode(address) {
  const key = `geo:${address}`;
  const hit = kvGet(key);
  if (hit) return hit.value;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const rows = await fetchJson(url, { headers: { "User-Agent": "h0me-p0wer/0.3 (private home dashboard)" } });
  if (!rows.length) throw new Error(`address not found: ${address}`);
  const value = { lat: Number(rows[0].lat), lon: Number(rows[0].lon), displayName: rows[0].display_name };
  kvSet(key, value);
  return value;
}

export function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&timezone=${encodeURIComponent("Europe/Berlin")}&forecast_days=7` +
    `&daily=sunrise,sunset,sunshine_duration,shortwave_radiation_sum,temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max` +
    `&hourly=shortwave_radiation,cloudcover`;
  return fetchJson(url);
}

export async function fetchPvgis(lat, lon, pv) {
  const key = `pvgis:${lat},${lon},${pv.peakKwp},${pv.aspect},${pv.tiltDeg}`;
  const hit = kvGet(key);
  if (hit && Date.now() - hit.fetchedAt < 24 * 3600 * 1000) return hit.value;
  const url =
    `https://re.jrc.ec.europa.eu/api/v5_2/PVcalc?lat=${lat}&lon=${lon}` +
    `&peakpower=${pv.peakKwp}&loss=14&angle=${pv.tiltDeg}&aspect=${pv.aspect}&outputformat=json`;
  const j = await fetchJson(url);
  const value = {
    monthly: j.outputs.monthly.fixed.map((m) => ({ month: m.month, kwh: Math.round(m.E_m * 10) / 10 })),
    yearlyKwh: Math.round(j.outputs.totals.fixed.E_y * 10) / 10,
  };
  kvSet(key, value);
  return value;
}
```

- [ ] **Step 2: Verify live (real network, real address)**

Run:
```bash
cd server && node -e "
const s = await import('./welcome-sources.js');
const geo = await s.geocode('Braunaugenstr. 53, 80939 Muenchen, Germany');
console.log('geo:', JSON.stringify(geo));
const w = await s.fetchWeather(geo.lat, geo.lon);
console.log('weather daily rows:', w.daily.time.length, 'sunrise today:', w.daily.sunrise[0]);
const pv = await s.fetchPvgis(geo.lat, geo.lon, { peakKwp: 1, aspect: 22.5, tiltDeg: 17 });
console.log('pvgis yearly:', pv.yearlyKwh, 'sept:', pv.monthly.find(m => m.month === 9));
" --input-type=module
```
Expected: geo ≈ `48.2099, 11.6121`; 7 daily rows with today's sunrise; yearly ≈ 1048, September ≈ 95.4. (Uses the real `server/data.db` for the KV cache — harmless cache rows.)

- [ ] **Step 3: Commit**

```bash
node --check server/welcome-sources.js
git add server/welcome-sources.js && git commit -m "Welcome tab: Nominatim/Open-Meteo/PVGIS fetchers with KV caching"
```

---

### Task 4: `server/welcome-ai.js` — context builder (consumption, battery, day bookends)

**Files:**
- Create: `server/welcome-ai.js`

**Interfaces:**
- Consumes: `getCloudTrend`, `getSnapshotRows`, `getFirstBatteryAfter` from `db.js`; `localDate` from `welcome-sources.js`; `deps = { getLiveBattery: () => object|null, getMeterSn: () => string|null }` (wired in Task 6).
- Produces: `buildContext({ config, geo, weather, pvgis, deps }) → context` — the JSON object handed to the AI (and to the fallback). Shape:

```js
{
  location: { address, lat, lon, displayName },
  date: "yyyy-MM-dd", weekday: "Friday", monthName: "September",
  tariffEurPerKwh: 0.3,
  pvSystem: { peakKwp, orientation, tiltDeg, panelType },
  sun: { sunrise: "06:52", sunset: "19:41", sunHoursToday: 9.4 },
  today: { tempMin, tempMax, weathercode, precipProbMax, radiationSumKwhM2 },
  week: [ { date, weekday, tempMin, tempMax, weathercode, sunHours, radiationSumKwhM2, precipProbMax } ×7 ],
  solarClimatology: { yearlyKwh, monthly: [{month, kwh}] },   // PVGIS for THIS setup
  consumption: {
    avgImportKwhByWeekday: { Mon: 8.1, … },                   // last 56 days, cloud month rows
    monthToDateAvgImportKwh: 9.2,
    yearMonthlyAvgImportKwh: [ { label: "2026-07", importKwh } … ],
    todayImportKwhSoFar: 4.3,
  },
  battery: { socNow, outputW, chargeW, sunriseSoc },          // sunriseSoc = start-of-day snapshot
}
```

- [ ] **Step 1: Create `server/welcome-ai.js`**

```js
// Builds the deterministic fact base for the Welcome briefing. Everything
// here comes from local DB rows or the fetched weather/PVGIS payloads — the
// AI (welcome-ai call below) only interprets these numbers, never invents
// them.
import { getCloudTrend, getSnapshotRows, getFirstBatteryAfter } from "./db.js";
import { localDate } from "./welcome-sources.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const hhmm = (iso) => iso?.slice(11, 16) ?? null;

function dailyImportRows(sn, monthsBack = 2) {
  // cloud_history month rows: label = yyyy-MM-dd, import_energy per day.
  const rows = [];
  const now = new Date();
  for (let i = monthsBack; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = localDate(d).slice(0, 7);
    for (const r of getCloudTrend(sn, "month", ym).rows) {
      if (r.time && r.import_energy != null) rows.push({ date: r.time, importKwh: r.import_energy });
    }
  }
  return rows;
}

function avgImportByWeekday(rows) {
  const cutoff = localDate(new Date(Date.now() - 56 * 86400000));
  const acc = {}; // Mon -> {s, c}
  for (const r of rows) {
    if (r.date < cutoff) continue;
    const wd = WEEKDAYS[new Date(`${r.date}T12:00:00`).getDay()];
    (acc[wd] ??= { s: 0, c: 0 }).s += r.importKwh;
    acc[wd].c++;
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, round1(v.s / v.c)]));
}

export function buildContext({ config, geo, weather, pvgis, deps }) {
  const now = new Date();
  const sn = deps.getMeterSn();
  const daily = weather.daily;
  const dayRows = daily.time.map((t, i) => ({
    date: t,
    weekday: WEEKDAYS[new Date(`${t}T12:00:00`).getDay()],
    tempMin: daily.temperature_2m_min[i],
    tempMax: daily.temperature_2m_max[i],
    weathercode: daily.weathercode[i],
    precipProbMax: daily.precipitation_probability_max[i],
    sunHours: round1((daily.sunshine_duration[i] ?? 0) / 3600),
    radiationSumKwhM2: round1(daily.shortwave_radiation_sum[i]),
    sunrise: hhmm(daily.sunrise[i]),
    sunset: hhmm(daily.sunset[i]),
  }));

  // Today's grid import so far: trapezoid over 5 s samples (local, exact).
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  let todayImportKwh = 0;
  const rows = getSnapshotRows(dayStart.getTime(), now.getTime()).filter((r) => r.grid_total != null);
  for (let i = 1; i < rows.length; i++) {
    const dtH = (rows[i].ts - rows[i - 1].ts) / 3600000;
    if (dtH > 0.25) continue;
    todayImportKwh += (((Math.max(rows[i - 1].grid_total, 0) + Math.max(rows[i].grid_total, 0)) / 2) * dtH) / 1000;
  }

  const imports = sn ? dailyImportRows(sn) : [];
  const ym = localDate().slice(0, 7);
  const mtd = imports.filter((r) => r.date.startsWith(ym) && r.date < localDate());
  const yearRows = sn
    ? getCloudTrend(sn, "year", String(now.getFullYear())).rows.map((r) => ({
        label: r.time, importKwh: round1(r.import_energy),
      }))
    : [];

  const batt = deps.getLiveBattery();
  const sunriseToday = daily.sunrise?.[0] ? new Date(daily.sunrise[0]).getTime() : dayStart.getTime();
  const sunriseBatt = getFirstBatteryAfter(sunriseToday);

  return {
    location: { address: config.address, lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
    date: localDate(),
    weekday: WEEKDAYS[now.getDay()],
    monthName: MONTHS[now.getMonth()],
    tariffEurPerKwh: config.tariff,
    pvSystem: config.pv,
    sun: { sunrise: dayRows[0]?.sunrise, sunset: dayRows[0]?.sunset, sunHoursToday: dayRows[0]?.sunHours },
    today: dayRows[0] ?? null,
    week: dayRows,
    solarClimatology: pvgis,
    consumption: {
      avgImportKwhByWeekday: avgImportByWeekday(imports),
      monthToDateAvgImportKwh: mtd.length ? round1(mtd.reduce((a, r) => a + r.importKwh, 0) / mtd.length) : null,
      yearMonthlyAvgImportKwh: yearRows,
      todayImportKwhSoFar: round1(todayImportKwh),
    },
    battery: batt
      ? { socNow: batt.soc, outputW: batt.outputW, chargeW: batt.chargeW, sunriseSoc: sunriseBatt?.soc ?? null }
      : { socNow: null, outputW: null, chargeW: null, sunriseSoc: sunriseBatt?.soc ?? null },
  };
}
```

- [ ] **Step 2: Verify against the real DB (read-only)**

Run (server may stay up — SQLite allows concurrent readers):
```bash
cd server && node -e "
const s = await import('./welcome-sources.js');
const a = await import('./welcome-ai.js');
const config = s.parseWelcomeConfig({ HOME_ADDRESS: 'Braunaugenstr. 53, 80939 Muenchen, Germany', PV_ORIENTATION: 'SSW', PV_PEAK_KWP: '1', PV_TILT_DEG: '17', TARIFF_EUR_PER_KWH: '0.30' });
const geo = await s.geocode(config.address);
const weather = await s.fetchWeather(geo.lat, geo.lon);
const pvgis = await s.fetchPvgis(geo.lat, geo.lon, config.pv);
const { getAnyDeviceSn, getLatestBattery } = await import('./db.js');
const ctx = a.buildContext({ config, geo, weather, pvgis, deps: { getMeterSn: () => getAnyDeviceSn(), getLiveBattery: () => getLatestBattery() } });
console.log(JSON.stringify({ date: ctx.date, weekday: ctx.weekday, sun: ctx.sun, consumption: ctx.consumption, battery: ctx.battery }, null, 1).slice(0, 1200));
" --input-type=module
```
Expected: today's date/weekday, real sunrise/sunset, non-empty `avgImportKwhByWeekday` (cloud history exists since 2026-09-07), `todayImportKwhSoFar` ≥ 0, battery block (may be nulls if battery is stale — acceptable).

- [ ] **Step 3: Commit**

```bash
node --check server/welcome-ai.js
git add server/welcome-ai.js && git commit -m "Welcome tab: deterministic context builder (consumption, battery, sun)"
```

---

### Task 5: AI call (structured output) + deterministic fallback

**Files:**
- Modify: `server/welcome-ai.js` (append)

**Interfaces:**
- Consumes: `buildContext` (Task 4), `config.ai` (Task 2), `fetchJson` (Task 3).
- Produces:
  - `WELCOME_SCHEMA` — the json_schema object.
  - `callWelcomeAI(config, context) → object` — validated AI response per the spec contract (greeting, today{summary,icon}, week, month, production, endOfDay, savings). One retry: if the endpoint rejects `json_schema` or the reply fails validation, retry with `{"type":"json_object"}`.
  - `buildFallback(config, context) → object` — same shape, deterministic numbers + template prose (`aiPowered: false` is attached by the orchestrator, Task 6).

- [ ] **Step 1: Append to `server/welcome-ai.js`**

```js
import { fetchJson } from "./welcome-sources.js";

export const WELCOME_SCHEMA = {
  name: "welcome",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["greeting", "today", "week", "month", "production", "endOfDay", "savings"],
    properties: {
      greeting: { type: "string" },
      today: {
        type: "object", additionalProperties: false, required: ["summary", "icon"],
        properties: {
          summary: { type: "string" },
          icon: { type: "string", enum: ["sun", "cloud-sun", "cloud", "rain", "snow"] },
        },
      },
      week: { type: "object", additionalProperties: false, required: ["statement"], properties: { statement: { type: "string" } } },
      month: { type: "object", additionalProperties: false, required: ["statement"], properties: { statement: { type: "string" } } },
      production: {
        type: "object", additionalProperties: false,
        required: ["todayKwh", "weekKwh", "monthKwh", "reasoning"],
        properties: {
          todayKwh: { type: "number" }, weekKwh: { type: "number" }, monthKwh: { type: "number" },
          reasoning: { type: "string" },
        },
      },
      endOfDay: {
        type: "object", additionalProperties: false,
        required: ["batterySocEstimate", "toHouseKwh", "toBatteryKwh", "gridExportKwh", "note"],
        properties: {
          batterySocEstimate: { type: "number" }, toHouseKwh: { type: "number" },
          toBatteryKwh: { type: "number" }, gridExportKwh: { type: "number" }, note: { type: "string" },
        },
      },
      savings: {
        type: "object", additionalProperties: false, required: ["todayEur", "monthEur", "note"],
        properties: { todayEur: { type: "number" }, monthEur: { type: "number" }, note: { type: "string" } },
      },
    },
  },
};

const SYSTEM_PROMPT = `You write the morning energy briefing for a home dashboard.
Hard rules:
- Use ONLY the numbers in the provided JSON context for weather, sun and consumption facts. Never invent figures.
- The PV system is PLANNED, not installed: production numbers are estimates from the PVGIS climatology for this exact setup, scaled by today's and the week's forecast radiation vs. the monthly average.
- Estimates (production, end-of-day battery, savings) must be consistent with the context: consumption averages, battery SOC, tariff.
- Currency: EUR. Language for all prose: see language field. Every statement ≤ 3 sentences, plain and friendly.`;

function validateAiResponse(j) {
  for (const k of WELCOME_SCHEMA.schema.required) if (!(k in j)) throw new Error(`AI reply missing "${k}"`);
  if (!WELCOME_SCHEMA.schema.properties.today.properties.icon.enum.includes(j.today?.icon)) {
    throw new Error(`AI reply bad icon "${j.today?.icon}"`);
  }
  return j;
}

export async function callWelcomeAI(config, context) {
  const user = JSON.stringify({ language: config.ai.language, ...context });
  const body = (responseFormat) => ({
    model: config.ai.model,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    response_format: responseFormat,
  });
  const url = `${config.ai.baseUrl}/chat/completions`;
  const headers = { Authorization: `Bearer ${config.ai.apiKey}`, "Content-Type": "application/json" };
  try {
    const j = await fetchJson(url, { timeoutMs: 30000, headers, method: "POST", body: JSON.stringify(body({ type: "json_schema", json_schema: WELCOME_SCHEMA })) });
    return validateAiResponse(JSON.parse(j.choices[0].message.content));
  } catch (err) {
    console.warn(`[welcome] structured AI call failed (${err.message}) — retrying with json_object`);
    const j = await fetchJson(url, { timeoutMs: 30000, headers, method: "POST", body: JSON.stringify(body({ type: "json_object" })) });
    return validateAiResponse(JSON.parse(j.choices[0].message.content));
  }
}
```

Note: `fetchJson` (Task 3) must be extended to pass through `method`/`body` — change its signature to `fetchJson(url, { timeoutMs, headers, method, body })` and forward both to `fetch`. Update the Task 3 code accordingly (one-line change: `fetch(url, { signal, headers, method, body })`).

Also append `buildFallback`:

```js
// Deterministic stand-in when the AI is unreachable: same response shape,
// numbers prorated from PVGIS by today's forecast radiation vs. the month's
// average, template prose instead of AI prose.
export function buildFallback(config, context) {
  const month = new Date().getMonth() + 1;
  const monthKwh = context.solarClimatology?.monthly?.find((m) => m.month === month)?.kwh ?? null;
  const daysInMonth = new Date(new Date().getFullYear(), month, 0).getDate();
  const avgRad = 3.0; // rough Central-Europe yearly mean kWh/m²/day, used only to scale
  const radToday = context.today?.radiationSumKwhM2 ?? avgRad;
  const todayKwh = monthKwh != null ? Math.round(((monthKwh / daysInMonth) * (radToday / avgRad)) * 10) / 10 : null;
  const weekKwh = monthKwh != null
    ? Math.round(context.week.reduce((a, d) => a + ((monthKwh / daysInMonth) * ((d.radiationSumKwhM2 ?? avgRad) / avgRad)), 0) * 10) / 10
    : null;
  const icon = context.today == null ? "cloud" : context.today.weathercode < 2 ? "sun" : context.today.weathercode < 60 ? "cloud-sun" : context.today.weathercode < 80 ? "cloud" : "rain";
  return {
    greeting: `Welcome! ${context.weekday}, ${context.date} — sunrise ${context.sun.sunrise}, sunset ${context.sun.sunset}.`,
    today: { summary: `Between ${context.today?.tempMin ?? "?"}°C and ${context.today?.tempMax ?? "?"}°C, about ${context.sun.sunHoursToday ?? "?"} h of sunshine.`, icon },
    week: { statement: `Sunshine between ${Math.min(...context.week.map((d) => d.sunHours ?? 0))} h and ${Math.max(...context.week.map((d) => d.sunHours ?? 0))} h per day this week.` },
    month: { statement: `Typical ${context.monthName} production for your setup: ~${monthKwh ?? "?"} kWh (PVGIS climatology).` },
    production: { todayKwh, weekKwh, monthKwh, reasoning: "Prorated from PVGIS monthly average by forecast radiation (offline estimate)." },
    endOfDay: {
      batterySocEstimate: context.battery.socNow ?? 0,
      toHouseKwh: context.consumption.monthToDateAvgImportKwh ?? 0,
      toBatteryKwh: 0, gridExportKwh: 0,
      note: "Offline estimate — based on your average consumption; the PV system is still planned.",
    },
    savings: {
      todayEur: todayKwh != null ? Math.round(todayKwh * context.tariffEurPerKwh * 100) / 100 : 0,
      monthEur: monthKwh != null ? Math.round(monthKwh * context.tariffEurPerKwh * 100) / 100 : 0,
      note: `At ${context.tariffEurPerKwh} €/kWh, assuming full self-consumption.`,
    },
  };
}
```

- [ ] **Step 2: Verify the fallback (no network needed beyond earlier caches)**

```bash
cd server && node -e "
const s = await import('./welcome-sources.js');
const a = await import('./welcome-ai.js');
const config = s.parseWelcomeConfig({ HOME_ADDRESS: 'Braunaugenstr. 53, 80939 Muenchen, Germany', PV_ORIENTATION: 'SSW', PV_PEAK_KWP: '1', PV_TILT_DEG: '17', TARIFF_EUR_PER_KWH: '0.30' });
const geo = await s.geocode(config.address);
const weather = await s.fetchWeather(geo.lat, geo.lon);
const pvgis = await s.fetchPvgis(geo.lat, geo.lon, config.pv);
const { getAnyDeviceSn, getLatestBattery } = await import('./db.js');
const ctx = a.buildContext({ config, geo, weather, pvgis, deps: { getMeterSn: () => getAnyDeviceSn(), getLiveBattery: () => getLatestBattery() } });
const fb = a.buildFallback(config, ctx);
console.log(JSON.stringify(fb, null, 1).slice(0, 900));
" --input-type=module
```
Expected: valid object with all 7 top-level keys, plausible production numbers (September ~95 kWh/month → ~3 kWh/day).

- [ ] **Step 3: Verify the real AI call (uses the user-provided key, 1–2 calls)**

First append the key to `.env` ONLY if Task 6 hasn't run yet — for this task use the env var inline, do NOT print it:
```bash
cd server && set -a && source ../.env && set +a && AI_API_KEY="$AI_API_KEY" node -e "
const s = await import('./welcome-sources.js');
const a = await import('./welcome-ai.js');
const config = s.parseWelcomeConfig(process.env);
const geo = await s.geocode(config.address);
const weather = await s.fetchWeather(geo.lat, geo.lon);
const pvgis = await s.fetchPvgis(geo.lat, geo.lon, config.pv);
const { getAnyDeviceSn, getLatestBattery } = await import('./db.js');
const ctx = a.buildContext({ config, geo, weather, pvgis, deps: { getMeterSn: () => getAnyDeviceSn(), getLiveBattery: () => getLatestBattery() } });
const ai = await a.callWelcomeAI(config, ctx);
console.log(JSON.stringify(ai, null, 1).slice(0, 1500));
" --input-type=module
```
(Requires `.env` to already contain the new keys — Task 6 Step 1 adds them; if running tasks strictly in order, do Task 6 Step 1 first, or export `AI_API_KEY` etc. inline.) Expected: all 7 keys present, German/English per `AI_LANGUAGE`, production today within ~0–8 kWh for September.

- [ ] **Step 4: Commit**

```bash
node --check server/welcome-ai.js
git add server/welcome-ai.js server/welcome-sources.js && git commit -m "Welcome tab: structured AI call + deterministic fallback"
```

---

### Task 6: Orchestrator + route + env config

**Files:**
- Create: `server/welcome.js`
- Modify: `server/index.js` (imports + one route registration)
- Modify: `.env.example` (append placeholders)
- Modify: `.env` (append real values — gitignored)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `registerWelcomeRoute(app, deps)` where `deps = { getLiveBattery, getMeterSn }`; endpoint `GET /api/welcome` → `{ ok: true, data: { ...aiResponse, generatedAt, stale, aiPowered, startOfDay, groundTruth } }` or `{ ok: false, error }` with HTTP 200 (tab renders setup/error state from the payload).

- [ ] **Step 1: Append real config to `.env` and placeholders to `.env.example`**

Append to `.env` (do not echo the file back):
```bash
cat >> .env <<'EOF'

# Welcome tab (AI briefing)
HOME_ADDRESS=Braunaugenstr. 53, 80939 Muenchen, Germany
PV_PEAK_KWP=1.0
PV_ORIENTATION=SSW
PV_TILT_DEG=17
PV_PANEL_TYPE=JA Solar JAM60D41-500/LB (NAKA) 2x500W c-Si
AI_API_KEY=sk-kimi-WSK4Mff8oxalN9ceoC2kcLeLYmNYd0sfuBtizHZBY1mXVhSrRE8tMlPitP15NwC9
AI_BASE_URL=https://api.kimi.com/coding/v1
AI_MODEL=k3
AI_LANGUAGE=en
EOF
```

Append to `.env.example`:
```sh
# Welcome tab (AI briefing). HOME_ADDRESS is geocoded once (Nominatim);
# PV_* describe the planned system (cardinal orientation: N,NNE,…,SSW,…);
# AI_* is any OpenAI-compatible endpoint (Kimi Code shown).
HOME_ADDRESS=
PV_PEAK_KWP=1.0
PV_ORIENTATION=SSW
PV_TILT_DEG=17
PV_PANEL_TYPE=
AI_API_KEY=
AI_BASE_URL=https://api.kimi.com/coding/v1
AI_MODEL=k3
AI_LANGUAGE=en
```

- [ ] **Step 2: Create `server/welcome.js`**

```js
// Orchestrates the Welcome briefing: deterministic data gathering (cached
// per TTL), ONE structured AI call, stale-on-error, deterministic fallback
// when the AI is unavailable. The route never throws and never leaks config.
import { kvGet, kvSet } from "./db.js";
import {
  parseWelcomeConfig, geocode, fetchWeather, fetchPvgis,
} from "./welcome-sources.js";
import { buildContext, callWelcomeAI, buildFallback } from "./welcome-ai.js";

const AI_TTL_MS = 6 * 3600 * 1000; // max 4 AI calls/day
const CACHE_KEY = "welcome:latest";

export function registerWelcomeRoute(app, deps) {
  let inflight = null; // dedupe concurrent refreshes

  async function refresh(config) {
    const geo = await geocode(config.address);
    const [weather, pvgis] = await Promise.all([
      fetchWeather(geo.lat, geo.lon),
      fetchPvgis(geo.lat, geo.lon, config.pv),
    ]);
    const context = buildContext({ config, geo, weather, pvgis, deps });
    const ai = config.ai.apiKey ? await callWelcomeAI(config, context) : buildFallback(config, context);
    const payload = {
      ...ai,
      aiPowered: Boolean(config.ai.apiKey),
      generatedAt: new Date().toISOString(),
      stale: false,
      // Ground truth owned by the server — never by the model.
      groundTruth: {
        sunrise: context.sun.sunrise,
        sunset: context.sun.sunset,
        sunHoursToday: context.sun.sunHoursToday,
        tempMin: context.today?.tempMin ?? null,
        tempMax: context.today?.tempMax ?? null,
        week: context.week,
      },
      startOfDay: {
        sunrise: context.sun.sunrise,
        batterySoc: context.battery.sunriseSoc,
        gridImportKwhSoFar: context.consumption.todayImportKwhSoFar,
      },
    };
    kvSet(CACHE_KEY, payload);
    return payload;
  }

  app.get("/api/welcome", async (req, res) => {
    let config;
    try {
      config = parseWelcomeConfig();
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
    if (!config) {
      return res.json({ ok: false, error: "HOME_ADDRESS not set in .env — Welcome tab not configured." });
    }
    const cached = kvGet(CACHE_KEY);
    if (cached && Date.now() - cached.fetchedAt < AI_TTL_MS) {
      return res.json({ ok: true, data: cached.value });
    }
    try {
      inflight ??= refresh(config).finally(() => (inflight = null));
      return res.json({ ok: true, data: await inflight });
    } catch (err) {
      console.warn(`[welcome] refresh failed: ${err.message}`);
      if (cached) return res.json({ ok: true, data: { ...cached.value, stale: true } });
      // Cold start, AI down: deterministic fallback still needs weather; if
      // THAT is what failed, there is nothing sensible to show.
      return res.json({ ok: false, error: `Welcome data unavailable: ${err.message}` });
    }
  });
}
```

- [ ] **Step 3: Wire into `server/index.js`**

Add import near the other local imports:
```js
import { registerWelcomeRoute } from "./welcome.js";
```
Register after the `/api/stats/overview` route block (route order doesn't matter, but keep API routes together; must be BEFORE the `app.get("*", ...)` SPA fallback):
```js
// Welcome tab: AI briefing (geocode + weather + PVGIS + consumption + battery,
// one structured AI call, 6 h cache). Deps read live in-memory state.
registerWelcomeRoute(app, {
  getLiveBattery: () => latestBattery ?? getLatestBattery(),
  getMeterSn: () => poller.snapshot?.meter?.sn ?? getAnyDeviceSn(),
});
```
Note: `latestBattery` is declared with `let` at line ~849, AFTER most routes but the registration only reads it inside the closure at request time — safe as long as `registerWelcomeRoute(...)` is called after the `let latestBattery = null;` declaration. Put the call right after the `syncBattery` interval setup (line ~887), still before `app.get("*")` at line 802? — NO: line 802 executes earlier in file order. Express matches in registration order, so `/api/welcome` must be registered before `app.get("*")`. But `latestBattery` is a `let` binding — referencing it in a closure before its declaration line executes throws TDZ only if the closure RUNS before declaration. Requests arrive after the whole module finished evaluating, so registering the route early is fine. **Register at line ~610 with the other `/api/*` routes** (before the SPA fallback); the closure reads `latestBattery` lazily.

- [ ] **Step 4: Verify end-to-end on a side port**

```bash
cd server && PORT=3100 node index.js & sleep 4
curl -s http://localhost:3100/api/welcome | python3 -m json.tool | head -50
# second call = cached (same generatedAt, fast)
curl -s http://localhost:3100/api/welcome | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print('aiPowered:', d['aiPowered'], '| stale:', d['stale'], '| generatedAt:', d['generatedAt'], '| greeting:', d['greeting'][:80])"
kill %1
```
Expected: first call takes ~3–8 s (weather + PVGIS + AI), `aiPowered: true`, all schema keys present; second call instant with identical `generatedAt`. Also verify fallback mode:
```bash
cd server && PORT=3100 AI_API_KEY= node index.js & sleep 4
# cache is fresh from the run above, so clear it for a real fallback test:
cd server && node -e "const {kvSet}=await import('./db.js'); kvSet('welcome:latest', null);" --input-type=module 2>/dev/null || true
curl -s http://localhost:3100/api/welcome | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print('aiPowered:', d['aiPowered'], '| greeting:', d['greeting'][:80])"
kill %1
```
Expected: `aiPowered: false` with the template greeting. (Clearing the cache writes a `null` row — the next real refresh overwrites it; harmless.)

- [ ] **Step 5: Commit**

```bash
node --check server/welcome.js server/index.js
git add server/welcome.js server/index.js .env.example && git commit -m "Welcome tab: /api/welcome orchestrator with 6h cache + stale/fallback"
```

---

### Task 7: Frontend — WelcomeTab + App wiring + styles

**Files:**
- Create: `web/src/welcome/WelcomeTab.jsx`
- Modify: `web/src/App.jsx`
- Modify: `web/src/styles.css` (append)

**Interfaces:**
- Consumes: `GET /api/welcome` payload from Task 6 (`data.greeting`, `data.today{summary,icon}`, `data.week.statement`, `data.month.statement`, `data.production{todayKwh,weekKwh,monthKwh,reasoning}`, `data.endOfDay{...}`, `data.savings{todayEur,monthEur,note}`, `data.groundTruth{sunrise,sunset,sunHoursToday,tempMin,tempMax,week}`, `data.startOfDay{sunrise,batterySoc,gridImportKwhSoFar}`, `data.generatedAt`, `data.stale`, `data.aiPowered`).

- [ ] **Step 1: Create `web/src/welcome/WelcomeTab.jsx`**

Follow the existing tile/card idiom (dark theme, `muted` for secondary text). Poll every 5 min. Structure:

```jsx
import { useEffect, useState } from "react";

const ICONS = {
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4",
  "cloud-sun": "M12 8a4 4 0 0 1 4 4h-1.5A2.5 2.5 0 0 0 12 9.5 2.5 2.5 0 0 0 9.5 12H8a4 4 0 0 1 4-4Zm-6 9h12a3 3 0 0 0 0-6h-.5A4.5 4.5 0 0 0 9 8.5 4 4 0 0 0 5 12.5 2.5 2.5 0 0 0 6 17Z",
  cloud: "M6 18h12a3.5 3.5 0 0 0 .5-6.97A5 5 0 0 0 9 7.5a4.5 4.5 0 0 0-4.4 5.4A3 3 0 0 0 6 18Z",
  rain: "M6 15h12a3.5 3.5 0 0 0 .5-6.97A5 5 0 0 0 9 4.5 4.5 4.5 0 0 0 4.6 9.9 3 3 0 0 0 6 15Zm1 3-1 2m5-2-1 2m5-2-1 2",
  snow: "M12 3v18m-7-13 14 10M5 16l14-10",
};

function WeatherIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" className="wx-icon" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name] ?? ICONS.cloud} />
    </svg>
  );
}

// Sun arc: semicircle sunrise→sunset with a marker for the current time.
function SunArc({ sunrise, sunset }) {
  const toMin = (s) => Number(s?.slice(0, 2)) * 60 + Number(s?.slice(3, 5));
  const sr = toMin(sunrise), ss = toMin(sunset);
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const frac = ss > sr ? Math.min(1, Math.max(0, (now - sr) / (ss - sr))) : null;
  const angle = frac == null ? null : Math.PI * (1 - frac); // π → 0 left to right
  const cx = 100, cy = 95, r = 80;
  const x = frac == null ? null : cx + r * Math.cos(angle);
  const y = frac == null ? null : cy - r * Math.sin(angle);
  return (
    <svg viewBox="0 0 200 100" className="sun-arc">
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="#2a3238" strokeWidth="2" />
      {x != null && <circle cx={x} cy={y} r="5" fill="#f7a44f" />}
      <text x={cx - r} y={cy + 14} textAnchor="middle" className="arc-label">{sunrise}</text>
      <text x={cx + r} y={cy + 14} textAnchor="middle" className="arc-label">{sunset}</text>
    </svg>
  );
}

export default function WelcomeTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const j = await fetch("/api/welcome").then((r) => r.json());
        if (!alive) return;
        if (j.ok) { setData(j.data); setError(null); } else setError(j.error);
      } catch (e) {
        if (alive) setError(e.message);
      }
    }
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (error) return <p className="muted">Welcome — {error}</p>;
  if (!data) return <p className="muted">Preparing your briefing…</p>;
  const gt = data.groundTruth ?? {};
  return (
    <div className="welcome">
      <section className="card wx-hero">
        <p className="wx-greeting">{data.greeting}</p>
        <p className="muted wx-meta">
          {data.aiPowered ? "AI briefing" : "offline estimate"}
          {data.stale ? " · cached (refresh failed)" : ""} · {new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      </section>

      <section className="card wx-today">
        <WeatherIcon name={data.today.icon} />
        <div>
          <p>{data.today.summary}</p>
          <p className="muted">
            {gt.tempMin}°–{gt.tempMax}°C · {gt.sunHoursToday} h sun
          </p>
        </div>
        <SunArc sunrise={gt.sunrise} sunset={gt.sunset} />
      </section>

      <div className="wx-grid">
        <section className="card"><h3>This week</h3><p>{data.week.statement}</p></section>
        <section className="card"><h3>{new Date().toLocaleString([], { month: "long" })}</h3><p>{data.month.statement}</p></section>

        <section className="card">
          <h3>Estimated production (planned PV)</h3>
          <p className="wx-big">{data.production.todayKwh} kWh <span className="muted">today</span></p>
          <p className="muted">week ≈ {data.production.weekKwh} kWh · month ≈ {data.production.monthKwh} kWh</p>
          <p className="muted">{data.production.reasoning}</p>
        </section>

        <section className="card">
          <h3>Start of day (measured)</h3>
          <p>Sunrise {data.startOfDay.sunrise} · battery {data.startOfDay.batterySoc ?? "—"}%</p>
          <p className="muted">grid import so far {data.startOfDay.gridImportKwhSoFar} kWh</p>
        </section>

        <section className="card">
          <h3>End of day (predicted)</h3>
          <p>battery ≈ {data.endOfDay.batterySocEstimate}% · house ≈ {data.endOfDay.toHouseKwh} kWh</p>
          <p className="muted">to battery ≈ {data.endOfDay.toBatteryKwh} kWh · export ≈ {data.endOfDay.gridExportKwh} kWh</p>
          <p className="muted">{data.endOfDay.note}</p>
        </section>

        <section className="card">
          <h3>Estimated savings</h3>
          <p className="wx-big">≈ €{data.savings.todayEur} <span className="muted">today</span></p>
          <p className="muted">month ≈ €{data.savings.monthEur} · {data.savings.note}</p>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into `web/src/App.jsx`**

- Add import: `import WelcomeTab from "./welcome/WelcomeTab.jsx";`
- Prepend to `PAGES`: `{ key: "welcome", label: "Welcome" },`
- Change both default-route fallbacks from `"live"` to `"welcome"` (initial state and the `hashchange` listener).
- Render first in the ternary chain: `page === "welcome" ? <WelcomeTab /> : page === "live" ? …`

- [ ] **Step 3: Append styles to `web/src/styles.css`**

```css
/* Welcome tab */
.welcome .wx-hero { margin-bottom: 1rem; }
.wx-greeting { font-size: 1.15rem; margin: 0 0 0.25rem; }
.wx-meta { font-size: 0.75rem; margin: 0; }
.wx-today { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
.wx-icon { width: 56px; height: 56px; color: #f7a44f; flex-shrink: 0; }
.wx-today > div { flex: 1 1 220px; }
.sun-arc { width: 200px; max-width: 100%; }
.arc-label { fill: #8b98a5; font-size: 11px; }
.wx-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 1rem; }
.wx-grid h3 { margin: 0 0 0.5rem; font-size: 0.95rem; }
.wx-grid p { margin: 0.25rem 0; }
.wx-big { font-size: 1.3rem; font-weight: 600; }
@media (max-width: 600px) {
  .wx-today { gap: 0.75rem; }
  .wx-icon { width: 44px; height: 44px; }
  .sun-arc { width: 160px; }
}
```
(`.card` already exists for the dashboard tiles — reuse it; verify in `styles.css` that `.card` has the dark tile background/border; if the dashboard uses a different class name, use THAT class in WelcomeTab instead.)

- [ ] **Step 4: Build + visual verification**

```bash
npm run build --prefix web
```
Then with the server running (single-port :3001 serves `web/dist`), screenshot both form factors:
```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=390,844 --virtual-time-budget=12000 --screenshot=/tmp/welcome-portrait.png "http://localhost:3001/?t=$(date +%s)#welcome"
"$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=844,390 --virtual-time-budget=12000 --screenshot=/tmp/welcome-landscape.png "http://localhost:3001/?t=$(date +%s)#welcome"
```
View both PNGs (ReadMediaFile). Expected: default tab is Welcome when opening `/` (no hash), greeting + all 7 cards render, no horizontal overflow; landscape still fine. Also check `#live` still works (regression).

- [ ] **Step 5: Commit**

```bash
git add web/src/welcome/WelcomeTab.jsx web/src/App.jsx web/src/styles.css && git commit -m "Welcome tab: frontend (greeting, weather, production, bookends, savings)"
```

---

### Task 8: Docs, version bump, final verification

**Files:**
- Modify: `AGENTS.md` (new section)
- Modify: `package.json` (root — version 0.2.1 → 0.3.0)

- [ ] **Step 1: Append to `AGENTS.md`** (new section after "Live-tab shell + version")

```markdown
## AI Welcome tab (2026-09-12)

- 5th tab "Welcome" is the DEFAULT route. `GET /api/welcome` (server/welcome.js)
  gathers deterministic facts → ONE OpenAI-compatible AI call
  (`response_format: json_schema`), cached 6 h (max 4 calls/day), stale-on-error,
  deterministic fallback (`aiPowered: false`) when the AI is down.
- Config (`.env`): `HOME_ADDRESS` (geocoded once via Nominatim, cached in the
  `welcome_store` KV table), `PV_PEAK_KWP`/`PV_ORIENTATION` (16-point cardinal,
  mapped to PVGIS aspect = compass−180)/`PV_TILT_DEG`/`PV_PANEL_TYPE`,
  provider-agnostic `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL`/`AI_LANGUAGE`
  (Kimi Code subscription endpoint `https://api.kimi.com/coding/v1`, model `k3`
  — a `sk-kimi-` key does NOT work on `api.moonshot.ai`). `TARIFF_EUR_PER_KWH`
  is reused for savings.
- Data: Open-Meteo (sunrise/sunset, sunshine hours, radiation, 7-day) and
  PVGIS `PVcalc` (monthly kWh for the exact setup, cached 24 h) are free and
  keyless. Consumption averages come from `cloud_history` month/year rows;
  start-of-day SOC = first `battery_snapshots` row after sunrise.
- The PV system is PLANNED (2×500 W, SSW, 17° ≈ 1048 kWh/kWp/yr per PVGIS —
  ~6% below optimal): production figures are estimates, not measurements.
- Server owns ground truth (sun times, temps, start-of-day snapshot); the AI
  only interprets. `welcome_store` KV rows are disposable cache.
```

- [ ] **Step 2: Bump version**

```bash
npm version minor --no-git-tag-version   # 0.2.1 → 0.3.0
npm run build --prefix web               # version is baked via vite define
```

- [ ] **Step 3: Full CI-parity check**

Mirror what `.github/workflows/ci.yml` does: clean install, vite build, `node --check` on all server files, offline smoke (server must START and answer `/api/health` with no meter/cloud/AI network: `PORT=3100 METER_IP=192.0.2.1 CLOUD_ENABLED=false HOME_ADDRESS= node index.js` → `/api/health` 200, `/api/welcome` returns `{ok:false}` setup error, no crash).

- [ ] **Step 4: Commit + push + PR**

```bash
git add AGENTS.md package.json package-lock.json && git commit -m "Welcome tab: docs + v0.3.0"
git push -u origin feature/ai-welcome-tab
gh pr create --title "AI Welcome tab" --body "<summary from spec>"
gh pr checks --watch && gh pr merge --merge
```

---

## Self-review log

- Spec coverage: config (T2, T6) ✓ · geocode/weather/PVGIS (T3) ✓ · consumption+battery context incl. weekday/month/year averages (T4) ✓ · AI contract + retry + fallback (T5) ✓ · 6 h cache/≤4 calls, stale, setup-error states (T6) ✓ · tab cards incl. sun arc + bookends + savings (T7) ✓ · default tab (T7 S2) ✓ · no key in responses (T6: config never serialized into payload) ✓ · AGENTS.md + version (T8) ✓ · `.env.example` placeholders (T6 S1) ✓.
- Type consistency: `payload` merge (`groundTruth`, `startOfDay`) matches WelcomeTab consumption ✓; `buildFallback`/`callWelcomeAI` return the same 7-key shape ✓; `fetchJson` method/body extension is called out in T5 and applied to the T3 file ✓; `deps` shape identical in T4/T6 ✓.
- Placeholders: none — every step has runnable code or exact commands.
