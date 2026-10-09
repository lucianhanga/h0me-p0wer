# h0me-p0wer — project guide for agents

Home-energy dashboard **and controller** for an **Anker SOLIX** home setup —
**dock era (since 2026-09-27)**: Power Dock AE100 with Solarbank 4 E5000 Pro
(+ BP5000 expansion, 10 kWh) and Solarbank 2 E1600 Pro (+ BP5000, 6.6 kWh) on
its sockets (16.6 kWh total), Smart Meter Gen 2 (AE1X0, local Modbus TCP),
12×500 W PV (6 kWp). Live monitoring, history, AI briefings, ROI tracking,
and a PV-aware power plan that drives the battery schedule. Three view modes:
full (tabs Welcome / Live / Strategy / Graph / Consume / Dashboard / ROI), simple
(default for fresh visitors), and the header toggle between them — see
README.md for the user-facing tour; this file is the "why," not the "what."

**Picking this up fresh (new session, or a different AI in parallel)?** Read
"Current state" right below first, then search this file for a specific
topic/filename rather than reading top to bottom. The chronological decision
log (the reasoning behind non-obvious choices, with incident dates) lives in
**`docs/agent-log.md`** — search it when a behavior looks deliberate-but-odd;
append new session entries there, NOT here. If two sessions/agents work on
this repo at once, coordinate branches the normal git way (separate branches,
PRs, don't both push straight to `main`) — nothing here does that
coordination for you.

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
  - `modbus.js` — `MeterPoller`: reads the meter every 1 s, reconnects with 10 s backoff
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
  **Stale snapshots are nulled in `MeterPoller.getState()`** (older than
  max(60 s, 3× poll interval)) — before this, a lingering snapshot after
  failed reads masqueraded as live "meter" data for minutes (seen on the
  Docker instance 2026-09-14: frozen 907 W, source "meter", timestamp aging).
  The null is what triggers the `/api/flow` + `/api/live` cloud fallback.

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
- **Smart plugs (A17X8, since 2026-10-06)**: v2 `device/energy_analysis`
  REJECTS plug SNs with any device_type; the Shelly endpoint is Shelly-only.
  Live per-plug watts come from `get_scen_info`'s
  `smart_plug_info.smartplug_list[].current_power` (piggybacked on the
  scene poll — 7 s baseline, ~2.5 s while a UI is watched, zero extra
  calls); per-plug DAILY kWh from the `home_usage`
  energy_analysis response's `smart_plug_info` (the query the home-trend
  sync already runs). NO intraday per-plug cloud history exists — the Plugs
  tab's curves are local accumulation (`plug_samples`) and fill in from
  2026-10-06. A not-yet-aggregated day returns an EMPTY smartplug_list (≠ 0
  consumption).

### Data model (SQLite, `server/data.db`, git-ignored)
- `snapshots`: raw 5 s Modbus samples, 48 h retention, pruned hourly.
- `cloud_history`: `data_trend` rows keyed by (device_sn, period_type,
  period_start, label) + fetched_at. Day-trend labels are meter-local
  "HH:MM:SS"; absolute ts = `new Date(period_start + "T" + label)`.
- `plug_samples`: per-plug watts at the scene-poll cadence (7 s baseline,
  ~2.5 s watched), 7-day retention. `plug_daily`: per-plug daily kWh from
  `home_usage`'s smart_plug_info, kept forever.

### `/api/timeseries` merge rules (the chart's contract)
1. Bucket size from the **visible** window (`view` param), rounded up to 5 s,
   never finer than 5 s; ≥ ~800 points per visible window.
2. Local snapshots win over cloud where both cover a bucket. Per-bucket
   min/max envelope (`gridMin/gridMax`) from local samples only.
3. Emit EVERY bucket in the window (nulls where empty) — the old chart library
   needed this; ECharts doesn't, but the frontend still expects dense rows.
4. Skip cloud points from still-open 20-min intervals (partial averages create
   phantom dips at the cloud/local boundary). Also drop a cloud anchor that is
   EXACTLY 0 while BOTH neighboring closed intervals are > 200 W — the cloud
   occasionally reports a bogus zero (seen 2026-09-11 23:40: ~581 → 0 → ~595)
   that V-dips the line; zeros next to other ~0 values are kept (legit
   low/export regions).
