# AI Welcome Tab — Design (2026-09-12)

Status: awaiting user review → then implementation plan.

## Goal

A 5th tab ("Welcome", first/default tab) that greets the user each morning with
an AI-written briefing: today's weather, week/month sun outlook, estimated PV
production for the planned 1 kWp system, start-of-day snapshot vs. predicted
end-of-day state (battery, house supply), and estimated savings.

Architecture: **Option A — single structured AI call.** The server gathers all
facts deterministically, then makes ONE OpenAI-compatible chat completion with
`response_format: json_schema`. No agent loop, no tool plumbing.

## Configuration (.env)

Reused as-is: `TARIFF_EUR_PER_KWH` (already in `.env`, powers the savings math).

New keys (placeholders go into `.env.example`; real values only in `.env`):

```sh
# Home location — geocoded once via Nominatim, cached in SQLite
HOME_ADDRESS=Braunaugenstr. 53, 80939 Muenchen, Germany

# Planned PV system (not yet installed — estimates are pre-installation)
PV_PEAK_KWP=1.0                 # 2 × 500 W
PV_ORIENTATION=SSW              # 16-point cardinal symbol, see mapping below
PV_TILT_DEG=17
PV_PANEL_TYPE=JA Solar JAM60D41-500/LB (NAKA) 2x500W c-Si   # informational, fed to the AI

# AI provider — generic on purpose: any OpenAI-compatible endpoint works
# (Kimi Code subscription today; api.moonshot.ai or OpenAI later by only
# changing these three vars)
AI_API_KEY=
AI_BASE_URL=https://api.kimi.com/coding/v1
AI_MODEL=k3
AI_LANGUAGE=en                  # language of the AI prose
```

Cardinal → PVGIS `aspect` mapping (aspect: 0 = south, + = west, − = east):
`aspect = compass_deg − 180`, compass from the standard 16-point table
(SSW = 202.5° → aspect +22.5; S = 180 → 0; SE = 135 → −45; …). The server
validates against the 16 symbols and fails config-loud on anything else.

PVGIS facts already established for this location/setup (and re-fetched at
runtime): yearly ≈ 1048 kWh/kWp (optimal S/38° would be 1115, −6% ≈ €20/yr —
not worth changing), September ≈ 95 kWh/kWp.

## Server: `server/welcome.js` + `GET /api/welcome`

Pipeline per request (served from cache when fresh):

1. **Geocode** `HOME_ADDRESS` via Nominatim
   (`https://nominatim.openstreetmap.org/search`, custom `User-Agent`,
   `format=json&limit=1`). Result `{lat, lon, displayName}` stored in SQLite
   table `welcome_geo` keyed by the address string — re-geocoded only when the
   config value changes.
2. **Weather** — Open-Meteo, one call:
   `https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&timezone=Europe/Berlin&forecast_days=7`
   `daily=sunrise,sunset,sunshine_duration,shortwave_radiation_sum,temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max`
   `hourly=shortwave_radiation,cloudcover`
3. **Solar climatology** — PVGIS `PVcalc?lat=..&lon=..&peakpower=<PV_PEAK_KWP>&loss=14&angle=<PV_TILT_DEG>&aspect=<mapped>&outputformat=json`
   → per-month kWh for the exact setup. Cached 24 h (table `welcome_pvgis`).
4. **Consumption profile** — from existing SQLite data, no cloud calls:
   average grid-import kWh by weekday (last 8 complete weeks from
   `cloud_history` day rows), current month vs. year-to-date monthly averages,
   today's actuals so far (from `snapshots`).
5. **Battery state** — latest SOC + charge/discharge from the in-memory
   battery state (MQTT/REST, same source as `/api/battery/live`, DB fallback);
   **start-of-day snapshot** = SOC of the first `battery_snapshots` row at or
   after today's sunrise (from step 2).
