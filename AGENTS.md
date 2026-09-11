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
- **Logins are aggressively rate-limited**: repeated fresh logins lock the
  account for 7 min (error 10019). The auth token is persisted next to
  `DB_PATH` (`.token-cache.json`, gitignored, mode 600), `ensureToken()`
  dedupes concurrent logins and applies a 10-min cooldown after failures.
  Never bypass this.
- **Cloud period dates are account-local days** — format them with
  `localDate()` (local components), never `toISOString()` (UTC day shift).
- Graceful shutdown handles SIGINT **and** SIGTERM (Docker/launchd).

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

## Cost estimation (epic #33, done 2026-09-10)

- `TARIFF_EUR_PER_KWH` in `.env` (default 0.30); `/api/stats/overview` →
  `costs`: today/week/month/year € (import kWh × tariff) +
  `batterySavingsToday` (discharged kWh × tariff).
- Dashboard totals tiles show `≈ €X`; battery tile shows `saved ≈ €X`.
- Caveat: battery savings assume discharge replaces grid import at the same
  price — fine once PV exists; overstated if the battery was grid-charged.

## Energy flow visualization (epic #30, done 2026-09-10)

- `GET /api/flow` — computed flows: grid import/export (meter), battery
  discharge/charge, PV split (`pvToBattery = min(pvW, chargeW)`,
  `pvToHome = pvW − pvToBattery`), `home = gridImport + battDischarge + pvToHome`.
  Each group carries its own source timestamp (`grid.ts` = meter snapshot,
  `battery.ts`/`pv.ts` = battery reading; grid's is an ISO string, battery's
  ms epoch) — the flow diagram shows it under each active edge's watt label.
- Live page: SVG `FlowDiagram` (PV/Grid/Home/Battery nodes, animated dashed
  edges in flow direction, 5 s refresh).
- Chart: `pv` series (from `battery_snapshots.pv_w`) on the battery y-axis.
- `/api/stats/overview` → `flows`: today's kWh per flow (trapezoid over
  snapshots/battery_snapshots). Dashboard tiles: Home today, PV today.
- Battery sync is every 30 s (1 scen_info call; siteId cached after first).
  Once the first REST sync yields the battery SN, `server/mqtt.js`
  (`AnkerMqtt`) takes over with realtime MQTT push (see below); REST stays as
  fallback whenever MQTT is disconnected.

## Battery realtime via MQTT (2026-09-10)

- Same channel as the Anker app: `POST app/devicemanage/get_user_mqtt_info`
  returns endpoint + client certs; `mqtts://<endpoint>:8883` with
  ca/cert/key, clientId `{thing_name}_{5 random digits}`, clean session.
- Topics: subscribe `dt/{app_name}/{pn}/{sn}/`, publish commands to
  `cmd/{app_name}/{pn}/{sn}/req` (pn=A17C3). MQTT payload is a JSON envelope
  (`head` + `payload`); the inner `data` is base64 of the binary message.
- Binary message: `FF 09` + LE length (incl. checksum) + pattern
  (`03 00 0f` send / `03 01 0f` recv) + 2-byte msgtype + optional increment
  byte (absent when byte 9 is a field name a0–a9) + TLV fields (1-byte name,
  1-2-byte LE length incl. type byte, type tag < 0x10: 00 str, 01 ui, 02 sile,
  03 var, 04 bin, 05 sfle) + XOR checksum (xor of all bytes incl. itself = 0).
- Telemetry `0405` only streams after publishing the realtime trigger `0057`
  (fields a1=22, a2=on, a3=timeout LE32, fe=unix ts LE32); re-sent every
  4 min (max timeout 600 s). Field map = community `_A17C1_0405`: soc `ad`,
  discharge `b7`×0.01, charge `b0`×0.01, PV `ab`×0.1.
- `AnkerMqtt.start()` never rejects; reconnect doubles backoff to 5 min and
  re-fetches mqtt info (fresh certs). Failures can never crash the server.
- Stall handling (2026-09-11): a connected-but-silent session is detected by a
  watchdog (`lastDataAt`/`connectedAt` older than 120 s → `client.end(true)` →
  reconnect). Backoff resets only when telemetry ARRIVES, not on connect —
  otherwise a broker that accepts but routes nothing churns every 2 min.
  `syncBattery()` gates REST on `batteryMqtt.isFresh()` (not `.connected`), so
  a stalled MQTT session falls back to 30 s REST automatically. `MQTT_DEBUG=1`
  logs every inbound message/parse failure. Seen 2026-09-11: broker accepted
  connack/suback(QoS 1)/puback but routed ZERO messages for hours (trigger
  format verified identical to community `mqtt.py` publish) — an Anker-side
  condition; REST fallback kept data fresh throughout.

