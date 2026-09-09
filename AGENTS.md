# h0me-p0wer — project guide for agents

Dashboard POC for the **Anker SOLIX Smart Meter Gen 2 (AE1X0)**. Two data
sources merged into one stock-chart-style visualization.

## Run

```sh
cp .env.example .env                      # ANKER_EMAIL/ANKER_PASSWORD, METER_IP
npm run setup                             # install server + web deps
npm start                                 # single port :3001 (builds web, serves UI+API+WS)
npm run dev                               # dev mode: backend :3001 + Vite :5173 (hot reload)
```

Auto-start on login: `scripts/com.h0mep0wer.server.plist` →
`~/Library/LaunchAgents/` + `launchctl load` (adjust paths first).

Single-port mode: Express serves `web/dist` + SPA fallback for non-`/api`
GETs. In dev the browser WebSocket connects **directly** to
`ws://localhost:3001/ws` (do NOT proxy it through Vite — proxying caused
EPIPE noise on every client disconnect).

## Architecture

- `server/` — Node 20+ ESM, no build step:
  - `index.js` — Express routes + WS broadcast + cloud sync scheduling
  - `modbus.js` — `MeterPoller`: reads the meter every 5 s, reconnects with 10 s backoff
  - `registers.js` — AE1X0 register map + decoders
  - `anker-cloud.js` — Anker EU cloud client (reverse-engineered auth)
  - `db.js` — SQLite via built-in `node:sqlite` (no native deps)
- `web/` — React + Vite + Apache ECharts (`TimeSeriesChart.jsx` is the main chart)

## Hard-won facts (do not relearn these)

### Modbus / meter
- Register map source: Anker's official HA integration
  (`anker-charging/ha-anker-solix-official`, config YAML for Smart Meter Gen 2).
- **Input registers (FC04), big-endian word order, value = raw / gain**
  (currents gain 100, voltages gain 10). Batch ranges 10620–10646, 10666–10677,
  10696–10712. Key register: `primary_total_active_power` @ 10644 (INT32, W;
  positive = grid import).
- Modbus TCP must be enabled in the Anker app (meter → Settings → Three-Party
  Control Settings). Meter blocks ICMP ping — test with TCP connect on 502.

### Anker cloud
- Base `https://ankerpower-api-eu.anker.com`. Login `POST /passport/login`:
  ECDH P-256 ephemeral key vs Anker's fixed public key (in `anker-cloud.js`),
  AES-256-CBC (key = shared secret, IV = first 16 bytes), PKCS#7, base64.
  Subsequent calls: headers `x-auth-token` + `gtoken` = MD5(user_id). NOT a
  Bearer token.
- **The account has no "sites"** (meter is standalone, `bind_site_status: 0`),
  so site-scoped endpoints (`get_scen_info`, v1 `energy_analysis`) are useless.
  Use the device-level endpoint:
  `POST power_service/v2/device/energy_analysis` with
  `{device_sn, device_type: "grid", type, start_time, end_time}`:
  - `day`: start "yyyy-MM-dd", end "" → 20-min power averages (`data_trend`)
  - `week`: start + end (7-day range) → daily kWh
  - `month`: start "yyyy-MM" · `year`: start "yyyy" → kWh per day/month
- Rate limit ≈ 10–12 req/min/endpoint/IP → background sync is 4 calls/15 min;
  startup backfill of 30 daily trends is throttled to 1 call/6 s.
- Cloud values are strings; `""` = not applicable. Cloud history only exists
  since the meter was linked to the account (2026-09-07).

### Data model (SQLite, `server/data.db`, git-ignored)
- `snapshots`: raw 5 s Modbus samples, 48 h retention, pruned hourly.
- `cloud_history`: `data_trend` rows keyed by (device_sn, period_type,
  period_start, label) + fetched_at. Day-trend labels are meter-local
  "HH:MM:SS"; absolute ts = `new Date(period_start + "T" + label)`.