5. Bridge consecutive **grid-bearing** buckets (local or cloud anchors) by
   linear interpolation — no cap; cloud anchors are ≤ 20 min apart wherever
   history exists, so interpolation never fabricates more than that. The
   anchor list must contain ONLY buckets that actually hold grid data
   (2026-09-12: a battery-only bucket acting as an "anchor" made the guard
   skip both adjacent intervals → periodic single-bucket null dips at ~5-min
   cadence, visible as the line dropping to zero). Cloud anchors are read one
   20-min interval past the window edges so gaps straddling the boundary
   still bridge (edge anchors are never emitted).
6. `batt` and `pv` interpolate in their own passes between their own anchors
   (samples every ~30 s, at night in pairs ~15 min apart). Battery rows are
   also read one interval past the left edge (gap-straddling rule above).
   The cloud battery day-trend has NO PV channel — pv must bridge between
   pv-bearing anchors only, or cloud-only regions (overnight) stay null.

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
- **Never pass explicit `width`/`height` to `echarts.init`** — they persist in
  the chart's opts and every later `chart.resize()` re-applies the pinned init
  size instead of measuring the container (rotation bug 2026-09-12: chart
  stayed at portrait width after flipping to landscape). Let init measure the
  container; the ResizeObserver + `chart.resize()` then works on rotation.

### Gotchas already hit
- **Device names carry the account's internal prefix** ("h-solar-tv",
  "h-solarbank-4") and INTERNAL lookups depend on the RAW name —
  `PV_PORT_W_<sanitized raw unit name>` env keys are built from it
  (`pvSlotPeakWatts` in index.js). Strip only at UI-payload emit points
  via `displayDeviceName()` (server/device-name.js, 2026-10-07): plugs in
  anker-cloud.js, pvUnits in index.js (AFTER the env lookup), battery
  live names in battery-params.js, plug_daily names on write AND read
  (pre-convention rows stay prefixed in the DB).
- `node:sqlite` binds JS numbers as REAL → SQL `(ts/b)*b` is float division;
  **bucket in JS, not SQL**.
- `.env` lives at the repo ROOT; `index.js` resolves it relative to the module
  (works from any cwd). Don't "fix" it back to bare `dotenv/config`.
- SIGINT shutdown must terminate WS clients or `server.close()` hangs forever.
- Old server instances on :3001 keep causing "missing route / EADDRINUSE"
  confusion — always check `lsof -nP -iTCP:3001 -sTCP:LISTEN` first.
  **After ANY change lands (server OR frontend), always restart the dev
  server** — the frontend bundle is only rebuilt on `npm run build`, and the
  node process never reloads `server/*.js` on its own.
- **Logins are aggressively rate-limited**: repeated fresh logins lock the
  account for 7 min (error 10019). The auth token is persisted next to
  `DB_PATH` (`.token-cache.json`, gitignored, mode 600), `ensureToken()`
  dedupes concurrent logins and applies a 10-min cooldown after failures.
  Never bypass this.
- **Cloud period dates are account-local days** — format them with
  `localDate()` (local components), never `toISOString()` (UTC day shift).
- Graceful shutdown handles SIGINT **and** SIGTERM (Docker/launchd).

## Current state / known limitations

**As of 2026-10-09, v1.5.235, `main`.** Production deploys are the user's own
step (`git pull --ff-only && docker compose up -d --build` on h-iot-serv) —
never deploy from here; read-only SSH diagnosis (`ssh lh@192.168.1.10`) is
fine when the user asks (instruction 2026-09-27). Before diagnosing a
production screenshot, check the deployed version:
`curl -s http://192.168.1.10:3001/api/health | jq .data.version` — most
"it's not fixed" reports were production lagging behind `main`.