6. **AI call** — `POST {AI_BASE_URL}/chat/completions`:
   - `model: AI_MODEL`, `reasoning_effort: "low"` (ignored by providers that
     don't support it), `response_format: {type: "json_schema", ...}`,
     timeout 30 s.
   - System prompt: role (home-energy morning briefing), hard rules — use ONLY
     the provided numbers for weather/sun facts; estimates must reference the
     provided consumption averages, PV climatology and tariff; respond in
     `AI_LANGUAGE`; keep every statement ≤ 3 sentences.
   - User message: one JSON object with everything from steps 1–5 plus tariff
     and panel description.
   - Response validated against the schema below; invalid → one retry with a
     "return valid JSON per schema" nudge; still invalid → fallback path.

### AI response contract (json_schema, all fields required)

```json
{
  "greeting": "time-of-day aware, references the actual weather",
  "today": { "summary": "…", "icon": "sun|cloud-sun|cloud|rain|snow" },
  "week": { "statement": "best/worst sun days" },
  "month": { "statement": "seasonal expectation for <month> at this location" },
  "production": { "todayKwh": 0.0, "weekKwh": 0.0, "monthKwh": 0.0, "reasoning": "short" },
  "endOfDay": { "batterySocEstimate": 0, "toHouseKwh": 0.0, "toBatteryKwh": 0.0,
                "gridExportKwh": 0.0, "note": "…" },
  "savings": { "todayEur": 0.0, "monthEur": 0.0, "note": "…" }
}
```

The API response merges this with server-computed ground truth the model must
not own: `today.sunrise/sunset/sunHours/tempMin/tempMax` (from Open-Meteo) and
`startOfDay` (real measured snapshot: sunrise time, battery SOC, grid import
so far). End-of-day = AI prediction; start-of-day = measurement.

### Caching & rate budget

- AI result cached in memory + SQLite (`welcome_cache`), **TTL 6 h → max 4 AI
  calls/day** (weather doesn't change faster). Steps 2–5 re-run on each cache
  miss only; PVGIS 24 h; geocode permanent.
- `GET /api/welcome` always returns the newest cache entry; on cache miss with
  any upstream failure it serves the last entry regardless of age (flagged
  `stale: true` with `generatedAt`).
- Cold start with AI unavailable/no `AI_API_KEY`: deterministic fallback —
  same JSON shape, numbers from the deterministic inputs (production =
  PVGIS month average prorated by today's radiation vs. monthly average),
  template prose instead of AI prose (`aiPowered: false` flag so the UI can
  show it discreetly).

## Frontend

- `App.jsx`: `{ key: "welcome", label: "Welcome" }` prepended to `PAGES`;
  default route (no hash) → welcome.
- `web/src/welcome/WelcomeTab.jsx` + styles in `styles.css`, existing dark
  tile theme, no new dependencies:
  - greeting header (with `generatedAt` / `stale` / `aiPowered` indicators)
  - **Today card**: weather icon (inline SVG per `icon` enum), temp min/max,
    sun hours, sunrise→sunset arc graphic with current-time marker
  - **Week** and **Month** statement cards
  - **Production card**: today / week / month kWh
  - **Day bookends**: start-of-day (measured) vs. end-of-day (predicted)
    cards — battery SOC percentages (text), kWh to house / to battery / grid export
  - **Savings card**: € today / month (tariff from config)
- Polls `/api/welcome` every 5 min (cheap — server cache).
- Responsive: cards stack ≤600px like the Live tab; no horizontal scroll.

## Error handling

| Failure | Behavior |
|---|---|
| AI down / invalid key / rate limit | stale cache → fallback (deterministic) mode |
| Open-Meteo down | stale cache whenever a cache exists; on cold start (no cache): generic error state — the deterministic fallback needs weather, so there is nothing sensible to render |
| PVGIS down | 24 h cache; else month estimate marked unavailable, AI told to omit precision |
| Geocode fail | config error surfaced in `/api/welcome` `error` field; tab shows setup hint |
| No `HOME_ADDRESS` / no `AI_API_KEY` | tab renders setup instructions instead of crashing |

All upstream fetches: 10 s timeout (AI 30 s), failures never crash the server
(same discipline as `AnkerMqtt`).

## Security

- `AI_API_KEY` is server-side only: never in `/api/*` responses, never in the
  client bundle; `.env` stays git-ignored (chmod 600 on the server).
- `.env.example` gets the new keys with empty/placeholder values.
- The Kimi key used for development was pasted in plain chat — recommend
  rotating it; the config makes that a one-line change.

## Cost

≤ 4 AI calls/day × ~3 k tokens ≈ trivial against the Kimi Code subscription;
weather/geocode/PVGIS APIs are free and keyless.

## Testing / verification (no test framework in this repo)

- CI (`build-and-check`): deps, vite build, `node --check`, offline smoke.
- Manual: `curl /api/welcome` (live + kill-AI fallback), headless-Chrome
  screenshots of the tab portrait/landscape, rotate-phone sanity.

## Out of scope (later iterations)

- Agentic tool loop / free-form questions to the AI (Option B).
- Real PV monitoring once the panels + CT are installed (then production
  estimates become calibration data).
- Per-hour production curve chart.