### `/api/timeseries` merge rules (the chart's contract)
1. Bucket size from the **visible** window (`view` param), rounded up to 5 s,
   never finer than 5 s; ≥ ~800 points per visible window.
2. Local snapshots win over cloud where both cover a bucket. Per-bucket
   min/max envelope (`gridMin/gridMax`) from local samples only.
3. Emit EVERY bucket in the window (nulls where empty) — the old chart library
   needed this; ECharts doesn't, but the frontend still expects dense rows.
4. Skip cloud points from still-open 20-min intervals (partial averages create
   phantom dips at the cloud/local boundary).
5. Bridge consecutive data-bearing buckets (local or cloud anchors) by linear
   interpolation — no cap; cloud anchors are ≤ 20 min apart wherever history
   exists, so interpolation never fabricates more than that.

### Chart (ECharts)
- Chosen over lightweight-charts: LWC's time axis is index-based (collapses
  gaps, clamps ranges to loaded data, index-restore on setData) and caused an
  endless series of view bugs. ECharts `time` axis is continuous and dataZoom
  is value-based — data and zoom are independent, no restore hacks.
- Live updates are **incremental**: fetch only points after the last bucket
  (`bucket` param = current bucketMs), append, slide the window with a
  `programmatic` guard so the shift doesn't trigger a full refetch. Full
  refetch only on user zoom/pan (debounced 250 ms) or span buttons.
- Do not set series `title:` — it renders labels over the line.

### Gotchas already hit
- `node:sqlite` binds JS numbers as REAL → SQL `(ts/b)*b` is float division;
  **bucket in JS, not SQL**.
- `.env` lives at the repo ROOT; `index.js` resolves it relative to the module
  (works from any cwd). Don't "fix" it back to bare `dotenv/config`.
- SIGINT shutdown must terminate WS clients or `server.close()` hangs forever.
- Old server instances on :3001 keep causing "missing route / EADDRINUSE"
  confusion — always check `lsof -nP -iTCP:3001 -sTCP:LISTEN` first.

## Current state / known limitations

- Meter SN syncs from the live Modbus reading (not hardcoded). Cloud sync waits
  for the first snapshot before starting.
- Solar (secondary CT) reads 0 — no solar CT connected at the moment.
- npm's `allow-scripts` blocks esbuild's postinstall on fresh installs:
  `npm approve-scripts esbuild && npm rebuild esbuild` if Vite misbehaves.
- Git identity is repo-local: `lucianhanga` + GitHub noreply email.
- Headless screenshot tooling (Chrome/Playwright) was too slow on this machine;
  `docs/screenshot.png` is a manual capture.

## Ideas for next iterations

- Auto-start both processes (launchd/systemd or a root `npm run dev` with
  concurrently); serve the built frontend from the backend for single-port use.
- kWh integration from local 5 s samples; cost estimation with tariff config.
- Per-phase toggle in the chart (phases are already in `/api/timeseries`).
- Docker packaging.

## Second page: overview dashboard (epic #8, done 2026-09-09)

- Two pages via state-based nav in `App.jsx` (no router): **Live** (original
  content) and **Dashboard** (`web/src/dashboard/`).
- `GET /api/stats/overview` — single aggregate call for all tiles: today's
  kWh (30-min buckets, local samples + cloud anchors merged like
  `/api/timeseries`), day profile, week (from month rows), month, year
  (cloud_history). Never calls the cloud directly.
- Tiles: totals row (Now/Today/Week/Month/Year kWh) + period tiles
  (`DayTile`, `KwhBarsTile` shared for week/month/year, `MiniChart` shared
  ECharts wrapper).
- **Anker week queries must start on Monday** (calendar week Mon→Sun);
  arbitrary 7-day spans fail with `-1 Failed to request`.
- GitHub Project #18 + epic #8 track this; stories #1–#7 each got one commit.