- **System**: one Anker site ("h-power", recreated 2026-09-27): Power Dock +
  SB4 + SB2 Pro + meter-2 + **6 Smart Plugs Gen2 (A17X8, since 2026-10-06)**.
  Site resolution is pinned to the site containing the local meter's SN
  (never `site_list[0]`). Production `.env`:
  `METER_IP=192.168.1.15` (meter-2), `PV_PEAK_KWP=6.0`, `STRATEGY_PIN`,
  `BIND_IP=127.0.0.1` (app reachable only via the Cloudflare tunnel).
  Plug surfaces: Consume tab (full view), Consume section (simple view) +
  Consume rows (Dashboard) — all on /api/stats/consumers +
  /api/plugs/timeseries. In-flight WIP from a parallel session 2026-10-09:
  branch `wip/watch-consumers-today` (watch endpoint gains per-plug kWh;
  saved unverified, check the Garmin contract before finishing it).
- **No automated tests anywhere** — verification is manual dry-run scripts,
  the standalone simulation harness pattern (fake Date.now + stateful mock
  anker + real PowerPlanController), and live-in-browser checks.
- **Open items**: docs/phone-*.png screenshots are stale (pre-dock era);
  SB4 (AE103) control-surface writes unverified (ticket #210; its MQTT map
  is verified, PV-field factors sanity-checked only at night); epic #218
  leftovers (multi-battery DB persistence — battery_snapshots is keyed by
  bare ts; module_snapshots is per-module-SN already).

**Standing facts, still true:**
- Meter SN syncs from the live Modbus reading (not hardcoded). Cloud sync
  waits for the first snapshot before starting.
- npm's `allow-scripts` blocks esbuild's postinstall on fresh installs:
  `npm approve-scripts esbuild && npm rebuild esbuild` if Vite misbehaves.
- Git identity is repo-local: `lucianhanga` + GitHub noreply email. Every
  PR bumps root/web/server `package.json` patch version, even doc-only
  fixes — and PRs get merged (not just opened), branch deleted after.
- Home-screen/PWA icons live in `web/public/` (`icon.svg` master, PNGs
  rendered via headless Chrome) — Chrome does NOT scale a bare SVG to tiny
  viewports (renders it 1:1, cropped); re-render sizes through a wrapper
  HTML with an `<img style="width:Npx;height:Npx">`.
- **API token auth** (`server/auth.js`): Bearer token checked against
  `API_TOKEN` in .env, expiry in `API_TOKEN_EXPIRES_AT` (4 weeks);
  `generate-token.js` writes .env directly and warns before replacing a live
  token. Deliberately **fails open when `API_TOKEN` is unset**. Internal
  loopback calls must send the token too — auth once broke them (regression
  fixed in PR #376).
- **Config-drift watchdog** (`server/config-watchdog.js`, 2026-10-09):
  alerts (`config_drift` activity) when the battery schedule (5-min read)
  or smart-plug membership (scene poll) change outside this server —
  account-takeover detection. Own writes self-attribute via
  `powerPlan.hooks.onScheduleWritten` (3-min grace for cloud propagation);
  owner resolves via PIN-protected Accept/Revert in the ActivityBell. No
  auto-rollback (owner's own app changes are legitimate drift).
- **Garmin watch companion** consumes `GET /api/watch/status` (midnight-
  anchored history window, home/battery source split, today's breakdown).
  The contract's source of truth is `h0me-p0wer-garmin/README.md`;
  `WATCH.readme` here is a historical record only — its follow-ups are done.

## Ideas for next iterations

- `BACKFILL_DAYS` (30, `server/index.js`) is a lookback window for the
  startup catch-up, not a retention cap — `cloud_history`/
  `cloud_pv_history`/`cloud_home_history`/`pv_daily`/`grid_daily` are never
  pruned. If more than 30 days of *gap-recovery* reach is ever needed, that
  constant is the one dial to turn — no redesign required.
- BLE channel to the solarbanks as an MQTT-independent path (issue #231) —
  our binary parser already works unchanged over BLE; open questions are
  host Bluetooth hardware/range and the stack choice.

## Decision log

The chronological decision log (every session's entries, newest at the
bottom) lives in **`docs/agent-log.md`** — split out of this file
2026-10-03 when AGENTS.md exceeded the recommended instruction-file size.
Append new entries there. This file stays lean: current state, hard-won
facts, standing rules.