## Battery: Solarbank 2 E1600 Plus (epic #25, done 2026-09-10)

- The battery (A17C3) created a **site** in the account — site-scoped
  endpoints (`get_scen_info`, v1 `energy_analysis`) now work.
- Live: `get_scen_info` → `solarbank_info.solarbank_list[0]`:
  `battery_power` = SOC %, `output_power` = discharge W, `bat_charge_power` =
  charge W, `photovoltaic_power` = PV W. Polled every 5 min into
  `battery_snapshots`; `/api/battery/live` (memory + DB fallback, camelCase).
- History: v1 `site/energy_analysis` with `device_type: "solarbank"` works
  (day: `{power:[{time:"HH:MM", value}]}` — note HH:MM, not HH:MM:SS); the
  **v2 device endpoint rejects solarbank**. Synced into `cloud_history`
  under the battery SN, period_type "day".
- Chart: `batt` series in `/api/timeseries` (signed: discharge +, charge −),
  cloud anchors as fallback where live 5-min snapshots are missing.
- Dashboard/Live tiles: SOC gauge bar + discharge/charge/PV status; today's
  discharged/charged kWh = trapezoid over `battery_snapshots` (gaps > 30 min
  skipped).

## Production / Docker (epic #19, done 2026-09-10)

- `Dockerfile` multi-stage: web build → `node:22-alpine` runtime, prod deps,
  non-root `node` user, `DB_PATH` env (default `/data/data.db`).
- `docker-compose.yml`: port 3001, named volume `h0me-p0wer-data` for SQLite,
  `env_file: .env` (untracked, chmod 600 on the server), `TZ=Europe/Berlin`,
  `restart: unless-stopped`, healthcheck on `/api/live`.
- GitHub Actions: `ci.yml` (deps, vite build, node --check, offline smoke
  test on :3100) + `publish.yml` (build+push to GHCR on main,
  `ghcr.io/lucianhanga/h0me-p0wer:latest|sha-<sha>`, public image).
- Secrets never enter git or the image: server-local `.env` only.
- **Meter allows ONE Modbus TCP connection** — no parallel instances. For
  dev+prod coexistence: `MODBUS_TRANSIENT=true` + `POLL_INTERVAL_MS=20000`
  (connect-read-disconnect per cycle instead of a permanent connection).
- Deployment/update flow documented in README "Deploy (Docker, production)".

## Second page: overview dashboard (epic #8, done 2026-09-09)

## Live-tab shell + version (2026-09-11)

- 4-tab shell in `App.jsx` (Live/Graph/Dashboard/History, hash-routed); only
  Live is implemented, the rest are placeholders and old components are parked
  under `web/src/parked/` (not bundled).
- App version comes from the ROOT `package.json` via `define: __APP_VERSION__`
  in `web/vite.config.js`, shown discreetly as `.app-version` in the header.
  Bump the root version when the app changes. The Dockerfile's webbuild stage
  must `COPY package.json /app/package.json` for this (it only copies `web/`).
- Details phase/PV cards (`.phase-cards`) render at ALL widths (wrapping row
  on desktop, stacked on phones) — they were `display:none` above 600px after
  the details table was removed, which emptied the section on desktop.
- `nav` wraps (`flex-wrap`) and phone buttons are compact so nothing forces
  horizontal scrolling.

## Responsive design (epic #13, done 2026-09-10)

- Breakpoints: phone ≤600px, tablet ≤1024px; 44px touch targets on
  `pointer: coarse`; fluid `.app` container.
- Live page: 2-col card grid on phones; `.phase-cards` stacked column.
- Main chart: 240px height on phones (matchMedia), legend `type: "scroll"`,
  `hideOverlap: true` on axis labels; touch pinch/drag zoom is native in
  ECharts inside dataZoom.
- Tiles: period grid uses `minmax(min(320px,100%),1fr)` so it never overflows.
- **CSS comments are `/* */` only** — a `//` comment once silently swallowed
  the `.tiles` rule (tiles rendered full-width stacked).

## Previous: overview dashboard (epic #8, done 2026-09-09)
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
