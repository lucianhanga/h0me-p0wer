# h0me-p0wer — project guide for agents

Home-energy dashboard **and controller** for an **Anker SOLIX** balcony
setup: Smart Meter Gen 2 (AE1X0, local Modbus TCP) + Solarbank 2 E1600 Plus
battery + 2×500 W PV — live monitoring, history, AI briefings, ROI tracking,
and its own PV-aware power plan that drives the battery's output preset. Six
tabs: Welcome / Live / Strategy / Graph / Dashboard / ROI — see README.md for
the user-facing tour; this file is the "why," not the "what."

**Picking this up fresh (new session, or a different AI in parallel)?** Read
"Current state" right below first, then search this file for a specific
topic/filename rather than reading top to bottom — the sections below it are
a chronological decision log (newest additions are appended at the bottom),
kept for the reasoning behind non-obvious choices, not meant to be read
start to finish. If two sessions/agents are working on this repo at once,
coordinate branches the normal git way (separate branches, PRs, don't both
push straight to `main`) — nothing here does that coordination for you.

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

**As of 2026-09-22, v1.5.45, `main`, working tree clean, nothing pending.**
Latest: scen_info fast path — 3 s battery/PV sync whenever a frontend is
watching (the Anker app's own live-view mechanism is REST polling, not
MQTT; Anker's MQTT broker was stalled again, delivering zero messages —
see the last log entry). /api/health now exposes batteryMqtt
connected/fresh/lastDataAt.
Latest: graph outlier-cap fixed to require BOTH a ratio AND an absolute
margin (a mostly-0 W window with a legit 100-200 W value was being capped
to 0) — see the last log entry. Also diagnosed 2026-09-22 morning: the
battery at 5% is the ACCOUNT's discharge lower limit having changed
10%→5% (Anker-app side; our app has no write path for it) plus overnight
standby draw — controller behaved correctly (stopped at floor+3%=8%,
zero output all night).
Previously: grid target lowered 100→25 W. A Dashboard "Lag losses" tile built
on the new `/api/stats/overview` `gridTracking` block was REMOVED again
the same evening at the user's request ("this is wrong — get rid of the
new tile, leave it like this for now") — the backend `gridTracking`
payload still ships in the overview response, unused, as the measurement
foundation whenever the idea is revisited. See the last log entries.
Last session's work (PRs #166-177, all merged, chronologically the tail end
of the log below) in one line each:
- Graph tab: y-axis no longer floors above zero at high zoom (#166/167),
  round tick labels + fewer gridlines, each graph's span (1h/6h/.../30d)
  now persists across tab switches (#168), a `from=NaN` live-tick loop
  fixed, and a rare spike no longer flattens the normal range — robust
  (p98) axis cap + an "off-scale" note (#175).
- `/api/timeseries` PV now has real history past the 48h local-sample
  window: first a `pv_daily` flat-average fallback (#171), then upgraded
  to the actual cloud 20-min production curve already being collected but
  unused (`cloud_pv_history`, #172) — see "PV history beyond 48h" below.
- ROI BOM: real product photos (the eBay bundle's was a broken scrape),
  fixed a `Cache-Control: immutable` bug that made a photo fix invisible
  (#169), added two planned three-phase electrical-protection entries
  (#170).
- `house_priority` discharge-floor hysteresis + PV-passthrough-at-floor fix
  (#174) — caught via a code walkthrough with the user BEFORE it caused a
  real yoyo, mirroring the already-fixed `battery_priority` ceiling bug.
- Battery UI: multi-battery-ready vertical card stack (#176), then actual
  visual beautification — hero-sized SOC percentage, meter tinted
  end-to-end by charge level (#177), applying the loaded `dataviz` skill's
  own specs.

**Open / not done:**
- `docs/phone-*.png` (referenced by README.md) are stale — still show
  v0.22.14 and a tab labeled "Battery" (renamed to "Strategy" long ago),
  predating essentially everything in this file. Automated capture failed
  this session (browser automation's `resize_window` reported success
  without ever changing the tab's actual `window.innerWidth`, confirmed via
  JS — so the app never rendered its real mobile layout); user was going to
  capture manually. If you're picking this up: ask before assuming it's
  done, and if these ever get updated, the Graph/ROI/Battery screenshots
  specifically would now look meaningfully different (zero-floored axis,
  real ROI photos, the new hero-figure battery gauge).
- Per-phase (L1/L2/L3) toggle in the Graph tab — the data's already in
  `/api/timeseries`, just not surfaced as a chart option there (it IS
  shown elsewhere, e.g. Live tab's phase cards).
- No automated tests anywhere in the repo (no `*.test.js`, no test runner
  in either `package.json`) — verification this whole session was manual
  dry-run scripts against copies of the real db, or live-in-browser checks
  via the Chrome automation tools, never a checked-in test suite.

**Standing facts, still true:**
- Meter SN syncs from the live Modbus reading (not hardcoded). Cloud sync
  waits for the first snapshot before starting.
- PV live since 2026-09-13: 2×500 W (SSW, 17°) on the Solarbank's DC inputs.
- npm's `allow-scripts` blocks esbuild's postinstall on fresh installs:
  `npm approve-scripts esbuild && npm rebuild esbuild` if Vite misbehaves.
- Git identity is repo-local: `lucianhanga` + GitHub noreply email. Every
  PR this project does bumps root/web/server `package.json` patch version,
  even doc-only or tiny fixes (see this session's PRs for the pattern) —
  and PRs get merged (not just opened) as part of finishing the task,
  branch deleted locally + remotely afterward.
- Production deploys are the user's own step — never SSH/deploy there;
  this repo's job stops at commit/PR/merge to `main`. (The live server at
  the user's LAN address DOES get redeployed fairly promptly after a
  merge in practice — confirmed via curl mid-session — but that's the
  user doing it, not something to rely on or trigger yourself.)
- Home-screen/PWA icons live in `web/public/` (`icon.svg` master, PNGs
  rendered via headless Chrome) — Chrome does NOT scale a bare SVG to tiny
  viewports (renders it 1:1, cropped); re-render sizes through a wrapper
  HTML with an `<img style="width:Npx;height:Npx">` (see `git show` the
  icon commit).

## Ideas for next iterations

- Per-phase (L1/L2/L3) toggle in the Graph tab (see "Open / not done").
- `BACKFILL_DAYS` (30, `server/index.js`) is a lookback window for the
  startup catch-up, not a retention cap — `cloud_history`/
  `cloud_pv_history`/`pv_daily` are never pruned and already hold 30+ days
  on the live account. If more than 30 days of *gap-recovery* reach is
  ever needed (not just organic accumulation), that constant is the one
  dial to turn — no redesign required (discussed at length with the user
  2026-09-20/21, decided NOT to do a wipe-and-repopulate; see "PV history
  beyond 48h" below for why).
- A second physical battery is expected "soon" per the user (2026-09-21)
  — the Battery UI is already structured to take a `data.batteries` array
  with zero frontend changes (see "Battery UI" entry below), but
  `GET /api/battery/params` and everywhere else in the backend that
  assumes exactly one battery device (`getBatterySn()`'s "the one
  cloud_history device_sn that isn't the meter", `power-plan.js`,
  `battery-params.js`) would need real design work once that hardware
  actually exists — deliberately not built speculatively ahead of it.

## Cost estimation (epic #33, done 2026-09-10)

- `TARIFF_EUR_PER_KWH` in `.env` (default 0.30); `/api/stats/overview` →
  `costs`: today/week/month/year € (import kWh × tariff) +
  `batterySavingsToday` (discharged kWh × tariff).
- Dashboard totals tiles show `≈ €X`; battery tile shows `saved ≈ €X`.
- Caveat: battery savings assume discharge replaces grid import at the same
  price — fine once PV exists; overstated if the battery was grid-charged.

## Energy distribution model + display (2026-09-13)

- **Validated against the Anker app's own numbers**: `scen_info` →
  `statistics` = today's PV kWh/CO₂/€ (the app's Produced row);
  `grid_info.grid_to_home_power` == our meter import; the app's Home Load =
  `grid_to_home + to_home_load` == our `home = grid + outputW` — exact match.
- **Dashboard (`byPeriod`)**: `battKwh` is CELLS-only (`discharged − pvToHome`
  — the inverter output includes PV pass-through; counting both double-counts
  PV). `pvKwh` = PV-to-house (gated `pvW − chargeW`). Balance now holds to
  the cent: `home = grid + batt + pv` for every period.
- **`pv_daily` rollup** (db.js): per finished day `{produced, to_home,
  to_batt}` trapezoid over `battery_snapshots` (48 h retention), recomputed
  hourly for the last 2 days — makes week/month/year PV possible despite the
  cloud having no PV channel. (Anker's solarbank week/month/year
  energy_analysis only has discharge power series + static to-date totals;
  period PV production is NOT available from the cloud.)
- **Graph tab: THREE synced graphs (2026-09-15)** sharing one data manager
  (span buttons, live ticks, zoom/pan on any chart moves all three — no
  range sliders): **Home Power Usage** (sources stacked: Grid, PV-to-home,
  Battery out, Battery in sink below, Home line + Grid-range envelope),
  **Power Production** (PV production + its split PV→battery / PV→home),
  **Battery** (Discharging / Charging). Smaller `.chart-box-sm` boxes
  (220 px desktop, 140 px phone, third-viewport landscape). Derived row
  values per the validated model (`pvHomeOf/pvBattOf/battCellsOf/homeOf` in
  `GraphTab.jsx`).

- **Flow model (validated against live PV data + Anker docs, 2026-09-13)** —
  the Solarbank has ONE DC bus: panels + cells in, inverter out
  (**AC output capped at 800 W** — Germany's balcony feed-in limit; seen as
  outW = 799–801 W flat while pvW varies). Measured exact invariants:
  - `pvW = chargeW + pvThrough` (PV splits exactly; charge-only rows show
    pvW == chargeW, split rows pvW == chargeW + outW)
  - `outW == to_home_w` = inverter AC out = pvThrough + cellDischarge
  - **PV→home** = `outW > 0 ? pvW − chargeW : 0` (zero while charging!)
  - **PV→battery** = `min(pvW, chargeW)` · **cells→home** = `outW − (pvW − chargeW)`
  - **home = grid + outW** — NEVER `grid + outW + pvW`: PV is INSIDE the
    inverter output; adding it double-counts (the pre-PV-era approximation
    `pvToHome = pvW − chargeW` ungated invented a PV→home flow while charging).
- `GET /api/flow` — computed flows per above. Each group carries its own
  source timestamp (`grid.ts` ISO string, battery's ms epoch) — shown under
  each active edge's watt label in the diagram.
- Live page: SVG `FlowDiagram` (PV/Grid/Home/Battery nodes, animated dashed
  edges in flow direction, 5 s refresh). **Arcs (2026-09-14, per the Anker
  app's flow view): PV→Battery (`toBattery`), PV→Home (`toHome`), Battery→Home
  (`cells` = outW − pvToHome), Home→Battery (`gridCharge`, grid-sourced
  charge, rare), Grid↔Home.** The Home↔Battery pair is ONE arc showing the
  dominant direction (both can read > 0 briefly while PV splits at the DC
  bus — overlapping opposite arcs looked wrong). Battery node shows
  `soc% ⚡ chargeW` loading / `soc% ⏏ cellsW` unloading. Grid edges carry a
  "· cloud" note when not meter-sourced.
- **Modbus-down**: `/api/flow` prefers the LIVE `scen_info` grid channel
  (`grid_info.grid_to_home_power`, synced every **3 s on demand** while the
  meter is down and a frontend watches — user-requested, above the
  ~10-12/min guideline, failures just log) → `source: "cloud-live"`, then the
  20-min trend (`source: "cloud"`). Home Load then comes from
  `home_load_power` directly. **The same call's grid values are persisted to
  `cloud_grid_snapshots` (every ~10 s) and merged into `/api/timeseries`**
  (source 1c, signed import − PV feed-in) — graphs stay continuous at ~10 s
  resolution with the meter down (user request 2026-09-15).
- Chart: `pv` series (informational, NOT stacked — stacking it would
  double-count); `battOut` (unsigned inverter output) in `/api/timeseries`
  so Home = `grid + max(battOut, 0)` — exact even for simultaneous
  charge+discharge. `batt` stays signed (output − charge) for the stack.
- `/api/stats/overview` → `flows`: today's kWh per flow (trapezoid over
  snapshots/battery_snapshots; pvToHomeKwh uses the gated split above,
  homeKwh = import + discharge).
- Battery sync: **REST `scen_info` every 5 s while a frontend is watching**
  (WS client connected or /api/live|flow polled < 15 s ago; 12 calls/min =
  the documented ceiling, hence on-demand only), **10 s floor when idle**.
  MQTT push (~3-5 s) layers on top as the fast channel (same one the Anker
  app uses for its live view — it does NOT poll REST for that).
- **Modbus-down fallback (2026-09-13)**: when the meter's TCP server refuses
  connections (seen: hung after an app session — Anker app keeps working via
  cloud, local 502 dies; fix in the field: re-enable Modbus TCP or power-cycle
  the meter), `/api/flow` and `/api/live` fall back to the newest CLOSED
  20-min cloud interval (`getCloudGridLive`, flagged `source: "cloud"` with
  the interval-end timestamp), and today's day-trend syncs every 2 min
  instead of 15. Grid card shows "· cloud".

## Per-string PV kWh + consistent updated stamp (2026-09-15)

- The cloud exposes per-string PV **power** only (`solar_power_1/2`,
  persisted as `pv1_w/pv2_w` in battery_snapshots) — no per-string kWh.
  `getPvStringKwhForDay(dateStr)` (db.js) integrates it (trapezoid, gaps
  > 30 min skipped); `/api/flow` returns `pv.pv1KwhToday/pv2KwhToday`
  (30 s memo — the route is polled every 5 s per client) and live
  `battery.pv1W/pv2W`. Live → Details PV1/PV2 tiles show both.
  (Aside: scen_info `statistics` type-1 "kWh" does NOT match the locally
  integrated day total — its window is unclear; trust the integration.)
- **`UpdatedStamp` (`web/src/components/UpdatedStamp.jsx`)** is the single
  "updated HH:MM:SS · sources" line, rendered as the FIRST element of every
  tab (Live/Graph/Dashboard/Welcome) so it always sits right under the nav.
  Don't add per-page timestamp lines elsewhere — extend the stamp's suffix.
- Power Plan UI: collapsible (`.details-toggle`, collapsed by default,
  "active" badge in the header). The disable/restore button was removed
  from the UI on purpose — `POST /api/power-plan/disable` (restores the
  saved Anker schedule) remains API-only.

## Battery tab (2026-09-15)

- 6th tab between Live and Graph (`web/src/battery/BatteryTab.jsx`): animated
  pure-CSS SOC gauge (fill = SOC, green > 50 / orange 20–50 / red < 20,
  shimmer sweep while charging/discharging, cascading chevrons) with the
  configured discharge-lower / charge-upper limits as tick markers ON the
  gauge, plus two spartan parameter cards. Polls every 10 s.
- `GET /api/battery/params` (`server/battery-params.js`, wired in index.js
  next to the other register*Route calls) aggregates:
  - **live**: latestBattery / getLatestBattery() DB fallback (soc, outputW,
    chargeW, pvW, pv1/2W, grid channels, gridToBatteryW, storedKwh).
  - **config**: SUPERSEDED 2026-09-16 — see "Strategy engine + battery
    temperature + real charge limits" below. `get_power_cutoff` is now tried
    first (the endpoint that actually works for this device), then
    `param_type "18"`, then `"27"`; `limitsSource` in the response tells you
    which one won (`power_cutoff`/`account`/`schedule`/`default`).
  - **features**: raw scen_info `feature_switch` (0w_feed = zero-export,
    soc_enable, multi_pv, heating, …) + charging_status/err_code/heating_power
    — `getBatteryInfo()` in anker-cloud.js maps them (featureSwitch,
    chargingStatus, errCode, heatingPower); the DB fallback lacks them
    (battery_snapshots has no columns for them) → nulls, UI shows "—".
  - **constants**: A17C3 datasheet values (1.6 kWh LFP, 800 W max AC,
    1200 W max PV) hardcoded in battery-params.js.
- Live scen_info shape verified on the real account (2026-09-15):
  `charging_status` is a STRING ("0"), `err_code` a number, `heating_power`
  a string W, `feature_switch` a bool map.

## Power-plan controller (2026-09-15)
- `server/power-plan.js` (`PowerPlanController`) drives the Solarbank 2
  output preset itself instead of the static Anker-app schedule. Goal:
  kill the charge/discharge jojo around a fixed preset and maximize PV
  into the house — never export.
- **Write path (spike-verified)**:
  `POST power_service/v1/site/get_site_device_param` /
  `set_site_device_param` with `param_type: "6"` (SB2 schedule), `cmd: 17`
  on write; `param_data` is a JSON **string**. Direct per-device output
  control (MQTT/10004-class endpoints) is blocked for third-party — the
  weekly-schedule preset is the only working control surface, and it is
  enough because the device follows it within ~1 min.
- **Preset semantics (verified live)**: preset = target AC output to home.
  PV ≤ preset → all PV to home, cells top up the difference; PV > preset →
  preset to home, surplus charges the battery. Example: preset 600, PV 600
  → out 600, charge 0, grid covers the rest.
- **Algorithm**: SUPERSEDED 2026-09-16 by the strategy engine below — this
  exact formula is now `house_priority` + `pv_zero` trigger (the default,
  applied automatically on upgrade). PV=0 → `min(800, houseDemand)`; PV>0 →
  `min(PV, houseDemand)` (also covers battery-full — same formula, no
  separate branch needed); clamp to [0, max_load], floor to step (10 W).
  Inputs from `scen_info` (`pvW`, `homeLoadW`, `soc`) on the 10 s battery
  sync.
  **Fixed 2026-09-15 (PV-rounding waste)**: the original PV>0 branch was
  `min(floor(PV/100)*100, houseDemand)` — flooring PV to the nearest 100 W
  rounded the preset BELOW actual PV even when PV < houseDemand, so up to
  99 W of legitimate under-demand PV got misrouted to charge the battery for
  zero cycling benefit (target was already ≤ PV either way, so cells never
  engaged in this branch regardless of the floor). `min(PV, houseDemand)`
  sends 100% of PV to the house whenever PV ≤ demand, and still routes only
  the true excess (PV > demand) to the battery.
- **SOC limits now shared with the Battery tab (2026-09-15)**: the discharge
  floor (`reserve`, blocks any output request once `soc <= reserve`) and
  charge ceiling (`chargeCeilingPct`, informational only — see below) come
  from `battery-params.js`'s `getBatteryLimits()` (same 6 h-cached
  `param_type "27"` config + schedule/hardcoded fallback the Battery tab
  reads) instead of `power-plan.js` reading `reserved_soc` off the schedule
  payload itself. That field is typically absent on this account, so the old
  code's `?? 0` default silently disabled the reserve guard — the battery
  could be discharged with no floor at all. `battery-params.js` exports
  `resolveBatteryConfig()` (the shared cache-check-fetch-fallback, also used
  by `GET /api/battery/params`) and `getBatteryLimits()` (just the two
  percentages). `PowerPlanController` now takes `getLiveBattery` in its
  constructor (needed by `resolveBatteryConfig` → `ensureSiteId`) —
  `new PowerPlanController(anker, () => latestBattery ?? getLatestBattery())`
  in `index.js`. The charge ceiling does NOT change the PV>0 formula (target
  is always ≤ PV there, so it never asks for more charging than PV already
  supplies; pushing target above houseDemand to "use up" a full battery
  would risk exporting) — it's surfaced in `lastDecision.chargeCeilingPct` /
  `.atChargeCeiling` for visibility/debugging, not used to branch.
- **Write discipline**: only on ≥ 50 W change, ≥ 30 s between writes,
  asymmetric hysteresis (2026-09-15): step DOWN promptly (a preset above
  current PV is served from the CELLS — the jojo this kills), step UP only
  after the higher target holds 3 min continuously (cloud wobble around a
  100 W boundary otherwise makes the preset chase PV while the device lags
  ~1 min behind; verified by simulation: a 644↔590 W wobble = zero writes).
  Always written as TWO half-day slots (Anker single-slot 0 W export bug);
  `mode_type: 3`, week [0..6], other fields preserved from the last read.
- Enable saves the device's current schedule verbatim
  (`.power-plan-state.json` next to the DB, mode 600, gitignored);
  **disable restores it byte-for-byte** (verified: back to 200 W flat).
  Enabled state survives restarts.
- Routes: `GET/POST /api/power-plan[/enable|/disable]`, plus
  `POST /api/power-plan/strategy` (2026-09-16, see below); UI:
  `web/src/live/PowerPlanCard.jsx` on the Live tab (status, target/preset,
  decision inputs, disable-and-restore button).

## Strategy engine + battery temperature + real charge limits (2026-09-16)

- **Two strategies** (`server/power-plan.js`, `computeTarget()` dispatches
  on `trigger` first, then `strategy`) — simplified TWICE the same day: a
  short-lived 3-strategy/2-trigger design (house/battery/grid-zero-
  besteffort × pv_zero/grid_zero) was replaced by this final 2×2 model after
  the user asked to reduce complexity:
  - `house_priority` (default): `dischargeToTarget()` — the battery
    continuously tops up the house down to `dischargeFloorPct +
    DISCHARGE_TOLERANCE_PCT`, REGARDLESS of PV level, targeting `demandW -
    GRID_TARGET_W` (not the full demand). This absorbed what was briefly a
    separate 3rd strategy ("grid ≈ 100 W best-effort") the same day it was
    decided House priority should just BE that behavior.
  - `battery_priority`: while `soc < chargeCeilingPct && pv > 0`, target=0 —
    PV is deliberately withheld from the house so it charges the battery
    instead, house demand comes from the grid meanwhile (confirmed
    intentional, not a bug). Otherwise `passthroughOnly()` — PV (if any)
    passes straight through to the house, but the battery is **never**
    discharged under this strategy (confirmed: "will not discharge at
    all" — no fallback to `dischargeToTarget()` like the short-lived
    intermediate design had).
- **Discharge trigger — `auto` | `manual`**: `auto` lets the strategy above
  decide (`dischargeToTarget()` for `house_priority`,
  `passthroughOnly()`-after-charging for `battery_priority`). `manual` is a
  **persisted** `manualDischarge` boolean toggle that OVERRIDES the selected
  strategy entirely ("will overwrite whatever the strategy was selected
  before") — `true` → `dischargeToTarget()`, `false` → `passthroughOnly()`,
  regardless of `strategy`. This replaced an even-shorter-lived time-limited
  "discharge now for 15 min" override design the same day — manual is a
  deliberate standing choice now, not a one-off action, so there's no
  `forceDischargeUntil`/expiry logic.
- **`GRID_TARGET_W` / `DISCHARGE_TOLERANCE_PCT` (env vars, default 100 W /
  4 points)**: deployment-time constants, like `TARIFF_EUR_PER_KWH`
  elsewhere in this codebase — explicitly NOT exposed in the Strategy tab UI
  (the user asked to keep the UI to just the two dropdowns + the manual
  toggle). The original ask was "keep grid supply **under** 100 W", not
  literally 0 — targeting exactly 0 was a drift during design that got
  caught and corrected the same day.
- **Persistence**: `.power-plan-state.json` gains `strategy`
  (`"house_priority"` default), `trigger` (`"auto"` default),
  `manualDischarge` (`false` default). Backward-compat remap on load
  (`PowerPlanController` constructor) handles TWO generations of older
  files: pre-strategy-engine files (no `trigger` at all) and the short-lived
  3-strategy/2-trigger files (`strategy: "grid_zero_besteffort"` →
  `"house_priority"`, which now IS that behavior; `trigger: "pv_zero"` or
  `"grid_zero"` → `"auto"`, the closest equivalent since `"manual"` didn't
  exist yet) — both log `"[power-plan] upgraded: ..."` once at startup if
  the controller is already enabled, so the shift is visible, not silent.
- **`POST /api/power-plan/strategy`**: partial update, body
  `{strategy?, trigger?, manualDischarge?}`, validated against the known
  enum values, calls `PowerPlanController.setStrategy()`. Response is the
  same shape as `GET /api/power-plan`'s `getState()` (now including
  `strategy`/`trigger`/`manualDischarge`/`gridTargetW`/
  `dischargeTolerancePct`, the last two read-only/informational) — matches
  the existing enable/disable convention (POST response *is* the new
  state). No new GET route: `web/src/strategy/StrategyTab.jsx` (7th tab,
  `App.jsx`, positioned before Graph) shares the same `GET /api/power-plan`
  poll loop `PowerPlanCard.jsx` already uses. **Battery tab merged in
  (2026-09-16)**: `BatteryTab.jsx` is no longer its own top-level page —
  `StrategyTab.jsx` renders it directly (own poll loop, unchanged); the SOC
  gauge stays visible, the two detail param-cards are now behind a
  `.details-toggle` "Battery information" section, collapsed by default
  (same pattern as `PowerPlanCard.jsx`'s "Power Plan" section). Two
  button-groups (strategy, trigger) plus a third discharge/don't-discharge
  toggle shown only when `trigger === "manual"`, each with a short
  description of current behavior underneath. The write-discipline
  hysteresis (step-down-promptly / step-up-after-3min-hold / min-write-gap)
  is unchanged and applies uniformly — it only ever sees the final numeric
  target, so a strategy switch is naturally subject to the same rules as
  any other target change. The Strategy tab does NOT add an enable/disable
  control — that stays exclusively on `PowerPlanCard.jsx` (Live tab),
  matching the existing "disable button removed from the UI on purpose"
  decision.
- **Real charge/discharge limits — `get_power_cutoff` (2026-09-16)**:
  `param_type "18"`/`"27"` (`get_site_device_param`) are confirmed
  genuinely empty on this account/device (A17C3, bare Solarbank 2, no power
  dock) — NOT a parsing bug (that was already fixed the same day: `readParam()`
  now handles both JSON-string `param_data`, used by schedule types
  4/6/9/12/13, and already-parsed-object `param_data`, used by setting types
  16/18/23/26/27/28/29/30). Confirmed against a matching community report
  (`thomluther/anker-solix-api#304`): "site_device_parm query with station
  parameter does not work for [SB2] yet" — bare SB2 systems must use
  `POST power_service/v1/app/compatible/get_power_cutoff` with
  `{site_id, device_sn}` instead (`device_sn` from `getLiveBattery()?.sn`).
  `battery-params.js`'s `fetchConfig()` now tries this FIRST, then 18/27 as
  unchanged fallbacks for other hardware generations (`applyLimits()`
  reused as-is, same field names). Read-only — writing would additionally
  need `set_power_cutoff` paired with an MQTT `0067`/`sb_soc_limits`
  command per the community findings, out of scope for now.
  **Bug fixed alongside this**: `config.limitsSource` used to be assigned
  unconditionally after the 18/27 attempts, silently overwriting a
  `"power_cutoff"` label the moment 18/27 returned anything — every
  assignment is now `??=` so the first successful source wins, matching how
  the numeric fields already behaved. Values: `"power_cutoff" | "account" |
  "schedule" | "default"`, now shown as a badge in `BatteryTab.jsx`
  (`.badge.ok` for real account data, `.badge.warn` for guessed values) —
  it was computed before but never displayed.
- **Battery temperature — MQTT only, no REST equivalent**: `server/mqtt.js`'s
  `FIELDS_0405` map gains `aa` → `temperatureC` (signed, no scaling factor,
  whole-degree °C) — confirmed via the community `_A17C1_0405` field map
  (same message type this project already decodes for soc/pv/charge/
  discharge). `decodeValue()`'s 1-byte paths (`0x01`/no-tag) return the raw
  byte UNSIGNED, so a two's-complement correction (`raw > 127 ? raw - 256 :
  raw`) is applied by hand for `signed: true` fields, without touching
  `decodeValue()` itself (would change other fields' semantics). **Not yet
  verified against the live device's actual wire type** for this field —
  capture one with `MQTT_DEBUG=1` before trusting sub-zero readings.
  Threaded through: `battery_snapshots.temperature_c` (new guarded
  `ALTER TABLE` column, alongside `pv1_w`/`pv2_w`), `saveBatterySnapshot`/
  `getLatestBattery()`, `/api/battery/params`'s `live.temperatureC`, a new
  `ParamRow` in `BatteryTab.jsx`'s Status card. **`syncBattery()`'s REST
  sync does a full replace of `latestBattery`** and REST has no temperature
  field — changed to carry the last MQTT-sourced value forward
  (`temperatureC: latestBattery?.temperatureC ?? null`) instead of blanking
  it every 10 s; this is the first MQTT-only-enriched field in the app (MQTT
  and REST previously always described the same field set).
- **Live/Strategy tab charge-discharge inconsistency, fixed (2026-09-16)**:
  `outputW` (raw device field) is the TOTAL inverter AC output — PV
  pass-through + cell discharge combined (per the validated flow model
  below) — NOT battery discharge power alone. `/api/flow` already derived
  the correct `cells = max(0, outputW - pvToHome)` for the Live tab's flow
  diagram, but `/api/battery/params` exposed raw `outputW` directly and
  `BatteryTab.jsx`'s gauge compared `chargeW` vs `outputW` — misreading
  pure PV pass-through (chargeW=0, outputW>0) as "discharging", and
  showing the wrong wattage even when actually discharging (the full
  inverter output, not just the cells' share) — disagreeing with the Live
  tab, which correctly showed idle/the smaller cells figure. Fix: extracted
  `deriveBatteryFlow({pvW, chargeW, outputW})` into `battery-params.js`
  (returns `{pvToBattery, pvToHome, cellsW, gridChargeW}`), used by BOTH
  `/api/flow` (index.js, replacing its inline duplicate) and
  `/api/battery/params` (new `live.cellsW` field) — one shared derivation,
  so the two routes can't drift apart again. `BatteryTab.jsx`'s mode is a
  **dominant-direction** comparison, `chargeW > cellsW ? "charging" :
  cellsW > chargeW ? "discharging" : "idle"` (refined same day — a plain
  `chargeW > 0` check let a small charging blip override a real, larger
  discharge; `chargeW`/`cellsW` can both transiently read a small nonzero
  value from sensor timing noise, matching `FlowDiagram`'s own
  "dominant direction only" rule for the battery↔home arc), and the
  discharging wattage label shows `cellsW`, not `outputW`.
- **Step-up hold never actually fired once `house_priority` became
  continuous, fixed (2026-09-16)**: `tick()`'s step-up branch reset the
  3-minute hold timer (`this.pendingUp`) whenever `targetW`'s EXACT value
  changed (`this.pendingUp?.target !== targetW`) — but `targetW` is
  `demandW`-derived (`dischargeToTarget()`), and real house demand
  fluctuates essentially every 10 s tick, so the timer reset almost every
  tick and could never reach `STEP_UP_HOLD_MS`. Confirmed live: a user
  configured `house_priority`, and `lastWrittenPower` stayed at `0` for
  15+ minutes while `lastDecision.reason` kept reporting `"holding up-step
  (Ns/180s)"` with `N` never exceeding ~40 — the preset silently never
  stepped up AT ALL. This was latent since 2026-09-15 (the original
  `min(max, demand)` night branch had the exact same issue) but only
  became visible once a continuous, always-on discharge strategy depended
  on it working. Fix: the hold now tracks "how long has `targetW` stayed
  ABOVE `cur` continuously" (`if (!this.pendingUp) this.pendingUp = {
  since: now }`), not "how long has it been this exact value" — matching
  the hold's actual documented intent (survive a target wobbling ACROSS
  the `cur` boundary, not one merely changing magnitude while staying
  above it). Verified via a standalone simulation: fluctuating targets
  (320/328/315/370/300/340 W) now correctly accumulate held-time across
  ticks instead of resetting to 0 every time.
- **CRITICAL: stale `lastWrittenPower` after a container restart caused the
  controller to stop writing entirely while the device kept discharging,
  fixed (2026-09-16)**: `lastWrittenPower` is persisted state — the
  controller's *belief* about what preset the device currently holds — but
  it was never reconciled against the device's actual schedule on startup.
  Live incident: production was switched to `battery_priority`, the app
  believed `cur === target === 0` (no write needed), but the real device
  schedule still held a stale higher preset from before the restart and
  kept discharging ~645 W into the house the whole time — invisible to the
  controller because it never re-read truth from the device, only trusted
  its own memory. Emergency mitigation: `POST /api/power-plan/disable`
  (unconditionally restores the original pre-takeover schedule) — verified
  discharge dropped from 645 W to 58 W. Root-cause fix: new
  `reconcileWrittenPower(parsed)` method reads the actual preset off a
  freshly-fetched schedule (`parsed.custom_rate_plan[0].ranges[0].power`)
  and overwrites `this.lastWrittenPower` (+ persists) whenever it disagrees
  with what the app remembered — called from `tick()`'s cold-start
  `readSchedule()` block and from `enable()`'s `readSchedule()`, i.e. every
  point where the app (re-)establishes its view of the device's schedule.
- **Step-up hold lowered from 3 min to 90 s (2026-09-16)**: `STEP_UP_HOLD_MS`
  changed from `3 * 60 * 1000` to `90 * 1000` per explicit user choice
  (weighed against keeping 3 min or going shorter still) — still long
  enough to ride out a single cloudy-minute PV dip without chasing every
  wobble, but roughly halves how long the house draws grid import while a
  legitimate, sustained PV/demand increase is held back.
- **Step-up hold countdown UI (2026-09-16)**: `tick()`'s step-up branch now
  also computes `holdProgress: {heldMs, totalMs}` (null once the hold isn't
  active or the delta is below `WRITE_MIN_DELTA_W`) alongside the existing
  `reason` string, added to `lastDecision` so the frontend doesn't have to
  parse `"holding up-step (Ns/90s)"` text. `StrategyTab.jsx` renders it as
  a `.hold-progress` bar (`width` = `heldMs/totalMs`, recomputed against a
  locally-ticking `nowMs` state so the bar fills smoothly every second
  between the 10 s `/api/power-plan` polls, not just once per poll) plus a
  "Ns" countdown label — shown only while a genuine step-up is pending.
- **Mobile audit: "charging 71 W" wrapping mid-phrase, fixed (2026-09-16)**:
  `.batt-status`'s charging/discharging text was a bare, un-wrapped text
  node inside a flex row that also carries the right-aligned
  `.batt-status-sub` ("usable window ≈ N kWh"). On phone widths, once both
  pieces competed for space, the flex-assigned box for the anonymous text
  item could be narrower than its content, and — because no `white-space`
  was set — the browser wrapped the text at the space inside "71 W",
  splitting the number from its unit onto two lines. Audited every tab at
  375/390px width with a headless Playwright pass (local build, API calls
  proxied to the live production backend for real data) looking for both
  true horizontal overflow and mid-phrase wraps; this was the only genuine
  defect found (the ROI BOM's `.roi-bom-name` ellipsis-truncation is
  intentional, not a bug). Fix: wrapped the status phrase in
  `<span className="batt-status-main">` with `white-space: nowrap`, gave
  `.batt-status-sub` the same, and set `.batt-status { flex-wrap: wrap }`
  so if the two truly can't fit together, the sub-label drops to its own
  line instead of breaking the primary phrase — plus a `max-width: 600px`
  font-size step-down on both for extra headroom. Verified with a forced
  4-digit wattage ("discharging 1245 W") to confirm no code path can still
  split the number from its unit.
- **"Today's Production" looked wrong, root cause: a real ~5h telemetry
  gap silently zeroed instead of being flagged (2026-09-16)**: user reported
  today's PV production figure looked too small. Queried
  `battery_snapshots` directly and found a genuine 5h10min gap in local
  telemetry, 09:05–14:15 — right through peak sun — after which collection
  resumed normally (~4,000 rows/day at 30 s cadence otherwise). Root cause
  wasn't bad arithmetic: `dischargedKwh`/`chargedKwh`/`pvKwh`/`pvToHomeKwh`/
  `pvToBattKwh` for "today" were each computed by a trapezoid loop that
  explicitly skips any pair of readings more than 30 min apart — correct
  in principle (never guess across an outage), but the 5h chunk simply
  contributed nothing, with no signal distinguishing "measured, genuinely
  low" from "measured, but missing a chunk." Compounding it: THREE
  independent copies of this exact loop existed (`server/index.js`'s
  overview route, `server/welcome-ai.js`'s `pvKwhForDay`, and
  `server/db.js`'s `getPvStringKwhForDay`), each free to drift; and a
  SEPARATE bug in the opposite direction — the "Today" tile's flip-side bar
  chart is built from `interp()`'s anchor interpolation, which had **no**
  gap-size check at all, so it silently straight-line-guessed across the
  very same 5h gap instead of dropping it, meaning the headline number and
  its own flip-side chart could disagree about the same outage. Fix:
  extracted the one shared `integrateBatteryEnergy(rows, {maxGapMs})`
  (`server/db.js`) — used by all three former call sites — which keeps the
  "skip gaps > 30 min" policy but now also returns `coveredMs`, letting
  callers report what fraction of the window is real; gave `interp()` and
  the grid `profile` builder in `server/index.js` the same 30-min gap guard
  so bars and headline numbers can no longer disagree about a real outage;
  and added `byPeriod.today.dataCoveragePct` to `/api/stats/overview`,
  surfaced on the Dashboard's "Today" tile as an amber `.src-gap-note`
  ("N% of today covered…") whenever coverage drops below 90% — the low
  number now reads as "incomplete data," not a silent, unexplained low
  reading. Verified `integrateBatteryEnergy` against a synthetic gap
  matching the real one's length: the gap segment contributes zero and
  `coveredMs` correctly reports only the non-gap minutes. The container was
  recreated twice during today's unrelated deploys, rotating away the logs
  from the actual 09:05–14:15 window, so the underlying cause of the
  telemetry stall itself couldn't be root-caused from here.
- **Same-day follow-up: the gap doesn't have to just be flagged — Anker's
  own cloud has it, so recover it (2026-09-16)**: user pointed out the
  Anker app shows a correct "today produced" figure for the exact same
  window our local telemetry lost — the account's cloud isn't affected by
  OUR poller being down, since the device reports to Anker independently.
  Confirmed live: `anker.getEnergyAnalysis({..., deviceType:
  "solar_production", type: "day"})` (site-level `power_service/v1/site/
  energy_analysis`) returns a 20-min PV-production trend that has real,
  substantial values (peaking ~500–700 W) throughout the exact 09:05–14:15
  gap — confirmed via `curl .../api/cloud/energy?...&device_type=
  solar_production`. `device_type=solarbank` (already used elsewhere for
  the battery's own net-power day trend) also works for battery
  charge/discharge. Tried several other device_type guesses
  (`solar`/`pv`/`photovoltaic`/`battery`/`charge`/`discharge`/etc.) — all
  rejected with "-1 Failed to request"; only `solar_production` and
  `solarbank` (and `home_usage`, `grid`, already used) are valid. **Caution
  for next time**: probing 8 device_type guesses in a tight loop tripped
  Anker's rate limit (HTTP 429, ~1 min cooldown) — space out exploratory
  cloud-endpoint calls, don't burst them.
  Fix: new `cloud_pv_history` table + `saveCloudPvTrend`/`getCloudPvDayPower`
  (`server/db.js`) — deliberately a SEPARATE table from `cloud_history`,
  not a synthetic device_sn row in it, because `getBatterySn()` picks "the
  one cloud_history device_sn that isn't the meter," which a fake PV SN
  would break. `integrateBatteryEnergy` now accepts optional
  `windowStartMs`/`windowEndMs` and returns `gaps: [{startMs, endMs}]`
  (also catching LEADING gaps — down before the window even started — and
  TRAILING gaps — still down right now — not just gaps between two known
  readings). `syncCloudHistory()` (index.js) syncs `solar_production`
  today+yesterday alongside the existing `solarbank` sync. The overview
  route now backfills `pvKwh`/`dischargedKwh`/`chargedKwh` — standalone
  totals, safe to recover — from the cloud for exactly the gap windows via
  `sumCloudEnergyInGaps`. Deliberately did NOT backfill `pvToHomeKwh`/
  `pvToBattKwh` (the PV home/battery split): the cloud only reports totals,
  not that split, so there's nothing correct to backfill it with — and
  `todayCellsKwh` (= discharge − pvToHome, the "From battery" €-savings
  row) is computed from `battEnergy.dischargedKwh` (LOCAL-ONLY, pre-backfill)
  specifically, not the backfilled `dischargedKwh` — mixing a backfilled
  discharge total with a non-backfilled PV-passthrough figure would have
  inflated that row's savings estimate for any gap window. `dataCoveragePct`
  now reflects post-backfill coverage, so the Dashboard's amber note only
  fires when even the cloud couldn't cover a gap (account/cloud also
  unreachable), not for an ordinary recovered outage. Verified the gap
  detection (leading/internal/trailing) and backfill math against a
  synthetic day matching the real gap's shape and length before shipping.
- **Multi-day battery/PV cloud catch-up (2026-09-16)**: the backfill above
  only ever fetched today+yesterday (`syncCloudHistory`'s existing
  2-day loop) — fine for a restart or a few-hours outage (recovers on the
  next 15-min sync or the next request), but a server down for SEVERAL
  consecutive days would only ever recover the most recent day; older
  missed days would silently stay uncovered forever, since nothing ever
  goes back for them (same class of gap as the main fix, just longer
  timescale). The grid meter already had a proper 30-day catch-up scanner
  (`catchUpCloudHistory`, `getStoredPeriodStarts` to find what's missing);
  added the same pattern for battery+PV (`catchUpBatteryPvHistory`,
  `getStoredPvPeriodStarts`). Runs as its OWN startup gate
  (`battPvSyncStarter`), separate from the meter's `syncStarter` — it needs
  `latestBattery.sn`/`siteId`, which populate on the battery's own
  REST/MQTT sync timeline, not the meter poller's, so gating it on the same
  condition as the grid catch-up would risk running before battery info is
  ready. Throttled identically (6 s between calls, one battery + one PV
  call per missing day) to respect the same rate limit that a burst of
  manual `device_type` probing tripped earlier this session (see the entry
  above) — up to ~62 calls (~6 min) on a first-ever run with zero stored
  history, far fewer on a normal restart since most days are already
  cached.
- **`POWER_PLAN_DISABLE` env var — hard dual-control guard (2026-09-16)**:
  dev (this Mac) and production (192.168.1.10) can both run against the
  same real meter/Anker account/battery at once; only one should ever hold
  the battery schedule (`enabled: true`). "Just don't call `/enable` on
  dev" isn't a real guarantee — a copied state file, a stray curl, a future
  script could still flip it. `POWER_PLAN_DISABLE=true` (set in this repo's
  local `.env`, NOT in production's) forces `PowerPlanController.enabled`
  to `false` at construction regardless of persisted state, and makes
  `enable()` throw outright rather than ever writing to the device — a
  structural guarantee, not a discipline one. Documented in `.env.example`.
- **CRITICAL: `POWER_PLAN_DISABLE` (and `GRID_TARGET_W`/`DISCHARGE_TOLERANCE_PCT`)
  silently never read the real .env value — ES module import hoisting, not a
  dotenv bug (2026-09-16)**: testing `POWER_PLAN_DISABLE=true` locally, the
  dev server booted with the power plan `enabled: true` anyway — caught and
  disabled within its 90 s step-up hold, before any real write happened
  (confirmed on production: `lastWriteAt` unchanged, no drift). Root cause:
  `index.js` called `dotenv.config()` as a plain statement in its own body,
  but ALL of a module's `import` declarations — regardless of where they're
  written lexically — are resolved and their target modules FULLY EVALUATED
  before that module's own body runs. `power-plan.js` (imported by
  `index.js`) reads `process.env.GRID_TARGET_W` /
  `DISCHARGE_TOLERANCE_PCT` / `POWER_PLAN_DISABLE` in `const` statements at
  its OWN top level — which therefore always evaluated BEFORE
  `dotenv.config()` had populated `process.env`, silently locking those
  three to their hardcoded defaults (100 / 4 / false) no matter what `.env`
  said. Never previously observed because `GRID_TARGET_W`/
  `DISCHARGE_TOLERANCE_PCT` had never actually been overridden away from
  their defaults in practice — `POWER_PLAN_DISABLE` was the first case
  where the wrong-fallback behavior was actually exercised. A parallel
  audit (forked agent) confirmed the same pattern in `db.js`'s `DB_PATH`
  (harmless in practice: never .env-overridden either) and found no other
  instances. Fix: moved the `dotenv.config()` call into its own module,
  `server/env.js`, and made `import "./env.js"` the FIRST import in
  `index.js` — sibling imports within one file evaluate in the order
  they're written, so `env.js` (and its `dotenv.config()` call) now
  genuinely finishes before `power-plan.js`/`db.js`/anything else in the
  import graph is evaluated. Verified locally: `POWER_PLAN_DISABLE=true`
  now correctly keeps the plan disabled on boot AND makes
  `POST /api/power-plan/enable` reject outright with a clear error.
- **Dashboard "day" tile flip-side bars: PV missing on past days, not
  hourly, week tile showing the wrong week (2026-09-16)**: three related
  Dashboard bar-chart bugs found while verifying the above. (1)
  `/api/stats/period`'s `dayGrid()` (past-day navigation) hardcoded
  `pv: 0` for every bar — never actually computed, so yesterday/older days
  never showed a PV segment even though the tile's own PV total was
  correct. Cloud data only has PV production PER-BUCKET (not the
  home/battery split), so fixed by shaping the correct daily to-home total
  (`pv_daily` rollup) proportionally across the day using
  `cloud_pv_history`'s production curve as the timing shape — same
  "total is real, split is estimated" tradeoff as the telemetry-gap
  backfill above, same reasoning for why. (2) Past-day bars were raw
  20-minute cloud buckets (~72/day) while "Today" used hourly (24) —
  inconsistent density, chart visibly got denser navigating back a single
  day. New shared `hourlyKwhFromRows()` buckets both the same way. (3)
  "Today"'s bars used to only create a slot for hours that had `profile`
  data, so the x-axis silently grew/shrank through the day instead of
  showing a stable 24-hour day with the unfilled part visibly blank — now
  always 24 slots, `null` (a real gap, not a measured zero) for any hour
  later than the current one, so the chart visibly fills in as the day
  progresses. (4) Unrelated but found alongside: `byPeriod.week` (current
  week) and `/api/stats/period?type=week` (past-week navigation) both
  computed a ROLLING 7-day window ending "today" — comment literally called
  it that — not the actual Monday–Sunday calendar week the tile's "This
  week" label implies (This month/This year are already calendar-aligned).
  New `mondayOf()` helper fixes both call sites; verified locally against
  live data (Wed 2026-09-16 → week correctly spans Mon 09-14–Sun 09-20,
  last week's label `09-07 – 09-13`).

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
- GitHub Actions: `ci.yml` only (deps, vite build, node --check, offline
  smoke test on :3100) — **no image publish step** (2026-09-17, user
  request: `publish.yml`/GHCR removed entirely from the pipeline, along
  with the previously-published packages under
  `ghcr.io/lucianhanga/h0me-p0wer`). Production builds locally from source
  instead (`docker-compose.yml`'s `build: .`, no `image:` line).
- Secrets never enter git or the image: server-local `.env` only.
- **Meter allows ONE Modbus TCP connection** — no parallel instances. For
  dev+prod coexistence: `MODBUS_TRANSIENT=true` + `POLL_INTERVAL_MS=20000`
  (connect-read-disconnect per cycle instead of a permanent connection).
- Deployment/update flow documented in README "Deploy (Docker, production)"
  — `git pull --ff-only && docker compose up -d --build`.

## FlipTile — generic flippable tile (2026-09-13)

- `web/src/components/FlipTile.jsx`: click/tap/Enter/Space flips the tile 180°
  (CSS 3D, both faces in one grid cell so height comes from the front). The
  BACK face is an empty same-size card for now — per-tile back content is a
  planned iteration.
- Wrapped around: Dashboard source cards, Live `.cards` + `.phase-card`s,
  all Welcome cards. Fronts keep their existing markup/classes.
- Interactive children must `stopPropagation()` on click or they also flip
  (done for the Welcome ↻ refresh button).
- **Drag guard**: FlipTile ignores "clicks" that moved >10px since pointer-down
  — required for swipe tab navigation (below) not to flip tiles mid-swipe.
- **Swipe left/right switches tabs** (`App.jsx`, touchstart/touchend on
  document, 60px threshold, horizontal must dominate vertical 1.5×). Gestures
  starting on `.chart-box, button, a, select, input` are IGNORED so the
  graph's drag-to-pan and buttons keep working. Verified via CDP touch events.

## ROI tab (2026-09-15)

- 5th tab "ROI" (`web/src/roi/RoiTab.jsx`, hash `#roi`): investment payback
  for the balcony-solar setup. `GET /api/roi` (`server/roi.js`,
  `registerRoiRoute`) is **DB-only** — no cloud calls.
- **BOM with snapshotted prices**: `server/roi-bom.json` (committed,
  user-editable) — `{asin, name, desc?, qty, unitPriceEur, estimated?, url,
  priceSnapshotDate}` (`desc` is shown in the PDF only). The ROI math must use the PRICES PAID, never live
  prices, so each row carries its snapshot date; `estimated: true` rows are
  guesses (Amazon blocks price scraping) the user should correct by hand.
  The UI flags them with "~".
- **Savings model (measured/actual)**: per finished day (today excluded),
  `saved = (pv_daily.to_home + cells discharge) × TARIFF_EUR_PER_KWH`.
  Cells discharge = battery cloud day-trend positive integral (20-min power
  × 20/60/1000) — per the dashboard channel audit the trend is ALREADY
  cells-only, so it never overlaps the PV channel (do NOT subtract
  pvToHome here). Display-only: `measuredAvgDailySavingsEur`, `measuredDays`,
  `savingsSoFarEur`, `series` — the ACTUAL comparison, NOT the ROI basis.
- **Baseline ("set in stone", 2026-09-15)**: ALL forward-looking numbers
  (payback, projections, forecast) come from a persisted baseline in
  `server/roi-baseline.js`, kv key `roi_baseline`. Computed ONCE on first
  `/api/roi` call (`getBaseline()` initializes when missing) and recomputed
  ONLY via `POST /api/roi/baseline/refresh` (the tab's ↻ button, confirm()
  first) — never on a schedule, never day-to-day. `computeBaseline()` asks
  the AI (same client/config as welcome: `parseWelcomeConfig` + `fetchJson`,
  json_schema → json_schema → json_object, 60 s) for a CONSERVATIVE
  `{annualPvKwh, selfConsumptionRatio, annualSavingsEur, monthlyDistribution,
  reasoning}` fed with PV config + PVGIS climatology + tariff + measured
  avg daily import + the noisy measured savings (weak signal only).
  Validation: ratio clamped 0.3–0.95, `annualPvKwh` capped at the PVGIS
  yearly figure, distribution normalized to sum exactly 1, and
  `annualSavingsEur` is ALWAYS re-derived (`annualPvKwh × ratio × tariff`)
  so the numbers can't disagree. Fallback when the AI/key/PVGIS is down:
  PVGIS yearly kWh, ratio 0.75, PVGIS monthly shape → `source:
  "pvgis-fallback"` vs `"ai"` (hardcoded Munich climatology if even
  HOME_ADDRESS is missing).
- `installDate` = earliest day with savings data (first `pv_daily` row or
  first battery day-trend), fallback 2026-09-07 (meter link date).
  **Forecast** (`forecastSeries`): cumulative €/day from installDate until
  the invested sum is crossed + ~6 months margin (hard cap 25 y); each day's
  increment = `(annualSavingsEur/365) × monthlyDistribution[month] × 12`
  (month's share vs. an average month → seasonally shaped; a full year sums
  to the annual figure up to the ≤1% day-count wobble). `paybackDate`/
  `daysToPayback` = where the FORECAST crosses invested; `projections[]`
  1/2/3/5/10/15 y = `annualSavingsEur × years`; constant tariff, no
  degradation.
- Amortization chart: measured cumulative (solid green) + a trend-adjusted
  "possible outcome" (dotted green, same color — see the rolling-forecast
  entry below) vs. invested markLine, break-even markPoint where the
  OUTLOOK crosses invested. Legend for both lines. Styles: `.roi-*` at the
  end of styles.css.
- **Rolling forecast / "possible outcome" + Performance Ratio tracking
  (2026-09-16, user request — researched industry practice first, see
  below)**: previously the chart drew TWO fully-separate lines from
  installDate — measured (solid green) and the flat baseline forecast
  (dashed BLUE) — running in parallel for the whole horizon, including the
  already-measured period (redundant overlap) and never reacting to
  whether the system was actually over- or under-performing the baseline.
  Researched best practice first (forked WebSearch agent): confirmed (1)
  PVGIS remains the right source for this scale/region (validated for
  Europe, already applies the standard 14% system-loss default — this
  codebase's existing baseline code already does this correctly); (2) the
  standard PV-monitoring metric for actual-vs-expected output is
  "Performance Ratio" (%), used as-is here as `performanceRatioPct`; (3)
  the standard dashboard convention for actual-transitioning-to-forecast is
  ONE series that changes line style (solid → dashed/dotted) at "now" —
  NOT two differently-colored series, which risks reading a forecast as
  fact; (4) trend-adjusting a forward projection by scaling the baseline's
  remaining increments by the actual/expected ratio observed so far is a
  legitimate, standard technique ("rolling forecast" in FP&A terms) — blend
  the trend into the baseline's seasonal SHAPE, don't replace the shape or
  discard the baseline; (5) explicit pitfalls to avoid: don't over-fit a
  short/noisy window (this codebase already treats short measured windows
  as "weak signal only" for the baseline itself — the new prompt below
  carries the same caution), don't imply false precision, P50/P90
  probabilistic forecasting is commercial-grade overkill at this scale
  (skipped).
  Implementation (`server/roi.js`): new `buildOutlook(installDate,
  baseline, measured, totalInvestedEur)` — walks the SAME baseline seasonal
  shape day-by-day through yesterday to get `baselineSoFarEur` (what the
  fixed baseline alone predicted for the measured period), divides
  `measured.savingsSoFarEur` by it for `performanceRatio`, then continues
  FROM THE LAST MEASURED POINT (not from 0 — this is what makes the chart
  line continuous rather than two overlapping series) using
  `dailyIncrement × performanceRatio` for the rest of the horizon, yielding
  `outlookSeries`/`outlookPaybackDate`/`daysToOutlookPayback`. The FIXED
  baseline object itself is untouched (still "must not drift," per
  roi-baseline.js) — outlook is a separate DERIVED quantity layered on top,
  recomputed fresh on every `/api/roi` call (cheap, pure arithmetic, no AI).
  A new `outlookNote` (ONE-TWO sentence AI interpretation of the tracking
  numbers, same "AI narrates given numbers, never invents them" pattern as
  `welcome-ai.js`/`roi-baseline.js`'s `reasoning`) is cached in kv store
  `roi_outlook_note`, keyed by the measured window's last date — so it's
  naturally recomputed once per day (when "yesterday" advances) rather than
  on every 5-min poll; falls back to a deterministic template sentence
  when AI is unconfigured or fails. Verified live: with only a 3-day
  measured window, the AI correctly self-caveated ("This is an early 3-day
  read... too soon to call a trend") per the prompt's explicit small-sample
  rule — matches the research's stated pitfall to avoid.
  Frontend (`RoiTab.jsx`): the chart's second series was renamed "Possible
  outcome" and changed from blue dashed to the SAME green as "Saved
  (measured)" with `lineStyle.type: "dotted"` — matching the researched
  solid→dotted convention. New "Tracking" tile shows `performanceRatioPct`
  (green ≥100%, red <100%). "Payback" tile's headline figure switched from
  the flat baseline-only date to `outlookPaybackDate`; the original
  baseline-plan date stays visible as a small sub-line, but only when it
  differs from the outlook (avoids showing the same date twice for a
  brand-new system with no measured drift yet).
- **Product images + BOM PDF (2026-09-15)**: cached pictures in
  `server/roi-images/<ASIN>.jpg` (committed, ≤400px JPEG via `sips`) served
  by `GET /api/roi/image/:asin` (immutable cache; 404 = 1×1 GIF so `<img>`
  degrades silently). Amazon robot-walls curl (even `/gp/product`, `/-/en/`,
  .com variants) — **headless Chrome `--dump-dom` passes the check**; the
  landing image is the first `"hiRes":"…m.media-amazon.com/images/I/…"` in
  the DOM. `GET /api/roi/bom.pdf` renders a printable A4 BOM with
  `server/roi-pdf.js`, a hand-rolled NO-DEPENDENCY PDF writer (PDF 1.4,
  WinAnsi Helvetica core fonts, JPEGs embedded natively as DCTDecode
  XObjects, real xref table) — do not add a pdf npm package. The BOM card is
  one compact line per item (28px thumb + ellipsized name + right-aligned
  numbers) with a "Download PDF" button in the card header.

## Home-line chart smoothing, effective discharge floor, outage copy (2026-09-17)

- **"Home Power Usage" chart momentary dip-then-bump when a strategy change
  hits — diagnosed, then smoothed**: user reported a brief anomaly right
  when switching to House Priority — the white "Home" line dipped sharply
  then bumped above baseline before settling, looking like consumption
  itself had changed. Traced with raw `/api/timeseries` data for the exact
  window: `home` is a FRONTEND-derived value, `homeOf(r) = grid +
  max(battOut, 0)` (`web/src/graph/GraphTab.jsx`) — it SUMS two
  independently-polled feeds with different cadences/latency: the local
  grid meter (~5 s, Modbus) and the battery's own reported output, which
  can lag the real physical power flow by up to ~1 min (device + Anker
  cloud relay — same lag `STEP_UP_HOLD_MS` in `power-plan.js` already
  documents and budgets for). When the preset changed and the battery
  started discharging, the grid meter registered the reduced import
  almost immediately while the battery's OWN telemetry for that same
  15–30 s bucket still read close to its pre-change value — summing an
  "already changed" number with a "not yet reported" number produced a
  real but MISLEADING low reading, not an actual consumption drop
  (confirmed: home read ~577 W → 267 W → 780 W → back to ~568 W within
  under 3 minutes, i.e. essentially unchanged start-to-end). Fix: a light
  1-2-1 weighted moving average (`smoothHome()`), applied ONLY to the
  `home` series' rendered values — NOT to raw `grid`/`gridMin`/`gridMax`
  (would blur genuinely fast grid transients, defeating the Grid-range
  envelope's whole purpose) and not to the single-source battery/PV series
  (`pvHome`/`battCells`/etc. — no cross-feed lag to smooth there, only
  `home` sums two feeds). Verified against the actual diagnosed window:
  roughly halves the dip/bump's deviation from baseline at fine (15 s)
  bucket resolution; the effect is stronger still at the coarser buckets
  (~2 min) a 24 h-view chart actually renders at.
- **Effective discharge floor (account floor + safety margin) wasn't shown
  on the battery gauge**: user noticed the battery stops discharging
  around 14%, not the 10% floor shown on the gauge, and asked where the
  extra 4% comes from. Answer: `dischargeToTarget()` (`power-plan.js`)
  pads the account's configured floor by `DISCHARGE_TOLERANCE_PCT` (env
  var, default 4) as a safety margin — that padded value was previously
  only visible in server-side comments/logic, never surfaced in the UI.
  Fix: `StrategyTab.jsx` now passes `dischargeTolerancePct` (from its
  existing `/api/power-plan` poll) down to `<BatteryTab>` as a prop;
  `BatteryTab.jsx` computes `effectiveFloorPct = minPct +
  dischargeTolerancePct` and renders it as a SECOND, amber-colored tick +
  label ("floor 14%") next to the existing purple "min 10%" tick — on its
  own label row (`.batt-tick-label-floor`, offset one line down) since the
  two ticks sit only 4 percentage points apart and would otherwise
  horizontally collide, especially on phone widths (see the earlier
  mobile-text-overflow audit this session).
- **Outage callout rewritten**: dropped the device-model name
  ("Solarbank 2 Plus"), the Power Dock accessory caveat, and the
  "check the Anker app" hedge (user: "don't mention... and ...") — now
  states only WHEN to prefer Battery priority (frequent grid outages) and
  HOW it behaves differently (keeps the battery topped up instead of
  continuously drawing it toward its floor), in `.callout-warn` on the
  Strategy tab.
- **Strategy help modal (2026-09-17, user request)**: a `?` button next to
  the "Distribution strategy" heading opens `StrategyHelp` (inline
  component in `StrategyTab.jsx`), reusing the Ask feature's modal chrome
  (`.ask-backdrop`/`.ask-panel`/`.ask-close` — generic despite the name,
  not duplicated). Covers both strategies (description + a concrete usage
  scenario each) AND the Auto/Manual discharge trigger — deliberately
  included even though only asked about strategies, since "Manual silently
  overrides whichever strategy is selected" was the EXACT thing that
  confused a user earlier this same session; the help text ends with "if
  the battery isn't behaving like your selected strategy, check here
  first" pointing straight at that failure mode.
- **Month tile bars: always emit the full month (2026-09-17, same
  reasoning as the earlier today/week/day-tile padding fix)**:
  `byPeriod.month.bars` used to `.filter((r) => r.label <= todayDs)`,
  dropping future days entirely rather than showing them as empty — so
  the month tile's flip-side chart's x-axis grew day by day through the
  month instead of showing a stable full-month axis with the unfilled
  remainder visibly blank. Now built as `Array.from({length:
  daysInCurMonth}, ...)` — every day 1..last-day-of-month gets a bar;
  days after `todayDs` get `{grid: null, batt: null, pv: null}` (a real
  gap, not a measured zero), days up to and including today use their
  real (possibly 0) values. Only the CURRENT month (`/api/stats/overview`)
  needed this — past months navigated via `/api/stats/period?type=month`
  are always already-complete, so every day in them is real by
  construction; no padding needed there. Verified via the API response
  directly (30 days for September, real values through the 17th, `null`
  from the 18th on) — the rendering itself needed no frontend change since
  `BackBars.jsx` already treats `null` as a gap, the same behavior already
  verified for the Today tile's hourly padding.

## House-demand consistency, one savings calc, Welcome strategy-awareness (2026-09-17)

- **CRITICAL: "house W" swung 600→1000→200→600 across two strategy
  switches — two different formulas for the same quantity, neither
  despiked**: user report. Traced to two separate bugs: (1) `power-plan.js`
  ALWAYS read the battery's own cloud-reported `homeLoadW`
  (`scene.home_load_power`, from `anker-cloud.js`'s `getBatteryInfo()`),
  while `/api/flow` preferred `grid (fast local meter) + battery.outputW`
  whenever the meter was available — two independently-computed formulas
  for the exact same physical quantity, occasionally disagreeing (this is
  also why the Live tab's flow diagram could show a too-low "Home" box —
  screenshot showed Home=Grid=213W with PV entirely charging, i.e. the
  `grid+outputW` path, still susceptible to the second bug below). (2)
  neither was despiked: Anker's own cloud telemetry can report a
  transient, wrong-looking value for a poll or two right after a
  preset/strategy change (the device is mid-transition — same class of lag
  as the Home Power Usage chart artifact earlier this session, but here
  feeding the power-plan CONTROLLER's target computation directly, not
  just a display). Fix: one function, `refreshHomeConsumption()`
  (`index.js`), computed once per 10s tick and used by BOTH `/api/flow`'s
  `home.consumption` and the value passed into `powerPlan.tick()` —
  prefers grid+outputW (fast local meter case), falls back to homeLoadW
  only when grid itself came FROM the battery (cloud-live, where combining
  two battery-derived numbers would double up on the same lag source), and
  despikes the result with a median-of-3 (rejects an isolated bad reading
  without lagging behind a genuine, sustained demand change the way
  averaging would).
- **One canonical savings calculation, production-based, used everywhere
  (2026-09-17, user request)**: user noticed the Dashboard's "saved €"
  (previously `pvToHomeKwh + cellsKwh` × tariff — energy that's ALREADY
  reached the house) understated real value on a day that mostly charged
  the battery for later. Since this system enforces zero export and the
  baseload always exceeds PV output, every produced kWh avoids a grid
  import SOMEWHERE — today or after a battery round-trip — so "produced"
  is the correct basis, not "already consumed." New `server/savings.js`
  exports ONE function, `savedEur(producedKwh, tariffEurPerKwh)`, imported
  by `index.js` (Dashboard's `byPeriod.*`/`/api/stats/period`),
  `roi.js` (`measuredSavings()` — per-day, using `pv_daily.produced`,
  previously `to_home + cells`), `roi-baseline.js` (wraps its own
  ratio-derived kWh — the ratio itself is a deliberate, documented
  exception for a structural reason, not a different formula), and
  `welcome.js` (overrides the AI's own `endOfDay.estimatedSavingsEur`/
  `week.estimateEur` post-call — same "AI narrates, server computes"
  pattern already used for `reasoning` fields elsewhere). Verified live:
  Dashboard's `today.savedEur` and Welcome's `endOfDay.estimatedSavingsEur`
  now produce the IDENTICAL number (0.49) for the same day — previously
  Dashboard would have shown a different, lower figure. Per-row € labels
  on the Dashboard's "PV direct"/"From battery" lines were dropped (they
  no longer sum to the new total) — those rows show kWh only now, matching
  how "To battery" already did.
- **Welcome AI now reflects the active power-plan strategy (2026-09-17,
  user request)**: previously the briefing narrated live numbers with no
  awareness of house_priority vs. battery_priority vs. a Manual override —
  it could describe the battery "topping up the house tonight" even when
  battery_priority means it never will. `buildContext()` now includes a
  `strategy` object with a pre-resolved `effectiveBehavior` string (NOT
  left for the model to work out — Manual silently overriding the selected
  strategy is exactly the logic already duplicated once for
  StrategyHelp's modal; a third independent reimplementation inside a
  prompt would be a third place to get it wrong). Verified live: with the
  power plan disabled, the AI correctly wrote "The power plan is off, so
  any later supply to the house depends on the device's own static
  schedule rather than the app's strategy" in `endOfDay.note`, and applied
  the same awareness to `week.upcoming` unprompted for that specific field
  — the general instruction ("ground statusQuo/endOfDay/week in
  effectiveBehavior") was enough.
- **"Right now" refreshes on its own lazy 30-min cadence (2026-09-17, user
  request, refined mid-request from "add a 30-min background timer" to
  "reuse the same on-demand pattern the rest of the app already uses")**:
  the main briefing only refreshes every 2h (fixed slots) — too slow for a
  card meant to read as "this exact moment," but running the WHOLE
  pipeline (geocode/weather/PVGIS/full schema) more often would be
  wasteful for fields that don't need it. New dedicated, SMALL AI call
  (`callStatusQuoAI`/`STATUS_QUO_SCHEMA`, `welcome-ai.js`) — just live
  battery + strategy numbers in, one sentence out — triggered lazily by
  `GET /api/welcome` finding `today.statusQuoUpdatedAt` more than 30 min
  old (`refreshStatusQuoIfStale`, `welcome.js`), same "never block the
  client, refresh in the background" philosophy as the main refresh, just
  a shorter TTL and a much smaller payload. Only fires when the MAIN
  payload is otherwise fresh (a full refresh already updates statusQuo, so
  triggering both at once would be two concurrent AI calls for the same
  field). `today.statusQuoUpdatedAt` is a real, separate timestamp from
  the tab's overall `generatedAt` — shown on the "Right now" card itself
  ("refreshed HH:MM").
- **Battery gauge: near-full gets its own color (2026-09-17, user
  request)**: `lvlClass` gains a 4th tier, `lvl-full` (blue gradient) for
  soc > 90%, distinct from "just healthy" (`lvl-high`, green, > 50%) — a
  topped-up battery now reads at a glance instead of looking the same as
  "healthy but not full."

## battery_priority charge/hold hysteresis (2026-09-17)

- **User observation: a small, continuous few-watt jojo at the top of
  charge — SOC bouncing 94%↔95% — while `battery_priority` was active in
  production**. Confirmed live against `/api/power-plan`: strategy
  `battery_priority`, `soc: 95`, `chargeCeilingPct: 95`,
  `atChargeCeiling: true`, correctly in passthrough (`targetW: 160` ≈ the
  live `pvW: 166`, rounded down to `step`). The few watts themselves are
  the Solarbank unit's OWN standby/BMS/wifi housekeeping draw — continuous,
  not something this app writes a preset for or can prevent, and normal for
  this hardware class; **that part is intended**. What was NOT intended:
  `computeBatteryPriority()` used a bare `soc < chargeCeilingPct` threshold
  with no hysteresis, so the instant that standby draw nudged SOC down by
  the 1 point the device reports in, the controller snapped straight back
  into `target=0` — withholding ALL PV from the house and pulling 100% of
  demand from the grid — purely to claw back that 1 point, then flipped
  straight back to passthrough the moment SOC touched the ceiling again.
  At a typical few-hundred-watt house load this toggled the "does the
  house get any PV right now" answer every few minutes, for a fluctuation
  that isn't otherwise meaningful. Fix: `computeBatteryPriority()` now
  latches into a hold state (`this.holdingAtCeiling`) the moment
  `soc >= chargeCeilingPct`, and only leaves it (resumes charging) once SOC
  has dropped `CHARGE_RESUME_HYSTERESIS_PCT` (env var, default 3) points
  below the ceiling — deployment-time constant, same category as
  `GRID_TARGET_W`/`DISCHARGE_TOLERANCE_PCT`, not user-adjustable in the UI.
  `holdingAtCeiling` is also surfaced in `lastDecision` for visibility,
  alongside the existing (now slightly narrower-scoped) `atChargeCeiling`
  informational field. Verified with a standalone simulation feeding the
  real production SOC sequence (95, 94, 95, 94, 93, 92, …) through
  `computeBatteryPriority()` directly: target now holds steady at the
  passthrough value (160 W) through the entire 95→93 wobble and only drops
  to 0 (resumes charging) at SOC 92, exactly 3 points below the ceiling as
  designed — the visible on/off toggling is gone. `house_priority` is
  unaffected — it has no charge/hold switch at all; PV surplus beyond its
  served target charges the battery automatically at the device level,
  with no binary threshold in this controller's own logic to add
  hysteresis to.

## battery_priority: hold phase must USE the full battery, not just pass through PV (2026-09-17, same-day correction)

- **User caught this deployed within hours of the hysteresis fix above**:
  "the calculation how much to put in house when the battery is full...
  should put as much as you can but leave still 100w from the grid. I
  observed that the power is limited to a very small amount from the PVs."
  Confirmed live against production: `soc: 95` (at the ceiling,
  `holdingAtCeiling: true`), `pvW: 321`, `demandW: 774`, but
  `targetW: 320` — the hold phase was still calling `passthroughOnly()`,
  which caps the served amount at raw current PV, leaving 454 W (774-320)
  to come from the grid instead of the intended ~`GRID_TARGET_W` (100 W).
  A full battery sitting idle while the house pulls most of its demand
  from grid defeats the entire point of having charged it — this
  contradicts the ORIGINAL design intent (serve as much as possible, only
  ~100 W held back for grid) even though it matched what had been
  separately confirmed earlier in the strategy's design ("the battery is
  NEVER asked to discharge under this strategy") — that earlier
  confirmation is now understood to describe the CHARGING phase only, not
  the hold phase once full.
- Fix: `computeBatteryPriority()`'s hold branch now calls
  `dischargeToTarget()` (the same house_priority formula — serve
  `demandW - GRID_TARGET_W` from PV+battery together) instead of
  `passthroughOnly()`. So battery_priority now reads as: charge hard
  (target=0, PV entirely withheld) until the ceiling, then behave exactly
  like house_priority until SOC has drained `CHARGE_RESUME_HYSTERESIS_PCT`
  points below the ceiling, then charge hard again — that constant now
  doubles as "how far a full battery is allowed to discharge before
  recharging resumes," not just a tiny standby-draw buffer. Verified:
  simulating the exact production reading
  (`soc:95, pvW:321, demandW:774`) through the fixed
  `computeBatteryPriority()` now returns `670` (674 = demand-100, rounded
  down to the 10 W step) instead of the old `320`; re-ran the original
  94↔95 hysteresis sequence too — the resume-charging latch still fires
  correctly at SOC 92, unaffected by this change.

## battery_priority: PV-only at ceiling, don't touch the battery (2026-09-17, second same-day correction)

- **The `dischargeToTarget()` fix directly above was itself wrong** — caught
  within the same conversation, before it had even been deployed to
  production long enough to matter. User's exact words: "the battery is
  full and it stopped loading it — now I want to dump all the produced
  power into the house — also don't touch the battery anymore, it should
  only [use] the power from the PVs — also it should observe that it takes
  about 100w from the grid." `dischargeToTarget()` draws from the battery
  to fill `demandW - GRID_TARGET_W` whenever PV alone falls short — that IS
  "touching the battery," directly contradicting the requirement. The
  correct formula sits between the two prior attempts: use as much PV as
  is useful (never artificially below it — requirement "dump all the
  produced power"), but never above it either (never draws from the
  battery — requirement "don't touch the battery"), capped at
  `demandW - GRID_TARGET_W` so the grid still keeps its ~100 W margin even
  when PV alone could nearly cover full demand (requirement "observe ~100w
  from grid") — same rationale as `GRID_TARGET_W` everywhere else in this
  file (avoid a literal 0 W grid crossing). New method
  `pvOnlyToGridTarget()`: `target = min(pvW, demandW - GRID_TARGET_W, max)`.
  `passthroughOnly()` is now used ONLY by the manual "don't discharge"
  toggle (uncapped by `GRID_TARGET_W` — that toggle's semantics weren't
  part of this change and weren't asked to change).
- Verified against four scenarios before touching the code (plain JS
  simulation of the formula, not yet wired into the class): the exact
  production reading (`pv:321, demand:774`) → `320` (matches what the user
  originally saw and confirms wanting — the SAME number `dischargeToTarget`
  had "corrected" away from, now correctly reverted), PV nearly covering
  demand (`pv:700`) → `670` (grid gets ~104 W), PV exceeding demand
  entirely (`pv:900`) → `670` (same cap; the un-routed 230 W of PV can only
  trickle into the already-full battery or get curtailed by the device —
  flagged to the user as an expected, bounded side effect, not exported,
  not something this preset can prevent outright), low PV (`pv:50`) → `50`
  (grid covers the rest, no cap in effect). Then re-verified all of this
  plus the untouched 94↔95 ceiling-hysteresis latch through the actual
  class methods — all consistent. `house_priority` remains completely
  unaffected by either correction on this day — it has no charge/hold
  switch and always uses `dischargeToTarget()` unconditionally.

## battery_priority: hold-phase hill-climb, gated on real cellsW (2026-09-17, fourth same-day revision)

- **The `pvOnlyToGridTarget()` fix directly above was ALSO wrong** — live
  timeseries (`GET /api/timeseries?range=1h` against production) showed PV
  had been ~799 W (near the 800 W panel cap) minutes earlier, then crashed
  to ~2 W and stayed there for 4+ consecutive minutes once the hold phase
  started capping target at that reading. Root cause: on this hardware,
  reported PV is NOT an independent measurement — the device only draws as
  much PV as it currently needs for output+charging, so it's a
  CONSEQUENCE of the last target this app wrote. Capping target at
  "current PV" creates a self-reinforcing lock: a transient dip writes a
  low target, the device throttles the panels to match it, the next
  reading confirms "PV is low," and there is no way out without ever
  asking the device for more than it currently reports.
- **User's requirement, restated twice, emphatically, with no exception
  accepted**: "the battery has to stay untouched" AND "do anything in
  your power to produce as much as possible... just get about 100w only
  from grid." These are in genuine tension on THIS hardware: discovering
  how much PV is actually available beyond the current reading requires
  asking for more output, and the device may cover any shortfall from
  cells before the next reading reveals it wasn't safe. There is no
  device-level "PV-only, up to X" preset — `custom_rate_plan` is a single
  flat power number; the device decides internally how to source it.
  Explored (and rejected) writing the literal device `max_load` directly,
  reasoning "if it's more than the house needs, the device's own Anker-app
  settings limit it anyway" — kept this app's own `demandW`-based cap
  regardless: the file's zero-export-by-construction invariant is meant as
  a first line of defense that doesn't depend on the device's real-time
  `0w_feed` protection being fast enough on its own (same reasoning
  `STEP_UP_HOLD_MS` documents elsewhere in this file — the device lags by
  about a minute).
- **Fix: a closed-loop hill-climb, gated on `deriveBatteryFlow()`'s real
  `cellsW`** (`battery-params.js` — the one existing, validated signal for
  "is the battery ACTUALLY discharging right now," already shared between
  `/api/flow` and `/api/battery/params` so it can't drift). New
  `PROBE_STEP_W` (default 50 W, matching `WRITE_MIN_DELTA_W` — a smaller
  step would never actually get written) and per-instance `holdProbeW`
  state. Every tick while holding at the ceiling: if `cellsW > 0` (the
  currently-active preset really did pull from cells), drop
  `holdProbeW -= cellsW` — the EXACT amount observed, landing back at the
  true safe level in one correction, not a fixed decrement (a fixed 50 W
  retreat would take ~14 write-cycles / ~7 minutes to unwind a
  670 W→near-0 crash, given `MIN_WRITE_GAP_MS`=30s between writes — far
  too slow for a hard requirement). If `cellsW == 0` (confirmed safe),
  cautiously climb `holdProbeW += PROBE_STEP_W`, capped at
  `demandW - GRID_TARGET_W`. `holdProbeW` resets to 0 every time the
  controller re-enters the hold phase (never assumes yesterday's validated
  level still holds). `cellsW` itself is computed once per tick in
  `tick()` from the live `pvW`/`chargeW`/`outputW` already available on
  `latestBattery`, using the SAME `deriveBatteryFlow()` those other two
  routes use — not reimplemented a third time. Threaded through
  `computeTarget()`'s existing `{...ctx}` spread into
  `computeBatteryPriority()`, and surfaced as `holdProbeW`/`cellsW` in
  `lastDecision` for visibility.
- **Honest limitation, stated explicitly rather than glossed over**: this
  cannot GUARANTEE literal zero battery involvement, ever — only that any
  touch is detected and corrected within one tick (write-discipline steps
  DOWN with no hold delay), never sustained. Recovery from a deep dip back
  up to the full safe ceiling is deliberately slow (tens of minutes in the
  worst case — climbing costs one `PROBE_STEP_W` per validated
  `STEP_UP_HOLD_MS`-held-and-confirmed cycle) — the acknowledged cost of
  the "never touch the battery" guarantee actually holding rather than
  being aspirational.
- Verified via a synthetic closed-loop simulation (not live — no way to
  safely reproduce a hard PV crash against real hardware on demand):
  modeled "the device honors target from PV first, cells cover any
  shortfall" and ran the controller through three phases — ramping 0→670 W
  in exact 50 W steps while PV was abundant (799 W, matching the incident
  before the crash); PV crashing to 2 W, where the very next tick corrects
  target from 670 straight to 0 (one-step correction, not a multi-minute
  trickle); PV recovering to 700 W, where the climb resumes cleanly from
  wherever it left off. Also re-ran the untouched 94↔95 ceiling-hysteresis
  latch sequence through the same updated code — unaffected.

## battery_priority: hill-climb probe was un-paced and self-defeating (2026-09-17, fifth same-day revision, found within the hour)

- **User caught this live, minutes after the fourth revision above
  shipped**: "when we are increasing the PV production looks like that
  also the House consume is displayed as rising. but no extra consumers
  are in the house. this values are actually coming correctly from the
  Smart Meter Gen2 also, however I don't understand why." Three
  screenshots showed PV/output and displayed "Home" rising in lockstep
  (50→550→770 W and 667→905→1084 W over ~4 minutes) while grid dropped by
  LESS than output rose — meaning `Home = grid + outputW` was
  systematically overshooting during the ramp, not just noisy.
- **Diagnosed at user's request via web research** (`thomluther/anker-solix-api`,
  the reference Solarbank reverse-engineering project, and Anker's own
  support docs — see GitHub issue #114 and `ha-anker-solix`'s INFO.md):
  Solarbank 2 only reports fresh telemetry to Anker's cloud every **~5
  MINUTES by default** — worse than the ~1 minute this file had assumed
  everywhere else (`STEP_UP_HOLD_MS`'s original rationale). The project
  maintainer explicitly warns against changing presets faster than every
  2 minutes for exactly this reason: readings in between are frequently
  stale, not a live measurement.
- **This exposed a real, separate bug in the just-shipped hill-climb**,
  not just a display quirk: `computeBatteryPriority()`'s `holdProbeW` was
  advancing on EVERY 10 s tick as long as `cellsW == 0`, completely
  decoupled from whether a write had even reached the device yet. With
  writes gated behind `STEP_UP_HOLD_MS` (90 s), the internal candidate
  could silently climb ~9 steps before the FIRST one was ever tested
  against reality — and even once written, the very next tick's `cellsW`
  reading was almost certainly still stale cloud data from before that
  write could possibly have been reported. "Confirmed safe" was
  frequently not a real confirmation at all — undermining the "never
  touch the battery" guarantee this whole design exists to provide, not
  just producing a cosmetic display artifact. (The fast local grid meter
  reacting to the REAL, already-changed output while the cloud's reported
  `outputW` lagged behind is what produced the visible "Home rising"
  symptom specifically.)
- **Fix, two parts**: (1) `holdProbeW` is now computed relative to
  `lastWrittenPower` (ground truth — what's verifiably active on the
  device right now) for retreats, and held STEADY (not reset every tick)
  between probes, so write-discipline's own hold can actually observe a
  continuously-elevated target and commit it — a first attempt at this
  fix reset `holdProbeW` back to `lastWrittenPower` on every non-probing
  tick, which prevented ANY write from ever completing (caught via a
  full 35-minute closed-loop simulation with realistic write-discipline
  timing, not just calling the function in a loop — see below). (2) new
  `PROBE_MIN_INTERVAL_MS` (default 5 min, env-configurable) gates upward
  steps only — set at Anker's documented worst-case reporting interval,
  so each step has genuinely had time to be reported before the next is
  attempted. Downward correction remains immediate and ungated, unchanged
  from the previous revision.
- **Revised, more honest recovery-time estimate**: verified via a
  realistic closed-loop simulation (synthetic "device honors target from
  PV first" hardware model, PLUS the actual write-discipline state
  machine replicated tick-by-tick, not just `computeBatteryPriority()` in
  isolation — an earlier, simpler simulation missed the "never actually
  writes" bug entirely because it didn't model write-discipline at all).
  With abundant PV, writes now commit roughly every 5-6.5 minutes (one
  `PROBE_STEP_W`=50 W step each), reaching 350 W after 35 simulated
  minutes — recovering to a typical ~670 W ceiling from a full dip would
  take over an HOUR in the worst case, notably slower than the "tens of
  minutes" estimated for the previous (buggy) revision. This is the
  honest cost of `PROBE_MIN_INTERVAL_MS` actually respecting Anker's real
  reporting cadence. A hard PV crash (799 W → 2 W) was still corrected
  within one 10 s tick (`cellsW` detected, target dropped to 0
  immediately, written on the very next write-discipline pass) — the
  safety-critical direction is unaffected by the slower climb.
- Also declined, in this same conversation, to reduce `STEP_UP_HOLD_MS`
  from 90 s to 30 s as separately requested — explained that 30 s sits
  BELOW the (now confirmed even longer than assumed) device/cloud lag,
  which would reintroduce the exact preset-chasing problem that value
  exists to prevent, now doubly so given this incident.

## battery_priority: probe re-tuned for speed, live-verified against production (2026-09-17, sixth same-day revision)

- **Confirmed live, same day, that the fifth revision above is correctly
  deployed and working**: polled production's `/api/power-plan` via a
  background Monitor loop and watched one full probe cycle complete in
  real time — held at `holdProbeW=50` while `PROBE_MIN_INTERVAL_MS`
  (then 5 min) elapsed, then `reason: "holding up-step (Ns/90s)"`
  counting 10→30→40→60→80s, then `"step up (held 90s)"` with
  `lastWrittenPower` actually updating to 100. The `v1.2.4` badge visible
  in the user's browser was a stale cached frontend — the backend was
  already newer. This is the first time this whole day's sequence of
  fixes was verified against REAL production behavior over time, rather
  than via simulation alone.
- **User: "still only putting 100W... ramp up is going very slow" — asked
  to speed it up.** The 5-minute `PROBE_MIN_INTERVAL_MS` chosen in the
  fifth revision was this file's OWN extra-conservative choice — the
  actual research finding was two numbers: Anker's ~5 min DEFAULT
  reporting interval, and the maintainer's separate, explicit
  RECOMMENDATION to not change presets faster than every 2 minutes. 5 min
  was chosen out of caution beyond what was strictly required. Re-read
  the research and lowered `PROBE_MIN_INTERVAL_MS` to exactly 2 minutes
  (the documented floor) — explicitly NOT lower, since going below the
  maintainer's own stated safe minimum is what caused today's earlier
  bug. Declined an ambiguous user request to move two unspecified numbers
  from "60/90" to "30/60" (didn't map onto any real constant combination)
  and asked for clarification via AskUserQuestion rather than guess on a
  safety-relevant parameter.
- Combined with raising `PROBE_STEP_W` 50 W → 150 W (offered 100 W and
  150 W as options via AskUserQuestion given the step-size/speed
  trade-off; user picked 100 W then immediately said "I want it faster,"
  so went straight to 150 W without another round-trip). Bigger steps
  don't increase WORST-CASE EXPOSURE TIME (a real discharge still
  corrects within one ~10-20 s tick, since the correction subtracts the
  exact observed `cellsW`, not a fixed amount) — only worst-case
  MAGNITUDE of a single brief touch, which was disclosed explicitly
  before implementing.
- Verified via the same realistic closed-loop simulation (real
  write-discipline timing, not just calling the function in a loop): full
  ramp from 0 to a 670 W ceiling now takes **~9.5 minutes** (5 steps ×
  ~2 min interval, `STEP_UP_HOLD_MS`'s 90 s comfortably fits inside each
  2-min window) — down from over an hour with the previous (50 W /
  5 min) settings. Re-verified the hard-crash correction is unaffected:
  799 W → 2 W still corrects to target=0 within one 10-20 s tick,
  regardless of step size, because the retreat calculation is always
  exact (`lastWrittenPower - cellsW`), never a fixed decrement.

## Third strategy: `anker_app` — hand control back to the Anker app (2026-09-17, user request)

- **User request**: "add to the strategy also manual where you let the user
  to set up what he want in anker app." A genuinely different escape hatch
  from the existing enabled/disabled toggle on the Live tab: disabling the
  whole power plan restores `originalRaw`, a ONE-TIME snapshot captured
  whenever the controller first took over — it goes stale the moment the
  user edits anything in the Anker app afterward, and drops all of this
  app's own monitoring/decision display along with it. `anker_app` instead
  simply never reads or writes the schedule at all, for as long as it's
  selected, while everything else (live PV/demand/SOC numbers, the
  Strategy tab itself) stays active — so whatever the user configures
  directly in the Anker app (including e.g. Anker's own AI mode) just
  stays in effect, indefinitely, not just until the next tick.
- Named `anker_app`, not `manual` — `trigger` already uses `"manual"` for
  the discharge-toggle override, and reusing the word for a THIRD,
  unrelated concept (a strategy that skips the whole write pipeline) would
  have been confusing on the wire and in the UI.
- **`tick()`** short-circuits immediately after computing live
  `pvW`/`demandW`/`soc`/`cellsW` when `strategy === "anker_app"` — never
  calls `readSchedule()`/`writeSchedule()`, never runs the write-discipline
  state machine at all. `lastDecision` still gets the live numbers (for
  the Strategy tab to display) but no `targetW`/`wrote`/`holdProgress` —
  just `reason: "anker_app — not writing, device follows its own
  Anker-app schedule"`.
- **`setStrategy()`** now invalidates the cached `this.template` whenever
  a strategy CHANGE crosses INTO or OUT OF `anker_app` (either direction)
  — forces the next active-strategy tick to re-read the schedule and run
  `reconcileWrittenPower()` against whatever the device ACTUALLY has,
  rather than trusting a `lastWrittenPower` belief that predates
  potential user edits made via the Anker app while this app wasn't
  writing. Verified directly: constructed a controller, entered
  `anker_app` with a pre-cached template and confirmed zero write calls
  across a tick; switched to `battery_priority` and confirmed the
  template was nulled and the following tick correctly reconciled
  `lastWrittenPower` from a mocked device read (0), not a stale prior
  value.
- **`server/index.js`**: `anker_app` added to the `/api/power-plan/strategy`
  validation enum alongside `house_priority`/`battery_priority`.
- **`web/src/strategy/StrategyTab.jsx`**: third button in the strategy
  picker; when selected, the "Battery discharge trigger" section and the
  grid-outage callout are hidden entirely (neither applies — there's no
  write pipeline for a trigger to affect, and the outage callout compares
  House vs. Battery priority specifically). The decision cards swap to a
  single "Live numbers (not being written)" card showing PV/house/SOC and
  the reason string, instead of the Target-output/Decision-inputs pair
  used by the two active strategies (which reference `targetW`/`wrote`,
  meaningless here). `StrategyHelp` modal extended with a third
  paragraph explaining the distinction from the Live tab's disable
  toggle, plus a note that the discharge-trigger section doesn't apply
  in this mode. Verified visually via Playwright against the dev server
  (`POWER_PLAN_DISABLE=true`, confirmed `enabled:false`) — button group,
  description, help modal all render correctly; the live-numbers card
  itself couldn't be exercised in this specific screenshot since a
  disabled controller never ticks (`lastDecision` stays `null`
  regardless of strategy) — confirmed via a direct `node` simulation
  instead, matching the pattern used for the server-side verification.

## Dashboard source-card: dropped the redundant per-row Grid €-spent (2026-09-17, user request)

- User: "remove from the tiles the spent under the grid because its anyway
  listed in the lower part of the tile." The Grid row in `SourceCard`
  showed an inline `€X spent` (from `SRC_ROWS`'s `eur: "gridEur"` field),
  while the card's bottom summary line (`spent €{gridEur} · saved
  €{savedEur}`) already showed the exact same figure — the row's `eur`
  key was the ONLY thing driving that inline text (PV direct/From battery
  never had one; only the "To battery" row's `stored` label used the same
  conditional slot). Dropped `eur: "gridEur"` from the Grid row and
  simplified the conditional to just `r.stored && <span
  className="src-eur">stored</span>`. Verified visually via Playwright
  against the dev server across all four period tiles (Today/This
  Week/This Month/This Year) — Grid rows now show only the kWh value, the
  bottom summary line is unaffected, "To battery"'s "stored" label
  (Today's tile only) still renders correctly.
- **Immediate follow-up regression, same day**: removing Grid's second
  line left "To battery" as the ONLY row with a secondary label, and
  `.src-value`'s existing `flex-direction: column` (deliberately built so
  kWh/€ stack on two lines — fine when Grid ALSO had two lines) now made
  that one row's "stored" text wrap onto its own line below the kWh
  value, looking inconsistent next to every other now-single-line row.
  Changed `.src-value` to `flex-direction: row` (kWh and "stored" inline,
  same line) — verified visually, "To battery" now matches the single-line
  height of every other row.

## Welcome AI: production.todayKwh was a fabricated projection labeled "measured" (2026-09-18, user request: "review all the AI prompts, make sure they're accurate")

- **User: "this tile is stating that it was produced already 3.7kwh which
  is false!"** Traced against production's real `/api/welcome` payload:
  the briefing was generated at 06:01, an hour before sunrise (06:54).
  `production.reasoning` literally read *"No PV energy has been recorded
  yet today, but the live system has started producing. The estimates
  use the 1 kWp setup, September's 95.4 kWh climatology and the forecast
  radiation of 3.7 today…"* — the model correctly knew the real figure
  was ~0, said so in its own reasoning, and THEN substituted a full-day
  PVGIS projection into `production.todayKwh` anyway, apparently judging
  "0 kWh" unhelpful to report at 6 AM. The frontend (`gt.pvLiveToday ?
  "measured" : "estimated"`) then labeled this fabricated number
  "measured" — a real, user-visible lie, not just an imprecise estimate.
  This directly violated the system prompt's own instruction ("report
  actuals... pvProducedTodayKwh") — a plain instruction wasn't strong
  enough to stop the model from "helpfully" overriding a real zero.
- **Same root cause explains a second, related oddity**: the "How today
  will end" card showed "≈€0 saved today" right next to a note describing
  the battery about to discharge ~3.7 kWh to the house over the rest of
  the day. `endOfDay.estimatedSavingsEur`'s server override (added
  2026-09-17) used `context.pvProducedTodayKwh` — the real MEASURED
  so-far figure, correctly ~0 at 06:01 — but `endOfDay` is semantically a
  FULL-DAY projection card; it needs a projected TOTAL, not a
  before-sunrise snapshot of what's happened yet.
- **Fix, two layers (same "AI narrates, server guarantees the number"
  pattern already used for savings elsewhere in this file), not prompt
  wording alone — a plain instruction had already failed once**:
  1. New `projectedTodayKwh()` helper (`welcome-ai.js`) — the same
     PVGIS-monthly-climatology-scaled-by-forecast-radiation formula
     `buildFallback()` already used inline, now extracted and shared, and
     exposed as `context.pvProjectedTodayKwh` (a genuine full-day
     PROJECTION, distinct from `pvProducedTodayKwh`, the measured
     so-far figure).
  2. `server/welcome.js`'s `refresh()`: `production.todayKwh` is now
     HARD-OVERRIDDEN to `context.pvProducedTodayKwh` whenever
     `context.battery.pvLiveToday` — regardless of what the AI (or the
     offline fallback) proposed; only the accompanying `reasoning` prose
     is left to the model. `endOfDay.estimatedSavingsEur`'s basis changed
     from `pvProducedTodayKwh` to `pvProjectedTodayKwh ??
     pvProducedTodayKwh` — a full-day estimate, not a so-far snapshot.
  3. `SYSTEM_PROMPT` strengthened regardless (defense in depth, not
     instead of the override): explicit "MUST equal pvProducedTodayKwh
     EXACTLY, even if 0 ... NEVER substitute a climatology projection ...
     a real 0 is correct and more honest than an estimate mislabeled as
     measured", plus a new bullet telling the model to base `endOfDay` on
     `pvProjectedTodayKwh`, not `pvProducedTodayKwh` alone.
  4. `buildFallback()` (the fully-offline, AI-down path) refactored to
     call the same shared `projectedTodayKwh()` instead of duplicating
     the formula — one fewer place for the two to drift apart.
- Verified via a standalone reproduction of the exact real incident
  numbers (not a live AI call — the override is pure arithmetic, no need
  to spend real API credits verifying it): simulated the AI having stated
  `todayKwh: 3.7` exactly as observed, ran it through the new override
  logic with `pvProducedTodayKwh: 0, pvProjectedTodayKwh: 3.7` — result:
  `production.todayKwh` corrected to `0` (matching reality, no longer
  mislabeled "measured"), `endOfDay.estimatedSavingsEur` corrected to
  `€1.14` (a meaningful full-day-projected figure) instead of the
  previous, misleading `€0`.
- **Investigated separately, same conversation: "Yesterday" tile "looks
  very poor"** — screenshotted the live tile via Playwright against
  production and checked its numbers by hand (grid 12.99 + battery 1.4 +
  PV 2.36 = 16.75 ✓ matches "used"; spent €3.99 = 12.99 × tariff ✓; saved
  €1.23 = produced 4.01 × tariff ✓, the correct production-based
  formula). Found no visual defect (no wrapping, consistent with sibling
  cards) and no data inconsistency — flagged back to the user rather than
  guessing at an invisible problem; this one is UNRESOLVED, pending
  clarification on what specifically looked wrong.

## Battery charge/discharge ETA, everywhere the battery is shown (2026-09-18, user request)

- User: "all over the place where you have the battery displayed and also
  that is charging or discharging also estimate in how much time will be
  full respectively empty at the current rate. take in account the
  observed limits for charge and discharged (at discharged including the
  extra amount)." Found exactly two live charge/discharge status
  readouts in the app (grepped every `.jsx` for "charging"/"discharging"
  — `GraphTab.jsx`'s hit is just historical chart-series legend labels,
  not a live status, no change needed there): the Live tab's Battery
  FlipTile (`LiveTab.jsx`) and the Battery/Strategy tab's status card
  (`BatteryTab.jsx`, embedded inside `StrategyTab.jsx` — fixing it once
  covers both tabs).
- "Full"/"empty" are NOT 0%/100% — per the request, they're the account's
  configured charge ceiling and the controller's EFFECTIVE discharge
  floor (account floor + `DISCHARGE_TOLERANCE_PCT` safety margin, i.e.
  "the extra amount" — the exact same effective-floor concept
  `BatteryTab.jsx` already visualizes as a second gauge tick, from the
  2026-09-17 "why does it stop at 14%, not 10%" session).
- New shared `web/src/batteryEta.js` (`batteryEtaHours()` +
  `formatEta()`) — used identically by both components so they can never
  compute this differently. `batteryEtaHours()`: charging →
  `(maxPct - soc)/100 * capacityKwh / (chargeW/1000)` hours; discharging
  → `(soc - floorPct)/100 * capacityKwh / (cellsW/1000)` hours; both
  clamped to ≥ 0 (handles the edge case where SOC has already crossed the
  threshold, e.g. mid-transition). `formatEta()`: `< 1 min` / `N min` /
  `Nh` / `NhMm`.
- **`LiveTab.jsx` needed data it didn't have** (`capacityKwh` — a
  hardware constant, `maxPct`/`floorPct` — account config resolved via
  `getBatteryLimits()`, a 6 h-cached call, not something to newly poll on
  every 5 s tick). Rather than add a second fetch cycle to the Live tab,
  extended `/api/flow`'s existing `battery` object (server/index.js) with
  these three fields — the SAME `getBatteryLimits()` the power-plan
  controller and Battery tab already use (never re-derived), plus
  `dischargeTolerancePct` read directly off the live `powerPlan` instance
  (not re-imported as a separate constant). `/api/flow`'s handler is now
  `async`/`await`s this — normally resolves from the 6 h cache instantly,
  so no meaningful latency added to a 5 s-polled endpoint. `CONSTANTS`
  exported from `battery-params.js` (was module-private) so `index.js`
  can reuse `CONSTANTS.capacityKwh` instead of hardcoding `1.6` a second
  time.
- **`BatteryTab.jsx`**: already had every input locally (`constants`,
  `config`, `dischargeTolerancePct` prop, `effectiveFloorPct`) — just
  wired `batteryEtaHours()`/`formatEta()` in, displayed as
  `full in ≈ …`/`empty in ≈ …` right after the existing "charging
  320 W"/"discharging 320 W" text. New CSS class `.batt-status-eta`
  DELIBERATELY separate from the existing `.batt-status-sub` (which has
  `margin-left: auto` for the "usable window" label, already at the far
  right of the same flex row) — reusing that class for the ETA too would
  have put two auto-margined items fighting for the same space instead
  of reading left-to-right as two distinct pieces of info.
- Verified end-to-end against the dev server's real (if momentarily
  right-at-the-floor) battery data — `soc:13%, floor:14%` produced
  `empty in ≈ < 1 min` (correctly clamped, not a negative/broken value)
  on both the Live tab's Battery tile and the Strategy tab's status card,
  at both desktop (900px) and phone (375px) widths, no wrapping. Charging
  and a comfortably-above-floor discharging case verified separately via
  pure-function checks (`soc:60→95%` at 400 W → `1h 24m`; `soc:80→14%` at
  300 W → `3h 31m`) since the live device happened to be right at its
  floor at verification time.

## Welcome AI: endOfDay's savings figure was disconnected from its own card (2026-09-18, second same-week fix)

- User: "How today will end" showed "house ≈ 2.9 kWh" and "≈ €0.17 saved
  today" side by side — "it cannot be only this if you estimate a
  production of 2.9kwh". Root cause: `estimatedSavingsEur` (server
  override, from the 2026-09-17 fix) was based on `pvProjectedTodayKwh` —
  a full-day PRODUCTION projection with NO guaranteed relationship to
  `toHouseKwh` (the AI's own, separately-estimated CONSUMPTION-side
  figure shown right next to it on the same card). The two numbers came
  from disconnected calculations and could disagree by 5x, as observed
  (2.9 kWh × tariff ≈ €0.89, not €0.17).
- **Deliberately NOT "just use production-based accounting here too"**:
  Dashboard/ROI/Yesterday/This-week-so-far are real, HISTORICAL
  MEASUREMENTS where production-based accounting matters — it's what
  keeps today/yesterday/week/month from double-counting or drifting
  against each other (see `savings.js`'s original rationale). `endOfDay`
  is a single, forward-looking GUESS with no sibling historical card it
  needs to reconcile against — once today actually ends, the REAL
  production-based figure shows up elsewhere (Dashboard's Today tile,
  eventually Yesterday). For a card whose only job is to read as
  internally coherent right now, matching the number beside it
  (`toHouseKwh`) matters more than importing a philosophy built for a
  different problem (cross-card historical reconciliation).
- Fix: `estimatedSavingsEur = savedEur(ai.endOfDay?.toHouseKwh,
  config.tariff)` — hard override, same pattern as before, just a
  different (now internally-consistent) basis. Verified against the
  exact reported numbers: `toHouseKwh: 2.9` → `€0.89`, not `€0.17`.
- **Also enriched context per the user's explicit request** ("get the
  information on weekly average, last friday, month daily average, the
  current calendaristic month... and what was produced until now") so
  the AI's OWN `toHouseKwh`/`toBatteryKwh`/`gridExportKwh`/
  `batterySocEstimate` estimates are better grounded, not just internally
  consistent with a number derived after the fact: new
  `consumption.lastSameWeekday` (the most recent PAST occurrence of
  today's weekday — a concrete real data point, e.g. "last Friday pulled
  15.9 kWh" — distinct from the existing `avgImportKwhByWeekday`'s 56-day
  rolling average; verified in isolation that it picks the MOST RECENT
  match and excludes today itself, not just any past same-weekday row)
  and `consumption.monthToDateImportKwh` (a running TOTAL, distinct from
  the existing `monthToDateAvgImportKwh` average). `pvProducedTodayKwh`
  ("produced until now") and `pvProjectedTodayKwh` (today's full-day
  projection) already existed — `SYSTEM_PROMPT`'s endOfDay bullet
  rewritten to explicitly name all of these and rank `lastSameWeekday`
  ahead of the broader averages for estimating what's left of today's
  demand specifically.

## Welcome AI: week/month production now Dashboard's own numbers, via internal loopback (2026-09-18, third same-week fix)

- User: "in the right now tab, you mention week ≈ 11.1 kWh · month ≈
  95.4 kWh, which is not correct... check the values from dashboard...
  make sure you compute them in one place and use them all over from
  that single source of truth." `production.weekKwh`/`monthKwh` were
  ALWAYS an independent AI/PVGIS climatology projection (per the
  2026-09-18 first fix's own prompt text: "ALWAYS forward-looking...
  live or not") — a second, disconnected computation from Dashboard's
  real `byPeriod.week/month.pvProducedKwh`, guaranteed to diverge once
  actual weather deviated from the climatology average (95.4 kWh is
  September's WHOLE-MONTH PVGIS figure; Dashboard's real month-to-date
  total was a completely different number by the 18th).
- **Single source of truth, literally, not just "compute it the same
  way twice"**: rather than re-implement `/api/stats/overview`'s
  production summation a second time in `welcome-ai.js` (that route's
  computation spans ~460 lines with real-vs-cloud merging, bucket
  interpolation, and outage-gap handling accumulated over many prior
  fixes in this file — reimplementing it risks silently drifting from
  Dashboard's actual behavior the next time either one changes),
  `welcome.js`'s `refresh()` now makes an INTERNAL LOOPBACK HTTP call to
  the server's own `/api/stats/overview` (`deps.statsOverviewUrl =
  http://127.0.0.1:${PORT}/api/stats/overview`, set once in
  `index.js`), alongside the existing weather/PVGIS fetches, and threads
  the result into `buildContext()` as `pvProducedWeekToDateKwh`/
  `pvProducedMonthToDateKwh`. Best-effort (`.catch(() => null)`) — a
  transient failure falls back to the AI's own estimate rather than
  blocking the whole briefing.
- `production.weekKwh`/`monthKwh` hard-overridden to these real values
  whenever the PV system is live — same backstop pattern as `todayKwh`
  from the first fix this week, extended to all three fields together.
- **Caught and fixed a related latent bug while here**: `week.estimateEur`
  (the SEPARATE "How this week should end" card, a genuinely
  forward-looking "through Sunday" projection) was based on
  `ai.production?.weekKwh` — already a mismatch even before today
  (`production.weekKwh` and `week.estimateKwh` answer different
  questions and were never guaranteed to agree), and definitely wrong
  now that `production.weekKwh` means "so far" (a much smaller number).
  Changed its basis to `ai.week?.estimateKwh` — the field the AI
  actually already produces for this specific forward projection.
- `SYSTEM_PROMPT` rewritten to explicitly distinguish the two
  ("production.weekKwh (so far, when live) and week.estimateKwh (what's
  left, always forward) answer different questions"). Frontend label
  updated ("week so far ≈ …" / "month so far ≈ …" when live) since the
  field's MEANING changed from a whole-period forecast to a real to-date
  total. Also fixed `buildFallback()`'s `production.reasoning` text,
  caught as a side effect of this investigation — it still said
  "Prorated from PVGIS…" even on the AI-unavailable fallback path where
  `todayKwh`/`weekKwh`/`monthKwh` get overridden to real measured values
  regardless (a small, pre-existing staleness from the FIRST fix this
  week, unnoticed since it only shows when the AI is down).
- Verified end-to-end against the actual dev server runtime (not just
  pure-arithmetic checks, since this is a genuinely new mechanism — an
  internal HTTP call, not just a formula): temporarily ran the dev
  server with `AI_API_KEY` unset (forces the fallback path, so no AI
  spend) and confirmed `POST /api/welcome/refresh`'s
  `production.weekKwh`/`monthKwh` came back EXACTLY matching
  `GET /api/stats/overview`'s real numbers fetched moments earlier
  (15.24 / 15.24) — screenshotted the "Right now" card showing "week so
  far ≈ 15.24 kWh · month so far ≈ 15.24 kWh"; re-ran after the
  `reasoning` text fix below and confirmed the numbers still tracked
  Dashboard exactly (16.64 / 16.64, real production having continued
  accumulating between checks) alongside the corrected text.

## Welcome tab redesign: hero, "How the day started" window, "planned" removed for good (2026-09-19)

- **Root cause finally found for the whole week of Welcome AI bugs**:
  `battery.pvLiveToday` (`pvMaxToday > 0` — "has TODAY produced anything
  yet") was being used as a proxy for "is the PV system installed." The
  PV system has been permanently installed since 2026-09-13, but that
  check evaluates false every single morning before the first ray of
  sun — confirmed live against production: a 06:01 generation (an hour
  before 06:55 sunrise) had the AI write *"the PV system is not yet
  live... these are forward estimates"* and substitute a PVGIS
  projection for `production.todayKwh` — the EXACT bug the first fix
  this week (2026-09-18) tried to close, just recurring through a
  different door (that fix's override was itself gated on this same
  false-negative flag). User: "the system was built! make sure that in
  all your prompts remove the fact that the system in is planning."
- **Fix: removed the day-relative flag entirely, not patched again.**
  `pvMaxToday`/`pvLiveToday` deleted from `buildContext()`.
  `production.todayKwh`/`weekKwh`/`monthKwh` are now UNCONDITIONALLY
  overridden to the real measured values in `welcome.js` (previously
  gated on the now-deleted flag) — the system is always installed, so
  there's no longer a legitimate "not live" branch for these three
  fields to fall into. Swept "PLANNED"/"not yet live" language out of
  `SYSTEM_PROMPT`, `ASK_SYSTEM_PROMPT` (which also still had a STALE,
  WRONG power-flow description — "PV covers the house first, surplus to
  the battery" — contradicting the corrected Solarbank model established
  much earlier this session; fixed alongside), `buildFallback()`'s
  `production.reasoning` and `endOfDay.note`. `groundTruth.pvLiveToday`
  and its frontend conditionals (`WelcomeTab.jsx`) removed — "so far" /
  "measured" is now unconditional, since it's always true.
- **"How the day started" was showing the wrong window** — user: "write
  how much power was consumed from the grid and from the battery until
  sunrise." The existing `gridImportKwhSoFar` field was bounded to
  NOW, not sunrise, despite the card's own name — it kept growing all
  day, and there was no battery figure at all. New shared trapezoid
  helpers in `welcome-ai.js` (`integrateGridImportKwh`,
  `integrateBatteryCellsKwh` — the latter reuses `deriveBatteryFlow`,
  the same canonical PV/cells split `/api/flow` and
  `/api/battery/params` use, not a third reimplementation) power both
  the existing "so far" (until now) and the new "until sunrise" figures
  from one formula each. `startOfDay.gridImportKwhUntilSunrise` /
  `battDischargeKwhUntilSunrise` replace the old single field.
- **Weather tile**: added today's radiation (`groundTruth.radiationSumKwhM2Today`,
  a single existing number surfaced directly — not left to the AI's
  prose, since accuracy here doesn't depend on model compliance).
- **Month tile enriched**: new `SYSTEM_PROMPT` bullet — `month.statement`
  must place the system's own PVGIS figure in the context of the
  region's seasonal solar radiation trend and the upcoming week's actual
  forecast, not just restate the raw climatology number. Verified live:
  *"September's typical 95.4 kWh sits below August's 121.4 kWh but above
  October's 70.1 kWh as Munich's solar season declines. The coming days
  are mixed—Wednesday is strongest at 4.7 kWh/m²..."*
- **Hero redesigned**: user: "should not be a tile, just text and have
  the two buttons: the refresh... [and] the read loud button which will
  read a summary of the whole welcome tab." Dropped the `card` class
  (kept `wx-hero` for spacing only) — the existing `.wx-refresh` button
  style already worked correctly as a plain inline button once removed
  from a `.card`'s corner-anchored `position: absolute` context, so no
  new CSS was needed beyond removing the class. New `SpeakButton`
  (`id="wholeTab"`) replaces the old greeting-only one, reading a
  concatenation of every card's own text (greeting, weather + radiation,
  start-of-day, right-now, end-of-day, yesterday, this-week-so-far,
  upcoming, week-estimate, month) in one pass. `YesterdayCard`/
  `ThisWeekSoFarCard` refactored from self-fetching to receiving data as
  props — their fetches lifted to the parent — so the whole-tab summary
  can include them; each card's own individual behavior/rendering is
  otherwise unchanged.
- Verified end-to-end: fallback path first (AI_API_KEY unset, no spend)
  confirmed the deterministic wiring — `radiationSumKwhM2Today`,
  `startOfDay`'s new fields, unconditional `production` override, no
  `pvLiveToday` in the response. Screenshotted the redesigned hero
  (plain text, two buttons, no tile box) and the enriched weather tile.
  Clicked the new whole-tab speak button via Playwright — no console
  errors. Then ONE real AI-powered refresh (the only paid call across
  this whole fix) to confirm the enriched prompts produce genuinely
  correct output — see the month.statement example above; also confirmed
  `production.todayKwh: 0.04` (tiny, real, shortly after sunrise) with
  reasoning correctly explaining the low number as "the early hour and
  foggy start, not an inactive system" — exactly the target behavior,
  never once describing the system as planned or not yet live.

## Welcome tab UX polish: formatting + subtle entrance/hover (2026-09-19)

- User: "enhance a bit the UX of the tiles. add a bit of formating and
  animations, but keep it spartan! like is now." Explicitly conservative
  by request — reused the existing subtle animation language already on
  this tab (icon-breathe, sun-marker-pulse, live-dot-pulse: all slow,
  quiet, `prefers-reduced-motion`-aware) rather than introducing a new
  visual style.
- **Formatting**: new `fmt1`/`fmtEur`/`fmtPct` helpers in
  `WelcomeTab.jsx`, applied to EVERY numeric display in the tab — server
  numbers already round consistently (`round1`/`r2`), but AI-returned
  numbers (`toHouseKwh`, `estimateKwh`, etc.) are only schema-typed as
  `number`, no fixed precision, so raw values could show "2" next to
  "2.34" on the same tab. `fmtPct` is deliberately SEPARATE from `fmt1`
  (not just kWh formatting reused for percentages) — a first pass
  applied `fmt1` everywhere including `batterySocEstimate`, producing
  "battery ≈ 100.0%", which reads oddly against how SOC is shown
  everywhere else in the app (BatteryTab, StrategyTab: whole numbers,
  no decimal) — caught via screenshot review, not assumed correct.
- **Entrance animation**: new `wx-tile-in` keyframe (fade + 6px rise,
  0.35s ease-out) applied to the hero, weather tile, and each `.wx-grid`
  card, staggered ~0.04s apart via `:nth-child`. Cards mount once per
  session — React updates their content on each 5-min poll without
  recreating the DOM nodes, so this plays once on arrival, not as a
  flicker on every refresh (verified this reasoning by checking the
  component structure, not assumed).
- **Hover**: small `translateY(-2px)` + brighter border on `.wx-grid
  .card`, 0.15s — a tactile hint the corner speak button is there, not a
  scale/shadow effect.
- Added the new `wx-tile-in` animation and `.wx-hero`/`.wx-today` to the
  existing `@media (prefers-reduced-motion: reduce)` exclusion block
  (already covered the icon/pulse animations) rather than starting a
  second one.
- Verified visually via Playwright: full-page screenshot after the
  entrance settles (confirming the percentage fix), and a tight
  element-level screenshot of a hovered tile confirming the border/lift
  render without breaking layout.

## Welcome tab: grid/PV/battery numbers colored to match Dashboard/Graph (2026-09-19)

- User: "all the numbers related to the power generated/used from
  grid/stored write them in the same colors you use for dashboard and
  graph." Reused the EXACT existing palette, not new colors: `#f7a44f`
  (grid — Dashboard's `SRC_ROWS`/`FlowDiagram`), `#5fce80` (PV/production
  — same source), `#c084fc` (battery discharge — Dashboard's "From
  battery" row, `BatteryTab.jsx`'s discharging state, `GraphTab.jsx`'s
  legend). New `.wx-c-grid`/`.wx-c-pv`/`.wx-c-batt` CSS classes, applied
  to the number+unit span only (not the surrounding label word), across
  every tile: "How the day started" (grid/battery until sunrise),
  "Right now" (today/week/month produced), "How today will end" (export
  — grid-colored, since it's grid-bound), Yesterday, This week so far,
  "How this week should end" (estimateKwh — a production figure).
- **Deliberately did NOT color everything that touches energy**: battery
  CHARGE ("to battery") has no override — Dashboard's own `BATT_IN_ROW`
  already renders "To battery" in the same grey as regular muted text
  (`#8b98a5`, `.muted`'s own color), so adding a distinct color there
  would be introducing a DIFFERENT convention from Dashboard, not
  matching it. "house ≈ X kWh" and battery SOC% also left uncolored —
  "house" is a mix of all three sources (no single color is correct) and
  SOC is a STATE, not one of the three flows the user was asking about.
  €-figures (spent/saved) left uncolored too — the request was about
  power/energy numbers specifically.
- Verified visually via Playwright — confirmed all three colors render
  correctly across every tile in one full-page screenshot, matching the
  intended Dashboard/Graph palette exactly.
- **Immediate follow-up, same conversation**: user asked for money too
  ("also use the same color codes for money"). Dashboard's own `.src-money`
  line (spent/saved) turned out to be flat grey, no color — so there was
  no DIRECT precedent to copy for €-figures specifically. Extended the
  same LOGIC instead: "spent €X" is grid cost → `.wx-c-grid` (orange,
  matching the Live tab's `.card-value.import` convention — grid
  import literally costs money); "saved €X" is the app's production-based
  savings figure (`savedEur()`, `server/savings.js`) → `.wx-c-pv` (green,
  since savings are computed FROM production throughout this codebase,
  not from battery discharge). Applied everywhere €spent/€saved appears:
  Yesterday, This week so far, "How today will end", "How this week
  should end". Verified visually — all four spent/saved pairs render
  orange/green consistently.

## battery_priority: discharge tolerance lowered 4→3 points (2026-09-19)

- User: "change the floor from 14% to 13% (I mean the defined SOC + 3%)."
  `DISCHARGE_TOLERANCE_PCT` (`power-plan.js`) default changed from 4 to
  3 — the effective floor `dischargeToTarget()` won't discharge below
  (account `dischargeFloorPct` + this margin) is now 13% on a 10%
  account floor, was 14%. Affects `house_priority` (always) and
  `battery_priority`'s hold-phase (once full, behaves like
  `house_priority` — see the 2026-09-17 entries). No frontend change
  needed: `BatteryTab.jsx`'s `effectiveFloorPct`/gauge marker/tooltip
  are all computed dynamically from the server's `dischargeTolerancePct`
  (`/api/power-plan`), never hardcoded — updated two comments that
  cited "14%" as a worked example to keep them accurate, but the
  actual rendering was already correct by construction. Verified via
  `dischargeToTarget()` directly: `soc:13` → `target:0` (at the new
  floor), `soc:14` → `target:530` (above it) — the exact boundary
  shifted down by 1 point as intended.

## Anker API audit against `docs/ANKER_SOLIX_API_v3.23.0.md` (2026-09-19, user request)

- User added a reverse-engineered Anker SOLIX Cloud API reference (extracted
  from the app's `libapp.so`, app version 3.23.0) and asked to check every
  API call this codebase makes against it, with "special attention" on the
  battery-limit reads. Grepped every Anker endpoint path in `server/*.js`
  and cross-checked each one against the doc. **Conclusion: no code changes
  — every endpoint in active use is either explicitly confirmed current by
  the doc, or empirically proven working and intentionally left alone.**
  - `power_service/v1/site/{get_site_device_param,set_site_device_param,
    get_site_list,get_scen_info,list_user_devices,energy_analysis}` and
    `power_service/v1/app/get_relate_and_bind_devices` — all listed
    *(community-verified)* in the doc, byte-for-byte matching what
    `anker-cloud.js`/`power-plan.js` already call.
  - `power_service/v2/device/energy_analysis` (`anker-cloud.js`
    `getDeviceEnergyAnalysis`, used for the Smart Meter's device-level
    history) matches the doc's §5 v2 surface exactly (marked *(inferred)*
    there, but the name/shape already works against this account).
  - **Battery limits** (`battery-params.js`'s `CUTOFF_EP =
    "power_service/v1/app/compatible/get_power_cutoff"`): the doc doesn't
    give this one its own row, but its §4.5 bucket description for
    `power_service/v1/app/compatible/*` explicitly names "power cutoff" —
    confirming this is a real, documented endpoint family, not a
    community guess. `fetchConfig()`'s priority order (get_power_cutoff
    first, then param_type 18, then 27, then the schedule-6 fallback) is
    unchanged and still correct — the doc doesn't describe a more direct
    path for this hardware than what's already implemented (see the
    2026-09-16 entry's `thomluther/anker-solix-api#304` citation for why
    18/27 are genuinely empty on this bare-SB2 account).
  - **Auth** (`anker-cloud.js`): the doc's community-verified §2.1 login
    describes an MD5-hashed password and an `appName` header; the actual
    code does an ECDH-P256 + AES-256-CBC crypto handshake
    (`createLoginCrypto`) and sends `"app-name"` (hyphenated). Left
    unchanged — this is a newer, more secure login variant that has been
    logging in and refreshing tokens correctly all session; the doc's
    extraction reflects string literals found in the binary, not a
    verified wire capture, and switching a working auth flow on doc text
    alone is exactly the risk the doc's own intro warns against.
  - **MQTT** (`mqtt.js`): provisions via
    `app/devicemanage/get_user_mqtt_info`, which does not appear anywhere
    in this doc at all — the doc's §19 only documents a separate
    `akiot.mqtt.*` provisioning family, most likely for the HES/X1/Power
    Dock product line the doc's own text calls out, not Solarbank 2's
    real-time push. Left unchanged: it's the channel this whole session's
    battery-flow work has depended on and verified live; the doc explicitly
    requires a fresh mitmproxy capture before trusting an unverified
    endpoint swap, and `akiot.mqtt.*` is marked *(inferred)* with no
    payload shapes given.

## Dashboard: ‹ › period nav stays visible on the flipped (bar-chart) side (2026-09-19, user request)

- User: "in the Dashboard tab the navigation buttons should be shown also
  when the tiles are flipped." Previously `SourceCard`'s `‹ title ›` row
  lived inside `FlipTile`'s front face alongside the stats — flipping the
  card to the bar-chart back (`BackBars`) hid the nav row entirely, so
  browsing past periods required flipping back to the front first.
  Restructured so the card chrome (background/border/radius/padding, was
  on `.tile`/inside the flip front) moved to a new outer `.src-card`
  wrapper; the `‹ title ›` row now renders once, outside `FlipTile`,
  always visible; `FlipTile` wraps only the flippable body (`.src-card-body`
  stats vs. `BackBars`). Dropped the nav buttons' `stopPropagation()` —
  no longer needed since they're outside the click-to-flip area.
  `.flip-back`'s own background/border is suppressed under `.src-card`
  (the outer wrapper already draws it) to avoid a doubled border; `.cards`
  (Live tab's unrelated FlipTile usage) is untouched. Verified in a
  browser: flipped "Today" to its bar chart, clicked `‹` on the still-
  flipped card — it advanced to "Yesterday" and redrew the chart without
  flipping back.

## Dashboard: highest/lowest production day tiles (2026-09-19, user request)

- User: "add tiles with top high 3 production days and the top low 3
  production days" — total house usage, grid utilization, solar
  production (the ranking criterion), and "battery utilisation — you
  decide what makes sense."
- New `GET /api/stats/top-days`: ranks FINISHED days (pv_daily rows,
  `rollupPvDaily` populates one per day for yesterday — today is always
  excluded so a partial day can't out-rank a full one) by
  `produced` (total PV, to-home + to-battery — same field "Right now"/"How
  today will end" already use), and drops zero-production days (pre-
  install, before "the system was built") so they don't dominate
  "lowest". Returns `{top: [...3], bottom: [...3]}`, each row
  `{date, pvProducedKwh, gridKwh, battKwh, battInKwh, homeKwh}`.
  Decided "battery utilization" = both directions: `battKwh` (discharged
  — reduced that day's grid need) and `battInKwh` (charged — stored for
  later), since either can be why a day stands out.
- **Bug caught before shipping**: `battInKwh` was first wired to the
  battery's cloud day-trend (same source `/api/stats/period`'s `battKwh`
  and `/api/stats/overview`'s `battKwhForDay` use for discharge) split by
  sign — but a raw `cloud_history` query for a known day
  (`SELECT MIN(power)...` for `2026-09-15`) showed the trend is
  discharge-only: minimum power was `0.0` all day, never negative, on
  this account. `battKwhForDay`'s existing `chgKwh` field has always been
  computed-but-unused for exactly this reason (grepped — nothing reads
  it). Fixed by sourcing `battInKwh` from `pv_daily.to_batt` instead —
  the nightly rollup's own local trapezoid integration (`pvKwhForDay`,
  welcome-ai.js), which does carry real per-day charge amounts (e.g.
  2026-09-16: `1.55` kWh) — confirmed via a direct `sqlite3` query on the
  local dev DB before wiring it in.
  - `web/src/dashboard/Dashboard.jsx`: new `TopDaysCard` (two tiles,
    `.topdays-grid`), reuses the `.src-card` chrome from the flip-nav fix
    above and the `wx-c-grid`/`wx-c-pv`/`wx-c-batt` color classes from the
    Welcome tab color-coding request — same colors, one meaning, across
    every tab. Rank badge + date + production headline, then a muted
    house/grid/battery detail line. `top-days` fetch is best-effort
    (`.catch(() => null)`, non-fatal) alongside the existing
    `/api/stats/overview` call — a failure there doesn't block the rest
    of the dashboard, matching this app's established pattern.
  - Known small-dataset quirk (not a bug): with only ~5-6 finished days
    of history so far, the same day can appear in both tiles (the
    median day is simultaneously in the top-3 and bottom-3 of a small
    pool) — resolves itself as more days accumulate.
  - Follow-up same day: `formatDayLabel` added `year: "numeric"` (user
    request) — dates now read e.g. "Tue, Sep 15, 2026", useful once this
    ranking spans multiple years.

## ROI BOM: "Extended (not yet purchased)" section (2026-09-19, user request)

- User: "add also this to BOM but don't enable it yet. there is already
  the cover for the battery which is on the list but not enabled. make
  the extended list where you put that one and also [the BP5000] ... this
  list display it like you displaye the cover for now" — a new Anker
  Solix BP5000 (5 kWh expansion battery for the Anker SOLIX **4 Pro**
  line, €1.049,00, solago.de) plus the existing battery weather cover
  (previously just `excluded: true` sitting first in the main list)
  should move into their own "extended"/optional section, both flagged
  not-yet-purchased.
- `server/roi-bom.json`: added `"category": "extended"` to the existing
  cover row (`B0H2HZWTX9`) and to a new `BP5000` row (`excluded: true`,
  synthetic asin like the existing `PVMOUNT` non-Amazon entry — the field
  is just a lookup key, not validated as a real ASIN). `desc` flags the
  compatibility caveat plainly: the BP5000 is built for the SOLIX 4 Pro,
  not the E1600 Plus actually installed here — tracked as a possible
  future upgrade path, not a confirmed-compatible add-on.
- `server/roi.js`/`roi-pdf.js`: untouched — `bom.map((r) => ({...r, ...}))`
  already spreads every field through, so `category` flows to both the
  JSON payload and the PDF for free; the PDF keeps listing every row
  flat with "(not counted)" for excluded ones (no section break there —
  out of scope for a hand-rolled PDF layout, not requested).
  `totalInvestedEur`'s existing `excluded`-skips-the-sum logic already
  covered the new row with no change.
- `web/src/roi/RoiTab.jsx`: extracted the existing inline BOM row JSX
  into a shared `BomRow` component (same thumbnail/name/qty×price/line-
  total/"not counted" markup for both sections — the user's ask was to
  "display it like you display the cover for now"). `data.bom` split
  into `mainBom` (`category !== "extended"`) and `extendedBom`
  (`category === "extended"`) client-side; a second `.card` — "Extended
  (not yet purchased)" — renders only when `extendedBom.length > 0`.
  Generalized the row's hover title from the hardcoded "— open on
  Amazon" to "— view product" since this list now has a non-Amazon item.
- Product photo: fetched from solago.de's CDN (PNG despite the `.webp`
  URL extension — Shopify content-negotiates by Accept header), converted
  to a real JPEG and resized to 400×400 (`sips`, matching the existing
  thumbnail dimensions) at `server/roi-images/BP5000.jpg`, committed —
  same "fetched once, committed to git" pattern as every other BOM image.
- Follow-up same day: user asked for the printable PDF (`bom.pdf`) to get
  the same 3-way split as the ROI tab — "first section with what was
  bought and a total sum, the second section with what is planned to be
  bought, their partial sum, a third section with the grand total."
  `server/roi-pdf.js`'s `buildBomPdf()` restructured: `bom` split
  client-side-of-the-function into `mainRows`/`extendedRows` by
  `category`, rendered under "Purchased (bill of materials)" and
  "Planned (not yet purchased)" headers, each closed by a `sumLine()`
  (subtotal), then a final bold "Grand total" = both subtotals summed.
  The per-item `(not counted)` name suffix (added upstream in
  `roi.js`'s route) stays — harmless once redundant with the section
  header, not worth a special-case to strip it back off.
  - Real refactor forced by the split: image XObjects were previously
    keyed by flat `bom` array index (`images[i]`/`imageId(i)`), which
    silently breaks the moment rows render from two separate filtered
    sub-arrays instead of one pass over `bom` — switched to a
    `Map<asin, image>` (`imagesByAsin`) plus a stable per-asin index
    (`imageAsins`/`imgOpId`), so both the content-stream image
    references and the PDF object numbering stay correct regardless of
    which section a row renders in.
  - Verified visually, not just by page/byte count: Chrome's built-in
    PDF viewer wouldn't take synthetic scroll/keyboard input from the
    browser tool on this file (`Content-Disposition: attachment` also
    blocks direct in-tab viewing), so rendered both pages to PNG via a
    throwaway PyMuPDF venv (`pip` refused a global install — PEP 668)
    and read them directly — confirmed real thumbnails on every row
    (including the two extended items), correct subtotals (€904.34 /
    €1,461.99) and grand total (€2,366.33), and a clean page break
    between "Purchased" and "Planned" with no cut-off content.

## Live tab: today mini-charts on tile flip (2026-09-19, user request)

- User: "on the live tab when I flip the tiles show me graphs of the
  values for today ... nothing fancy, no zooming, scrolling, just to
  simply visualize what is on front of the tiles for the day."
- New `web/src/live/TodayMiniChart.jsx`: a deliberately bare ECharts
  line (`animation: false`, no legend/toolbox/dataZoom, muted axes) —
  same minimal spirit as Dashboard's `BackBars`, but a line instead of
  bars since these are continuous power readings, not per-bucket
  totals. Optional `zeroLine` prop (dashed reference line at 0) for the
  two signed metrics.
- No new backend endpoint: reused `/api/stats/overview`'s existing
  `profile` array (30-min buckets, already computed for the Dashboard's
  "Today" tile) — `LiveTab.jsx` now also fetches it, on its own 60 s
  interval (independent of the 5 s live-flow poll; today's shape doesn't
  need that freshness), best-effort like every other secondary fetch in
  this app.
- Per-tile series, deliberately reusing existing fields rather than
  inventing new ones (see the code comment for the reasoning):
  `grid` ← `profile.power` (already signed, matches the Grid tile
  exactly); `battery` ← `profile.batt` (signed net flow, + discharge /
  − charge); `Solar PV` ← `profile.pvHome` (PV-to-house — the same
  field the Dashboard's own PV bars already use, not total production;
  kept one PV definition instead of introducing a second); `House` ←
  reconstructed the same way the Dashboard's hourly bars are (grid
  import + battery discharge + PV-to-house, all clamped ≥ 0).
  `connectNulls: false` so a real gap (e.g. before sunrise, no pvHome
  data) reads as a gap, not a guessed line across it.
  Scoped to just the 4 main `.cards` tiles (House/Grid/Battery/Solar
  PV) — the collapsed "Details" section's per-phase/per-PV-string
  FlipTiles are left with an empty back (no per-phase/per-string history
  exists to graph without new backend work, not requested).
- `.todaymini-chart`/`.todaymini-empty` CSS added — floor height 90px
  (vs. `.back-bars`' 120px), matched to the Live tab's much shorter
  `.card` front faces (3 short lines vs. Dashboard's taller stat cards).
- **Follow-up same day, user: "for the battery show also the loading
  part"** — the shipped battery series (`profile.batt` =
  `output_w − charge_w`) conflated PV pass-through with real charging and
  rarely showed a clear negative (charging) excursion, unlike the front
  tile's clean cells-vs-charge split. Root fix, not a display tweak:
  `/api/stats/overview` (`server/index.js`) gained a fourth anchor map,
  `chargeAnchors` (bucketed `Math.max(0, r.charge_w ?? 0)` from the same
  `getBatteryHistory()` loop that already builds `battAnchors`/
  `cellsAnchors`/`pvAnchors`), interpolated the same gap-aware way, and
  exposed as a new `profile[].chargeW` field. No cloud-day-trend fallback
  exists for it — that series is discharge-only (see the ROI BOM entry's
  sibling finding), local samples only, same limitation `pv_daily.to_batt`
  already has. `LiveTab.jsx`'s `battSeries` changed from `p.batt` to
  `(p.cells ?? 0) - (p.chargeW ?? 0)` — now matches the front tile's own
  cells/charge distinction exactly: positive = discharging, negative =
  charging ("loading"), verified live (screenshot showed clear negative
  dips against the zero-line where charging occurred).
- **Second same-day follow-up, user: "show both load and unload in the
  flipped tile"** (sent in parallel with the architecture review below,
  explicitly asked to be branched/merged before that finished) — the
  single signed purple line only distinguished direction by which side
  of zero a point fell on; color didn't reinforce it. `TodayMiniChart.jsx`
  generalized from a single `data`/`color` pair to a `lines` array (one
  entry per series: `{data, color, name}`) — House/Grid/PV pass one
  line each (unchanged behavior), Battery now passes two:
  `battDischargeSeries` (`Math.max(cells, 0)`, purple `#c084fc`, matches
  the front tile's discharging color) and `battChargeSeries`
  (`-Math.max(chargeW, 0)`, grey `#8b98a5`, matching Dashboard's
  established "To battery"/`BATT_IN_ROW` charge color) — same zero-line
  separation as before, now reinforced by color too. Verified live via
  a zoomed screenshot of the flipped Battery tile: discharging renders
  as a purple area above zero, charging as a grey area below.

## Architecture review + first fix: one shared day-energy module (2026-09-19, user request)

- User: "review the code, look with an architect eyes to it, make sure
  that there is a design with generic controls which are reused and
  particularized for specific cases... go deep and take your time."
  Full write-up published as an artifact (see chat for the link);
  verdict: three backend modules (`welcome.js`/`roi.js`/`battery-params.js`)
  use a real `registerXRoute(app, deps)` DI pattern and `power-plan.js`
  has a genuine strategy dispatcher, but that discipline stopped there —
  most duplication in the codebase is the SAME operation reimplemented
  per call site rather than a missing abstraction never attempted.
  Concretely: "battery kWh for one finished day" existed as four
  separate functions (`battKwhForDay`/`battKwh`/`batteryDayDischargeKwh`
  in index.js, `cellsKwhForDay` in roi.js) — the direct mechanism behind
  the `battInKwh` bug from the ROI BOM/top-days work earlier this
  session (wrong one of four was in scope when a new call site needed
  it). User said "go for it" — first fix implemented same day.
- New `server/energy-day.js`: `dayBattery(battSn, dateStr)` →
  `{dischargedKwh, chargedKwh, hasRows}` (merges all four battery-day
  variants — also fixes a latent bug: `batteryDayDischargeKwh` alone was
  missing the discharge-only filter the other three had, silently
  correct only because this account's cloud series never reports a
  negative value); `dayGridImportKwh(sn, dateStr)`; `dayPv(dateStr)` →
  `{toHome, produced, toBattery}` from the `pv_daily` rollup (merges
  `pvKwhDay`/`pvProducedDay` in index.js's `/api/stats/period` and the
  non-today branches of `/api/stats/overview`'s inline closures — the
  "today" live-trapezoid special case stays where it was, since that's
  genuinely route-specific data, not duplicated logic).
  `index.js` net −43 lines despite gaining an import; `roi.js` −6.
  Deliberately did NOT force `monthKwh`/`monthRows` (bulk month-fetch,
  used by week/month/year rollups) through the new single-day functions
  — different access pattern for a different problem, not the same
  duplication.
- **Verified behavior-preserving, not just "builds"**: captured
  `/api/stats/overview`, `/api/stats/period` (day/week/month/year),
  `/api/stats/top-days`, and `/api/roi` against the local dev DB both
  before (`git stash`) and after the refactor. Every FINISHED-day
  endpoint (period day/week/month/year, top-days, ROI's measured-savings
  series which stops at yesterday) came back **byte-for-byte identical**.
  The only diffs were in `/api/stats/overview`'s "today" figures, fully
  explained by real time passing (~a few minutes) between the two
  captures — not by the refactor.

## ROI BOM: two more "Extended" entries (2026-09-19, user request)

- User pasted a German eBay listing (title, price, Artikelnr./
  Bestellnummer, seller address) for a full Solarbank 4 Pro bundle, then
  — mid-turn, in a separate message — an Amazon-style listing (title,
  brand, price, no link) for mineral wool insulation, both "to the BOM
  second list which was not bought yet."
  - **eBay item**: gave only a bare `Artikelnr.` (127918005920), no URL.
    Per the standing "never guess URLs" rule, did not silently construct
    `ebay.de/itm/<item>` from it — asked the user first; they confirmed
    the exact URL themselves before it was used. `WebFetch` 403'd on it
    (eBay blocks non-browser fetches) — used the already-connected
    Chrome tab instead, which loaded it fine (logged into the user's own
    eBay session; read-only, no action taken), confirming title/price/
    seller match what was pasted and yielding a real product photo via
    `document.querySelector('img[src*="ebayimg"]')`.
  - **Insulation item**: no link at all, and no reliable identifier to
    construct one from (unlike eBay's numeric item-in-URL pattern, an
    Amazon product URL needs an ASIN, not given) — used an Amazon
    search-results URL instead, same precedent as the existing `PVMOUNT`
    entry. The product photo itself arrived as a direct paste in the
    conversation, not a link — found it via its file path over
    `~/.claude/image-cache/<session-id>/`, keyed on the same "[Image #N]"
    number the chat transcript referenced.
  - New entries `SOLIX4E5000` (€2,349.00) and `ROCKWOOL50MM` (€75.00),
    both `category: "extended"`/`excluded: true`, both with real
    downloaded/pasted thumbnails resized to the established 400px
    convention. `SOLIX4E5000`'s description flags that it's a whole-
    system bundle that would supersede, not stack with, the standalone
    `BP5000` entry already in the list.
  - Verified via the running dev server: `/api/roi`'s `totalInvestedEur`
    unchanged (both new rows excluded as intended), both thumbnails
    serve 200, both render correctly in the "Extended" card.

## Architecture roadmap item #2: extracted /api/stats/* into stats.js (2026-09-19, user: "continue now with the plan")

- Second item from the architecture review's roadmap: "extract
  `/api/stats/*` the same way ROI was extracted." Moved `/api/stats/
  overview` (~466 lines), `/api/stats/period` (~171 lines), and
  `/api/stats/top-days` (~31 lines) out of `index.js` into a new
  `server/stats.js`, using the exact `registerXRoute(app, deps)` shape
  `roi.js` already proved — `registerStatsRoute(app, {getMeterSn,
  getBatterySn, getLiveBattery})`, all three deps reusing the identical
  closures already passed to `registerRoiRoute`/`registerBatteryParamsRoute`
  at the index.js call site (same `poller`/`latestBattery` module state,
  just read through a getter instead of closed over directly).
  `index.js`: 1876 → 1171 lines (−705). `mondayOf`/`hourlyKwhFromRows`/
  `pvStoredTotals` moved with their only callers; `localDate` got its own
  local copy in stats.js rather than importing it back from index.js —
  same reason `roi.js` already keeps its own copy: index.js has top-level
  side effects (starts the server, background jobs) that would fire on
  import, so nothing extracted out of it may import back into it.
  Also dropped `getPvDailyDates` from index.js's db.js import list — it
  turned out to already be unused before this refactor even started
  (confirmed via `git show HEAD:server/index.js`), not something this
  change orphaned; fixed since it was directly in the block being edited.
- Mechanical transformation, not a rewrite: extracted the exact route
  bodies via `sed` from the file itself (not retyped), applied exactly
  three substitution patterns (`poller.snapshot?.meter?.sn ??
  getAnyDeviceSn()` → `deps.getMeterSn?.() ?? getAnyDeviceSn()`, the
  equivalent for `getBatterySn`, and `latestBattery ?? getLatestBattery()`
  → `deps.getLiveBattery?.() ?? getLatestBattery()`), then diffed the
  transformed block against the original to confirm those were the ONLY
  changes before ever writing the new file.
- **Verified behavior-preserving** the same way as roadmap item #1: full
  `git stash -u` before/after capture of `/api/stats/overview`,
  `/api/stats/period` (day/week/month/year), `/api/stats/top-days`, and
  `/api/roi` against the local dev DB. Every finished-day figure, ROI's
  full BOM, and ROI's measured-savings series (stops at yesterday) came
  back **byte-for-byte identical**; the only diff anywhere was one new
  hourly bucket in `overview`'s `today.bars` (a real hour boundary
  crossed between the two captures — expected) and an unrelated
  `/api/health` Modbus-connection timing blip. Also reproduced the CI
  smoke test locally against a genuine cold start (`PORT=3200 node
  server/index.js`, not `--watch`) — all three checks passed.

## Architecture roadmap item #3: shared usePolledResource hook (2026-09-19, user: "continue until you are done with all")

- Third item from the architecture review's roadmap: retire the
  independently hand-rolled fetch+useEffect+setInterval+error-state
  block that had been copy-pasted (with drifting small differences)
  across most tab components.
- New `web/src/usePolledResource.js`: `{data, error, loading, refresh,
  setData}` from one call. Two options earned their way in by actually
  being needed at a real call site, not spec'd in the abstract:
  - `envelope: false` — this API has two response shapes (a second,
    not-yet-fixed architecture-review finding): most routes return
    `{ok, data, error}`, but `/api/power-plan` and friends return the
    bare payload. Needed by Strategy/PowerPlanCard.
  - `keepLastGoodOnError` — once real data has loaded, a transient poll
    failure is swallowed instead of surfacing, for tabs whose render
    checks `error` BEFORE `!data` (so an unguarded failure would blank
    an otherwise-fine page over one missed poll). Needed by Welcome,
    which already had this exact behavior hand-written via a
    `hasData` ref — the hook just gives it a name and a second user.
  - `setData` is exposed deliberately: every mutation call site (ROI's
    baseline recompute, Strategy/PowerPlanCard's strategy/enable
    actions, Battery's refresh button) already pushes its own POST
    response straight into state instead of waiting for the next poll
    tick — the hook has to support that or every mutation regresses to
    an extra round-trip.
- **Migrated where it cleanly fit**: `BatteryTab.jsx`, `RoiTab.jsx`,
  `StrategyTab.jsx`, `PowerPlanCard.jsx`, `WelcomeTab.jsx`'s main poll.
  Strategy/PowerPlanCard was the literal duplicate the review called
  out — same endpoint, same 10s interval, two independent hand-rolled
  copies; now one hook, called from both (still two separate network
  requests, same as before — see below).
- **Real latent bug fixed as a side effect, not the point of the
  change**: `RoiTab.jsx`'s old code never called `setError(null)` on a
  successful poll — one failure would permanently wedge the tab behind
  its error screen even after the endpoint recovered. The hook clears
  `error` on every success by construction, so this self-heals now.
- **Deliberately left custom, not forced into the hook**:
  `Dashboard.jsx` (`Promise.all` of a required + a best-effort
  secondary fetch — asymmetric semantics per URL, doesn't map onto a
  single-resource hook without either a multi-URL variant nobody else
  needs or an awkward two-hook composition), `LiveTab.jsx` (three
  independently-cadenced concerns — 5s live+flow, 10s health, 60s
  today-profile — genuinely not "one resource, one interval"),
  `GraphTab.jsx` (parametrized windowed time-series fetching plus a
  live-tail append loop, a fundamentally different shape), and
  `WelcomeTab.jsx`'s secondary yesterday/week-so-far effect (a one-shot
  dual-fetch on mount, not polling at all). Forcing these into the hook
  would have made the code worse, not better — matching "generic
  control, reused and particularized," not "one hook for everything."
- **Not done, noted rather than silently skipped**: the hook dedupes
  *code*, not *network requests* — Strategy and PowerPlanCard still
  each poll `/api/power-plan` independently every 10s (2 requests, not
  1). A shared subscription cache (one timer/fetch per URL, fanned out
  to every subscribed component) would fix that too, but is a
  meaningfully bigger, riskier piece of infrastructure than what the
  roadmap item asked for ("a hook to retire duplicated boilerplate");
  left as a follow-up, not attempted here.
- Verified in a browser (dev server, power-plan controller disabled)
  across all 5 migrated call sites with real live data: Strategy tab
  (+ its embedded BatteryTab gauge), Live tab's Power Plan card
  (expanded, showing live decision state), ROI tab (tiles + chart +
  BOM), Welcome tab (briefing + the untouched secondary cards). Also
  spot-checked Dashboard (untouched) to confirm nothing else regressed.

## Architecture roadmap item #4: standardized the API response envelope (2026-09-19, user: "continue until you are done with all")

- Fourth item: `/api/live` and all four `/api/power-plan*` routes were
  the last holdouts of a three-shape inconsistency across this API
  (most routes: `{ok, data}`/`{ok, error}`; these five: the bare state
  object on success, `{error}` with no `ok` field on failure) —
  frontend code had to already know, per endpoint, which shape to
  expect before it could safely read a response.
- `server/index.js`: `/api/live` now `{ok: true, data: state}`; all
  four power-plan routes now `{ok: true, data: powerPlan.getState()}`
  on success, `{ok: false, error: msg}` on failure — matching
  `cloudRoute()`'s existing wrapper, the pattern this fix generalizes.
  `powerPlan.getState()`'s OTHER (non-HTTP) callers — `welcome.js`'s
  `getPowerPlanState` dep, `index.js`'s own `dischargeTolerancePct`
  read — call the controller method directly, not through the wrapped
  route, so they're unaffected by design.
- Frontend updates, one per real consumer (found by grepping every
  `/api/live`/`/api/power-plan` reference first, not by guessing):
  `LiveTab.jsx` (`if (l) setLive(l)` → `if (l?.ok) setLive(l.data)`),
  `PowerPlanCard.jsx`/`StrategyTab.jsx` (dropped the `envelope: false`
  the previous item's hook needed for exactly this inconsistency —
  no longer needed now that it's fixed — and their `enable`/
  `setStrategy` POST handlers unwrap `.data` before `setState`).
  `/api/power-plan/disable` was fixed too although unused by the
  frontend today (intentionally — see the Live tab comment) — it's
  still a real, documented endpoint, and leaving it on the old shape
  while its three siblings moved would just be a new inconsistency.
- Verified: raw `curl` confirmed both new envelope shapes; browser
  check (dev server, power-plan controller disabled) across Live tab
  (badges, flow diagram, Power Plan card) and Strategy tab; **exercised
  the POST mutation path directly** — clicked "House priority" then
  back to "Anker app" (safe: `enabled:false` means `tick()` never
  writes to the device regardless of strategy) — confirming the
  `setState(s.data)` unwrap works end-to-end, not just the GET path.
  Reproduced the CI smoke test against a genuine cold start; the
  `grep -q '"connected"'` check still passes unchanged since it matches
  on the literal field name regardless of nesting depth.

## Architecture roadmap item #5 (final): centralized the tariff fallback (2026-09-19, user: "continue until you are done with all")

- Fifth and last item: `TARIFF_EUR_PER_KWH` was read independently in
  five places across four files, with two different fallback values —
  `?? 0` in `stats.js`'s two cost-calculation sites, `?? 0.3` in
  `roi.js`, `roi-baseline.js`, and `welcome-sources.js`. If the env var
  were ever unset, Dashboard/period-stats would have silently shown €0
  costs while ROI/Welcome assumed 0.3 €/kWh — a real behavioral
  divergence between tabs that would only surface as "why do these two
  tabs disagree about money," hard to trace back to its cause.
- New `getTariff()` in `server/env.js` (the module that already centralizes
  *loading* the .env file — this extends it to centralize one specific
  *value* too). Fallback is `0.3`, not `0` — checked `.env.example`
  first, which documents `TARIFF_EUR_PER_KWH=0.30`: `0.3` is the
  project's own established convention, already the majority (3 of 5)
  of existing call sites, not a new choice invented for this fix.
  `stats.js`'s `?? 0` was the outlier being corrected, not the other
  way around.
- Updated `stats.js` (both sites), `roi.js`, `roi-baseline.js`
  (simplified `config?.tariff ?? Number(process.env.TARIFF_EUR_PER_KWH
  ?? 0.3)` to `config?.tariff ?? getTariff()` — same value, one less
  duplicated expression).
- **Deliberately left one site alone**: `welcome-sources.js`'s
  `parseWelcomeConfig(env = process.env)` reads `env.TARIFF_EUR_PER_KWH
  ?? 0.3` — already the correct value, so not actually part of the
  inconsistency. Every call site in the codebase calls it with no
  arguments (confirmed via grep), always defaulting to `process.env`,
  but the function is explicitly designed to accept a substitute `env`
  object — swapping that line for a `getTariff()` call (which always
  reads `process.env` directly) would silently break that override
  capability for a site that wasn't actually broken. Consolidating
  everything that reads the SAME way is the goal; collapsing a
  differently-shaped, already-correct pattern into the new helper
  isn't the same fix.
- **Verified via the same stash-based before/after method as the
  earlier items**: `/api/stats/overview`, `/api/stats/period`
  (yesterday), and `/api/roi` captured before and after against the
  local dev DB. Every tariff-dependent figure — `costs`, `byPeriod.week`,
  ROI's `savingsSoFarEur` and full `baseline` object — came back
  identical, because this account's real `.env` already sets
  `TARIFF_EUR_PER_KWH=0.3068`, so the fallback path (the only thing
  this change touches) was never actually exercised by the comparison
  — expected, and the right outcome: a fallback-only fix should be
  invisible until the env var is genuinely unset. Reproduced the CI
  smoke test against a cold start.
- This closes out the architecture review's 5-item roadmap (PRs #160,
  #162, #163, #164, and this one) — see the "Architecture review" entry
  above for the original audit and the artifact it was published as.

## Dashboard channel audit (2026-09-15)

- **Uniform per-day channel split, NO double booking** (verified numerically
  against raw DB + cloud): `pvKwh(day)` = PV direct-to-home; `battKwh(day)` =
  CELLS-only discharge. **The cloud battery day-trend `power` series IS
  cells-only** (09-14: cloud 0.41 ≈ local cells 0.34, NOT the 2.66 inverter
  output) — it never overlaps the PV channel. For today the cloud series
  lags, so today's cells = live trapezoid `discharge − pvToHome` (substituted
  into the week/month/year sums + bars). The solarbank `charge_total` /
  `discharge_total` scalars are CUMULATIVE counters — useless for daily
  history (7.62 "today" vs actual 1.08); the 20-min series + pv_daily are
  the online-account history.
- Today tile has a 4th row **"To battery"** (`battInKwh` = PV→battery,
  `min(pv_w, charge_w)` trapezoid) — informational, **never gets €**: those
  savings are booked when the energy comes back as cells discharge.
- **pv_daily pollution bug (fixed)**: `getBatteryHistory(sinceMs)` ignored
  its end argument, so `pvKwhForDay(X)` integrated X→now and every rollup
  re-write inflated yesterday's row with the following days (proved by exact
  arithmetic: 3.69 = 0.54 + 2.32 + 0.83). Fix: `getBatteryHistory(sinceMs,
  untilMs)` honors the end bound; `rollupPvDaily` recomputes YESTERDAY only
  (day-before would shrink as its early samples hit the 48 h prune). The
  corrupted 09-11/12/13 rows were unrecoverable (raw samples pruned) and
  were DELETED — PV history starts clean at 2026-09-14.
- Tiles UI: equal heights (stretch chain through FlipTile + flex column,
  money footer pinned via `margin-top: auto`), uniform right column (kWh
  over €, `.src-kwh`/`.src-value` column). **`.back-bars` must stay
  `position: absolute; inset: 0`** inside `.flip-back` (relative+overflow
  hidden): ECharts writes its measured pixel height inline, and as normal
  flow content that feeds back into the grid row height and grows without
  bound (seen: 120 px → 4 812 px runaway).
- Past periods (`/api/stats/period`): pvKwh from `pv_daily.to_home`,
  bars carry the pv segment (BackBars already rendered it, data was 0).

## Consumption-by-source tiles (2026-09-12)

- The Dashboard contains ONLY this section (old tiles — totals row, day
  profile, week/month/year kWh bars, battery SOC tile — removed 2026-09-13;
  `DayTile`/`KwhBarsTile`/`MiniChart` deleted, git history has them).
- 4 period cards (Today/Week/Month/Year) × 4 values (house total, from grid,
  from battery, from PV — chart colors, spartan).
- **Flip side**: stacked kWh bars per bucket (`web/src/dashboard/BackBars.jsx`)
  — Today = 30-min buckets from the profile, Week/Month = per day (cloud month
  rows + battery day-trends), Year = per month (battery summed from day-trends,
  ~365 local queries per call). ECharts axis tooltip shows the day's split.
  Data: `byPeriod.*.bars` in `/api/stats/overview`.
- **Time navigation**: ‹ › in each card's title row (`/api/stats/period?
  type=day|week|month|year&offset=N`, offset ≥ 1; offset 0 = overview data).
  Day = that date's cloud day-trend (20-min bars), week = rolling 7-day window
  shifted by whole weeks, month/year = calendar. `hasData`/`hasEarlier` stop
  navigation at the data edge (`getEarliestCloudDay`, meter linked 2026-09-06
  — e.g. August/2025 are unreachable). Buttons `stopPropagation` (no flip).
  From `/api/stats/overview` → `byPeriod`: today from the `flows` trapezoid,
  week/month battery from the battery's cloud day-trends (`disKwh`), year
  battery = day-trend sum (complete — battery is new). Accounting: house =
  grid import + battery discharge + PV **direct-to-home** (PV→battery counts
  later as battery, no double counting).
- **PV is 0 beyond today**: `pv_w` samples live only 48 h and the cloud has
  no PV channel — once panels exist, week/month/year PV needs a daily-rollup
  table (add it when panels arrive, not before).
- Replaced the redundant "Home today"/"PV today" tiles.
- Each source row also shows € (`gridEur` spent, `battEur`/`pvEur` "saved" =
  avoided grid import at the same tariff — same grid-charged-battery caveat
  as `costs.batterySavingsToday`).

## Second page: overview dashboard (epic #8, done 2026-09-09)

## Live-tab shell + version (2026-09-11)

- 4-tab shell in `App.jsx` (Live/Graph/Dashboard/History, hash-routed).
  Live (`web/src/live/LiveTab.jsx`), Graph (`web/src/graph/GraphTab.jsx`) and
  Dashboard (`web/src/dashboard/`, unparked 2026-09-11: totals + cost tiles,
  day profile, week/month/year kWh bars, battery SOC tile) are implemented;
  History is a placeholder, `SiteInfo.jsx` still parked under
  `web/src/parked/` (not bundled).
- App version comes from the ROOT `package.json` via `define: __APP_VERSION__`
  in `web/vite.config.js`, shown discreetly as `.app-version` in the header.
  Bump the root version when the app changes. The Dockerfile's webbuild stage
  must `COPY package.json /app/package.json` for this (it only copies `web/`).
- Details phase/PV cards (`.phase-cards`) render at ALL widths (wrapping row
  on desktop, stacked on phones) — they were `display:none` above 600px after
  the details table was removed, which emptied the section on desktop.
- `nav` wraps (`flex-wrap`) and phone buttons are compact so nothing forces
  horizontal scrolling.

## AI Welcome tab (2026-09-12)

- 5th tab "Welcome" is the DEFAULT route. `GET /api/welcome` (server/welcome.js)
  gathers deterministic facts → ONE OpenAI-compatible AI call
  (`response_format: json_schema`), **at fixed local slots 6:00–22:00 every
  2 h** (9 calls/day, each updated with the day's actuals: localTime +
  pvProducedTodayKwh in the context; stale = older than the most recent slot
  boundary), deterministic fallback (`aiPowered: false`, 15-min self-heal TTL)
  when the AI is down. A background scheduler (45 s after startup, 1-min tick)
  refreshes at the slots — opening the tab never waits for the AI. The prompt
  adapts to the slot: morning = day ahead, afternoon = progress + remaining,
  evening = wrap-up + tomorrow. Manual ↻ refresh stays on demand.
- **`/api/welcome` never blocks the client**: fresh cache → instant; stale
  cache → instant `stale: true` + background refresh (fire-and-forget); only a
  cacheless cold start waits. (The old blocking wait for a flaky AI call was
  the recurring "Preparing your briefing…", 2026-09-15.)
- **AI call hardening** (Kimi Code endpoint latency varies 1 s…>30 s): 60 s
  timeout, retry json_schema → json_schema → json_object before the
  deterministic fallback (json_object alone often answers off-schema).
- **Background-first data model (2026-09-14)**: the server always pulls —
  meter Modbus loop + unconditional 10 s `scen_info` (6 calls/min, inside the
  ~10-12/min guideline; carries live grid values via `grid_info` when Modbus
  is down) + MQTT on top. Clients just read what's in memory/DB; there is NO
  client-presence gating anymore.
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
- The system prompt encodes the **Self-Consumption priority** (from the
  Solarbank manual): PV → house first, surplus → battery, grid last. Consumption
  averages feed it CLEAN data: 0-filled pre-link days (`importKwh <= 0`) and the
  always-partial linking day are excluded — otherwise the AI reasons against a
  bogus ~0 baseline and inverts the house/battery split.
- **Voice Q&A** (🎤 in the header, `web/src/components/AskButton.jsx`): browser
  `SpeechRecognition` STT → `POST /api/ask` → ONE structured AI call corrects
  the transcript AND answers (`{correctedQuestion, answer}` json_schema), fed
  with the welcome context + live grid power (`getLivePower` dep). Answer shows
  in a **modal overlay** (`.ask-backdrop`, tap outside/× to close) and is
  **read aloud immediately** (`SyncedSpeech` autoPlay) with the text **written
  word-by-word at the voice's pace** (only spoken words visible, current one
  highlighted via `onboundary`; full text stays after the reading ends). The
  prompt keeps answers SHORT (2-3 sentences, on-subject) and makes the AI say
  it doesn't know for off-topic/answerless questions (home-energy scope only).
  **Dead-man auto-close**: 3 s after the reading ends the overlay closes;
  every tap on it re-arms the 3 s (no speech support → timer starts at once). Speech control is shared (`speakText`/`stopSpeech` in
  `SpeakButton.jsx`) so the button state tracks auto-started playback.
  Mic-denied and no-key states have friendly errors; STT-less browsers hide
  the button. Plain-HTTP LAN origins get NO mic prompt (secure-context rule —
  `chrome://flags#unsafely-treat-insecure-origin-as-secure` is the workaround).
- **Read-aloud (TTS)**: every Welcome tile has its own 🔊
  (`web/src/components/SpeakButton.jsx`) reading only that tile's content —
  browser `speechSynthesis` (the **Kimi API has no TTS/ASR**, so nothing
  server-side). One utterance at a time across all buttons (starting one
  stops the current), ⏹ while speaking, cancels on unmount, prefers a Google
  en-* voice (Android Chrome), stopPropagation + corner-positioned
  (`.speak-corner`) so tiles don't flip.
- **Open-Meteo `shortwave_radiation_sum` is MJ/m², not kWh/m²** — the context
  divides by 3.6 into kWh/m². That unit trap cost a fix round.
- Cold start with Open-Meteo down → generic error state (no partial render);
  bookend cards show SOC as text, not bars (spec amended).
- **Restructured into Today/Week groups, Production+Savings folded in, tiles
  made more animated (2026-09-16, user request)**: was 9 tiles (hero,
  weather, start-of-day, Production, end-of-day, yesterday, This week,
  month, Estimated savings) with production/savings standing alone. Now 10:
  hero, weather (unchanged, but animated — see below), then Today as 3 cards
  (start / **Right now** / end) and Week as 3 cards (**This week so far** /
  **what's coming** / **week estimate**), yesterday, month. Production
  numbers moved into "Right now" (`production.todayKwh`, was its own card);
  today's savings moved into "How today will end"
  (`endOfDay.estimatedSavingsEur`, NEW field); the `savings` schema object
  is gone entirely. `week.statement` (one generic blob) split into
  `week.upcoming` (forecast-driven, ONLY days still ahead — the prompt is
  explicit that today/past are out of scope here) and `week.estimate` +
  `estimateKwh`/`estimateEur` (a projection through Sunday, not a recap).
  "This week so far" is deliberately NOT part of the AI schema — it's a new
  deterministic component (`ThisWeekSoFarCard`, mirrors `YesterdayCard`)
  reading `/api/stats/overview`'s `byPeriod.week` (now calendar-week
  aligned, see the Dashboard bar-chart fix entry above) — measured
  "so-far" facts don't need an AI guess, and future days in that data are
  already 0 so the total is correctly partial without extra logic.
  `today.statusQuo` is a NEW schema field: the prompt requires present-tense
  language describing THIS EXACT MOMENT (battery.socNow/pvNowW/etc.), not a
  recap or forecast — verified against a real AI call; it correctly said
  "0 W, no solar, no charging" in the evening rather than restating the
  day's totals. Animation (CSS only, `prefers-reduced-motion` respected
  throughout): the sun-rise/set arc now draws the ELAPSED portion
  (sunrise → now) as a warm gradient stroke over the plain track — a live
  read of how much of today's daylight has passed, not just a static
  diagram — plus a pulsing glow behind the current-time marker; the weather
  icon has a slow breathing scale animation; the weather card got a subtle
  warm-tinted gradient background (still within the existing dark palette);
  "Right now" gets a small orange-accented border and a pulsing green
  live-dot next to its heading, visually setting it apart from the
  measured/predicted cards around it.

## Responsive design (epic #13, done 2026-09-10)

- Breakpoints: phone ≤600px, tablet ≤1024px; 44px touch targets on
  `pointer: coarse`; fluid `.app` container.
- Live page: 2-col card grid on phones; `.phase-cards` stacked column.
- Main chart: height is CSS-driven (`.chart-box`: 340px desktop, 240px phone,
  `calc(100dvh - 100px)` on landscape phones ≤500px high) so rotation resizes
  via the chart's ResizeObserver — do NOT set the height inline in JS again.
  Landscape phones also compact the page chrome (non-sticky header, 32px
  buttons, hint hidden): `dvh` already excludes the browser toolbars, so the
  old fixed `170px` subtraction shrank the chart to a ~130px strip (fixed
  2026-09-11 after headless-Chrome measurement: innerHeight ≈ 303 on an
  844×390 screen).
  Legend `type: "scroll"`, `hideOverlap: true` on axis labels; touch
  pinch/drag zoom is native in ECharts inside dataZoom.
- Tiles: period grid uses `minmax(min(320px,100%),1fr)` so it never overflows.
- **CSS comments are `/* */` only** — a `//` comment once silently swallowed
  the `.tiles` rule (tiles rendered full-width stacked).
- **Media-query overrides must come AFTER (or out-specify) the base rule**:
  the phone `.card { min-width: 0 }` sat BEFORE the base
  `.card { min-width: 180px }` in the file and lost the equal-specificity
  tie → cards forced a 465px layout viewport on phones ("Live tab zoomed
  in", fixed 2026-09-13 with `.cards .card`).

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

## Graph tab: y-axis zero floor, round labels, span persistence (2026-09-20, user reports)

- **Disproportionate stacked areas at 1h/6h zoom** — user screenshot showed
  Grid dominating and PV/Battery looking tiny at 1h, but proportionate at
  12h+. Root cause: `yAxis.scale: true` let ECharts pick a tight non-zero
  floor (e.g. ~300 W) at high zoom, clipping the bottom of the first
  stacked layer (Grid) and visually inflating the layers stacked above it.
  Verified the underlying data/derivation math was correct the whole time
  (traced `pvHomeOf`/`homeOf` against real `/api/timeseries` rows — summed
  to the exact Home line, to the decimal) before touching any code, since
  the first hypothesis (a battery-priority ceiling issue) turned out wrong.
  Fix (`web/src/graph/GraphTab.jsx`): dropped `scale: true` entirely —
  ECharts' plain default axis already always includes zero, which is both
  the fix AND gives round "nice number" tick labels for free (the
  scale-mode axis exposed raw data extrema like "2453.41 W" as a label).
  `axisLabel.formatter` also rounds explicitly, and `splitNumber: 3` cuts
  the tick count so the axis reads at a glance instead of 6+ crowded
  labels. The signed Battery chart (discharge +, charge −) still extends
  below zero correctly since nothing forces a fixed range.
- **Span resets to 24h on every tab switch** — `GraphTab` unmounts whenever
  the user leaves the tab (`App.jsx`'s conditional render, not
  `display:none`), so component state alone can't survive a return visit.
  Moved the per-graph selected span (`savedSpanMs`, one slot per graph)
  to module scope — survives remounts for the session, resets only on a
  full page reload. `activeArr`'s initial `useState` and the initial
  `unit.setSpan()` call both read it; `setSpan()` and the `datazoom`
  handler's shortcut-match both write it.
- **`from=NaN` timeseries requests looping every 5s** (console-error report,
  same session) — `visibleWindow()` read the chart's dataZoom
  `startValue`/`endValue` with only an `!= null` check, which let a stray
  zoom/pan gesture on an axis with no data extent yet (right after mount,
  before the first load resolves) hand back `NaN` — and since the live
  tick's `setWindow(Date.now() - width, Date.now())` reuses the previous
  window's width, one `NaN` self-perpetuates forever. Fixed by requiring
  `Number.isFinite` in `visibleWindow()`/`setWindow()`, treating a
  corrupted zoom state as "no window yet" instead of a real `[NaN, x]`
  range.

## PV history beyond 48h: cloud day-trend, not just a daily average (2026-09-20, user reports)

- User: 30d zoom on Power Production only showed data from the last ~2
  days. Confirmed via `/api/timeseries`: PV goes null before the exact
  48h `RETENTION_MS` cutoff (`server/db.js`) for `battery_snapshots` —
  unlike Grid, PV had no fallback at all once local samples age out,
  because the cloud has no PV channel *for the week/month/year rollup*
  endpoints (existing note, still true for those).
- First fix: a `pv_daily`-based flat daily-average post-pass in
  `/api/timeseries` (`produced_kWh × 1000 / 24` for any bucket still null
  after the normal passes) — `pv_daily` is already kept forever (unlike
  `battery_snapshots`) and backs the Dashboard/ROI/top-days.
- **User pushed back with real evidence**: "in the Anker app I can see the
  whole production back to 13.09 and it looks accurate enough" — a fair
  challenge, since a flat line is a coarser answer than what the user
  could already see elsewhere. Went looking for a better source rather
  than defending the flat average, and found one already half-built:
  `cloud_pv_history` (site-level `solar_production` energy_analysis, see
  the 2026-09-16 entry above) is backfilled 30 days by
  `catchUpBatteryPvHistory()` on every startup, and — checked directly
  against the local db — already holds a REAL 20-min production curve
  (2026-09-13 shows a proper day/night shape peaking ~504 W at 14:00, not
  a placeholder). It just wasn't wired into `/api/timeseries`.
  Added it as **Source 2b**, mirroring the exact pattern already proven
  for Grid's/Battery's cloud day-trend anchors in the same route (only
  fills buckets local samples haven't reached, skips still-open 20-min
  intervals, lets the existing anchor-interpolation pass connect the
  points). The `pv_daily` flat-average post-pass stays as a last-resort
  fallback for anything even the cloud history doesn't cover (older than
  `BACKFILL_DAYS` (30), or a day the backfill loop broke off on after a
  rate limit).
- **Retention clarification (user question)**: `BACKFILL_DAYS` is only how
  far the *startup catch-up* looks back to fill gaps — `cloud_history`/
  `cloud_pv_history`/`pv_daily` themselves have NO prune/delete logic at
  all (only `snapshots`/`battery_snapshots`/`cloud_grid_snapshots` get
  pruned, all on the 48h `RETENTION_MS`). Confirmed the live account's
  `cloud_pv_history` already holds 34 days (back to 2026-08-17), more
  than `BACKFILL_DAYS` — it just accumulates one more day at a time via
  `syncCloudHistory`'s ongoing today+yesterday refresh, forever.
- User also proposed a one-time full wipe-and-repopulate of the db from
  the cloud; talked through it instead of doing it — the gap-only catch-up
  already self-heals on every restart without needing one, and a full
  repopulate would both discard higher-fidelity local raw samples in
  favor of the cloud's coarser 20-min average AND risk repeating the
  2026-09-16 rate-limit trip (bursting requests instead of the existing
  6s-spaced, gap-only backfill).

## ROI BOM: real product photos + planned electrical protection (2026-09-20, user requests)

- Replaced the eBay Solarbank 4 E5000 bundle's placeholder photo (a broken
  scrape — an unrelated red logo, not the product) with the real photo,
  added one for the Power Dock entry added the same session, and fixed
  the true root cause of why the swap wasn't visible: `/api/roi/image/
  :asin` served every photo with `Cache-Control: public,
  max-age=31536000, immutable` — correct for a URL that never changes
  content, wrong here since these files DO get replaced in place with no
  content hash to bust the cache. A browser that had already fetched the
  broken image would never even revalidate for a year. Dropped
  `immutable`, cut `max-age` to 1h; `res.sendFile`'s default ETag/
  Last-Modified still makes a routine revalidation a cheap 304.
- Added two more `extended`/planned-list entries (excluded from ROI cost,
  per user confirmation these aren't part of the installed single-phase
  system): ABB S203-C32 3-pole breaker (400V/32A/6kA, €39.90) and ABB
  F204 A-40/0.03-L 4-pole Type A RCD (400V/40A/30mA, €30.39) — three-phase
  protection ahead of a possible future Power Dock/Multisystem upgrade.

## house_priority discharge-floor hysteresis + PV passthrough at the floor (2026-09-21, user-caught before production)

- User walked through `dischargeToTarget()`'s code with me and asked: since
  the floor check was a bare `soc <= effectiveFloor` threshold with no
  hysteresis, could this yoyo the same way the (already-fixed)
  `battery_priority` ceiling once did? Yes — confirmed it's the identical
  failure mode as the 2026-09-17 `CHARGE_RESUME_HYSTERESIS_PCT` incident
  (unit's own standby/BMS draw, or a brief PV dip, ticks SOC back and forth
  across a bare threshold), just never fixed on the discharge-floor side.
  Traced it through rather than assuming; user then proposed the fix
  approach and asked to also decide time-based vs. percentage-based for
  the resume wait — went with percentage (`DISCHARGE_RESUME_HYSTERESIS_PCT`,
  default 3, mirrors `CHARGE_RESUME_HYSTERESIS_PCT` exactly): a timer
  either resumes too early on a cloudy day (SOC barely recovered) or holds
  too long on a sunny one, where percentage directly encodes "meaningfully
  recovered."
- Second, related fix surfaced during the walkthrough: at the floor,
  `dischargeToTarget()` returned a hard `0` — but that `0` is the
  Solarbank's single inverter-output preset, sourced from EITHER PV or
  cells by the device itself, so it was blocking legitimate free PV
  pass-through too (forcing 100% grid draw even when PV alone could
  already cover some or all of demand without ever touching the battery).
  Floor mode now returns `passthroughOnly(args)` instead — capped at
  current PV, so it can never pull from cells, but still uses PV when
  available.
- Implementation (`server/power-plan.js`): `dischargeToTarget()` now takes
  the whole `args` object (needs `pvW` for the passthrough call, which it
  didn't receive before) and latches `this.holdingAtFloor` exactly like
  `computeBatteryPriority()` already latches `this.holdingAtCeiling` — set
  on `soc <= effectiveFloor`, cleared only once `soc >= effectiveFloor +
  DISCHARGE_RESUME_HYSTERESIS_PCT`. Both `holdingAtCeiling` and
  `holdingAtFloor` are transient (not persisted across restarts), same as
  the existing ceiling latch. Surfaced `holdingAtFloor`/
  `dischargeResumeHysteresisPct` in `lastDecision` for parity with the
  ceiling fields, though no UI was built around it (not asked for).
- Verified with a standalone dry run (no live hardware touched — this
  writes real commands to the real battery, so trace-tested the pure
  function instead): fed `dischargeToTarget()` a SOC sequence wobbling
  12→14→12→13 across the old bare boundary (floor 10%, tolerance 3% ->
  effectiveFloor 13%) with pvW=50 — confirmed it stays latched at
  target=50 (passthrough) the whole time instead of flipping to
  target=400 on every uptick, then correctly resumes full discharge only
  once SOC actually reaches 16% (effectiveFloor + 3), and correctly
  re-latches on a real subsequent decline back to 13%.

## Graph tab: robust axis cap for rare spikes (2026-09-21, user report + best-practices research)

- User screenshot: Home Power Usage at 1h zoom, a brief transient spike to
  ~2500 W stretched the y-axis so far that the normal ~200-800 W variation
  got squashed into a thin band near the bottom — "does not look ok,"
  asked to research outlier best practices rather than just guess.
  Searched (see chat) — the applicable technique for a live monitoring
  line/area chart (not a static analytical one, where you'd remove/smooth
  data) is **visual trimming with markers**: cap the axis at a robust
  (not raw-max) bound and flag that a point exceeds it, rather than a log
  scale (breaks the stacked-area metaphor entirely, and doesn't handle
  Battery's signed data) or dual axis (an explicit anti-pattern).
- `robustCap()` (`web/src/graph/GraphTab.jsx`): 98th percentile of the
  window's per-graph "envelope" series (`home` for Home Power Usage, `pv`
  for Power Production, `battCells`/`-battChgNeg` independently for
  Battery's signed sides) × 1.15 headroom, rounded up to the nearest 50 W.
  Self-correcting by construction — a genuine sustained peak (many points
  near it) barely moves the 98th percentile vs. the true max, so ordinary
  windows are untouched (`robustCap` returns `null`, axis stays on
  ECharts' default auto-scale from the earlier zero-floor fix); only a
  narrow 1-2-point transient gets excluded from the percentile and thus
  capped.
  Computed in `applyRows()` (needs the raw row array for the percentile,
  unlike the axis `min`/`max` callbacks used before, which only ever see
  `{min, max}`) and applied via `chart.setOption({yAxis: {max, min}})` —
  must always pass both explicitly (`null` when no outlier) since a
  merge-style `setOption` leaves a previously-set bound in place if the
  key is simply omitted on a later call.
  The clipped-off value isn't lost: a new `clippedArr` state renders
  "· peak 1379 W (off-scale)" next to the existing avg/resolution line
  (both high and low shown for Battery, e.g. "457 W / -691 W") whenever
  capping is active for that graph's current window — the "marker" half
  of the researched technique, so a flat-topped line reads as "there was
  a spike here" instead of looking like a rendering glitch.
- Verified live against the real backend (proxied dev server): 1h view
  reproduced the exact reported scenario (spike to 1379 W, axis capped at
  1100 W, "off-scale" note shown, normal 0-600 W variation clearly
  readable); 24h view showed several clipped spikes with the same
  flat-top-plus-note pattern; Battery's dual-sided cap confirmed correct
  with both a positive and negative outlier clipped simultaneously.

## Battery UI: multi-battery-ready vertical stack + zone labels (2026-09-21, user request)

- User: enhance the Strategy tab's battery UX, "think that it will soon
  come a second one" — display multiple batteries vertically, and check
  battery UI/UX best practices generally. Researched (see chat, two
  searches — general battery dashboards, then home-storage-specific):
  color-zone thresholds and time-remaining ETAs were already implemented
  here (this component was already fairly close to best practice, not a
  rebuild); the one gap was that SOC zones were communicated by gauge-fill
  color ALONE, no text/icon naming the zone.
- Split `BatteryTab.jsx` into `BatteryCard` (presentational, one battery —
  everything the old single-battery component rendered, now with its own
  name/SN header instead of relying on a single shared page-level stamp)
  and `BatteryTab` (fetch + map). `GET /api/battery/params` only returns
  ONE battery's `{live, config, features, constants}` today — no second
  physical battery exists to design a real multi-battery payload around
  yet. Rather than invent one speculatively, `BatteryTab` reads an
  optional `data.batteries` array first and falls back to treating the
  current single-battery response as a one-item list — so adding a real
  second device later is a backend data change only, zero frontend
  changes needed. `forceRefresh()` stays single-endpoint (no per-device
  `sn` param exists server-side) — noted as needing revisiting once a
  second device is real, not solved speculatively now.
- New `.battery-list` (flex column) stacks cards vertically — chosen over
  side-by-side because (1) each card already needs real width for its
  gauge's three threshold labels (min/floor/max) plus the collapsible
  parameter cards below, squeezing two side by side would crowd both on
  anything but a wide desktop, and (2) multi-device dashboard guidance
  favors per-device identity over density here — users check "which
  battery is doing what" one at a time, not comparing two gauges in one
  glance the way you would two KPI numbers.
- New `.batt-gauge-zone` badge: "Full"/"Low" text next to the percentage,
  shown only for the two zones actually worth calling out (near-full,
  low) — matching "status ships with an icon/label, never color alone."
  Colors match the gauge fill's own `lvl-full`/`lvl-low` gradient, so it
  reads as the same signal restated in text, not a new one.
- Verified live against the real backend: card renders its own
  "h-battery · APCN900E26200204" header, gauge/ticks/status/ETA all
  intact, "Battery information" toggle still expands/collapses correctly
  with Configuration and Status unchanged (dropped the now-redundant
  "Device" row from Status, since name/SN moved to the card header).
- **Follow-up same day: "so no beautification? I see no change"** — fair
  hit. The multi-battery-readiness PR above was structural (invisible
  with one battery at a non-extreme SOC); it didn't actually make the
  gauge look better. Went back to the loaded `dataviz` skill's own specs
  rather than eyeball it:
  - **Hero figure, ≥48px** ("the data is the only thing allowed to be
    loud") — the SOC percentage was 1.6rem (25.6px), easy to miss next to
    the surrounding chrome. Now 3rem (48px) desktop / 2.1rem (33.6px)
    phone; grew `.batt-gauge-body` 76px → 92px (60px → 76px phone) to
    give it room without cramping the kWh subtitle.
  - **Meter spec**: "the unfilled track is a lighter step of the SAME
    ramp as the fill... so state reads across the whole bar." The track
    was a flat neutral (`#101418`) regardless of level — now
    `.batt-gauge-body`/`.batt-gauge-cap` both take the `lvl-*` class too,
    tinted to a lighter step of that level's own gradient (e.g. mid/orange
    now tints the WHOLE gauge amber, not just the fill), with a matching
    tinted border. Deliberately did NOT add glow/shadow decoration on top
    — the skill's framing is "quiet, considered... a few fixed specs," so
    the fix is making the data (number, fill-vs-track) louder, not adding
    ornamental effects around it.
  - Verified live: at 40% (`lvl-mid`), the gauge is now unmistakably
    tinted amber end-to-end with a genuinely hero-scaled "40 %", vs. the
    previous flat-dark-track-plus-small-number look; details panel and
    tick labels below unaffected.

## Grid target 100→25 W + lag-deviation metrics on the Dashboard (2026-09-21, user request)

- User: "reduce ... the amount which I get from the grid to 25W" under
  house_priority, and — because the device/cloud lags real demand changes —
  measure how much is ACTUALLY sent to the grid when demand drops (preset
  briefly too high) and how far the grid import deviates above the target
  when demand rises (preset briefly too low), "put it in the dashboards."
- `GRID_TARGET_W` default 100 → 25 (`server/power-plan.js`), now
  `export`ed so the stats side uses the exact same number the controller
  aims for rather than a second env read. Also affects battery_priority's
  hold-phase ceiling (`demandW - GRID_TARGET_W`), same constant by design.
  `.env.example` updated (`GRID_TARGET_W=25`; also fixed the stale
  `DISCHARGE_TOLERANCE_PCT=4` → 3, matching the code since 2026-09-19).
- New `gridTracking` block in `/api/stats/overview`
  (`gridTrackingForWindow()`, `server/stats.js`): the route's existing
  `today.exportKwh` comes from 30-min bucket AVERAGES, which dilute or
  outright cancel the seconds-to-minutes lag spikes this feature is about
  — so these metrics integrate the RAW ~5 s local samples
  (`getSnapshotRows`, signed `grid_total`) with `cloud_grid_snapshots`
  rows as the meter-down fallback, cloud rows filtered to minutes with no
  local sample so the merge never double-counts. Same trapezoid + >30 min
  gap-skip policy as everywhere else. Per window: `exportKwh`/
  `exportPeakW` (trapezoid/peak of `max(0, -gridW)`) and `overTargetKwh`/
  `overTargetPeakW` (same for `max(0, gridW - GRID_TARGET_W)`), plus
  `coveragePct`. Served for today and yesterday (both fit the 48 h raw
  retention).
- Dashboard: new "Grid tracking · target ≤ N W" card
  (`web/src/dashboard/Dashboard.jsx`, `.gridtrack-*` CSS) fed by the
  existing overview poll — Today/Yesterday side by side, "exported" in the
  established PV green and "above target" in grid orange, each
  `X.XX kWh · peak NNN W`; amber `.src-gap-note` when a day's sample
  coverage < 90%. No new endpoint, no new fetch cycle.
- **Same-day follow-up: renamed to "Lag losses" (user couldn't parse the
  original wording)** — the numbers were already the two losses the user
  asked for, but "exported"/"above target" didn't read as losses. Card is
  now titled "Lag losses · target N W from grid" with a one-line caption
  ("energy misplaced while the device catches up after demand changes (~1
  min reaction lag)"); rows renamed "pushed to grid" (demand dropped
  faster than the device reacted) and "extra from grid" (import above the
  target while the device was still ramping up), each with a hover title
  spelling out that exact meaning. Display-only change, same underlying
  `gridTracking` payload.
- **Same-evening removal (user: "this is wrong — get rid of the new tile,
  leave it like this for now")**: the "Lag losses" tile (`GridTrackingCard`/
  `GridTrackPeriod` in `Dashboard.jsx` + the `.gridtrack-*` CSS) was removed
  from the Dashboard entirely — frontend only. The backend `gridTracking`
  block in `/api/stats/overview` (`gridTrackingForWindow`, stats.js) stays
  in the response, currently unused by any UI: it's the verified raw-sample
  measurement (export kWh/peak, over-target kWh/peak, coverage per today/
  yesterday) to build on whenever the lag-losses idea comes back — likely
  needing controller-attribution (only count moments where the plan was
  actively trying to hold the target) rather than the meter-truth approach
  the removed tile used, per the caveat already noted in the entry above.

## Graph outlier cap: dual threshold, not percentile-only (2026-09-22, user report)

- User: "if most of the values are about 100 and there is 1000 then that one
  is an outlier. but if most of values are 0 and there is a 100 or 200 this
  is not an outlier." Verified the bug against live 24h data:
  `robustCap()` (web/src/graph/GraphTab.jsx) capped at `p98 × 1.15`
  REGARDLESS of absolute magnitude, so a near-zero-baseline window (e.g. PV
  overnight / battery at rest) with a brief legit 150 W value produced
  `cap: 0` — the axis flattened to zero and hid real data entirely. Same
  mechanism was also over-capping normal variation on the live window
  (battCells max 499 capped at 400, charge max 691 capped at 550 — deltas
  of ~150-210 W are ordinary swings, not outliers).
- Fix: a spike is an outlier only when it beats the typical range by BOTH
  tests — `rawMax - p98 >= MIN_OUTLIER_DELTA_W` (300 W, deliberately above
  the user's "100 or 200 over 0" case) AND `rawMax >= p98 ×
  MIN_OUTLIER_RATIO` (2, so e.g. a 900 W peak over a 500 W baseline —
  normal house variation — stays uncapped). Cap itself gets a 50 W floor
  for the p98≈0 outlier case. Verified against the live 24h window (home's
  real 2054 W spike still capped at 1150, everything else null) and the
  exact synthetic cases from the original 2026-09-21 incident plus the
  user's two examples; browser-verified on the dev stack that all three
  graphs auto-scale normally with no clipping.

## Battery at 5% — diagnosed, not our bug (2026-09-22, user report)

- User: "I see the battery at 5% — it should not get there." Investigation
  (no code change): the account's discharge lower limit, read live from
  `get_power_cutoff`, is **5%** — it was 10% in September (gauge showed
  "min 10%", effective floor 13-14%). This app has NO write path for that
  setting (`set_power_cutoff` is never called), so the change came from
  the Anker app side. The controller followed its rules exactly: effective
  floor 5+3=8%, last preset write 20:16 (target 0), and the production
  24h timeseries confirms ZERO battery output 21:00→07:00. The final
  8%→5% overnight was the unit's own standby draw (~4.7 W average over
  ~10 h = 3% of 1.6 kWh — the known housekeeping consumption, can't be
  prevented by any preset), bottoming at the device's 5% floor. Community
  reference (thomluther/anker-solix-api api.py `get_power_cutoff`/
  `set_power_cutoff`): top-level `discharge_lower_limit` is the real
  SB2 SOC limit (writable range 5-20), distinct from the legacy
  `power_cutoff_data[]` profiles; `charge_upper_limit` range 80-100.
  Options offered to the user: set the cutoff back to 10% in the Anker
  app (picked up within the 6h cache / on restart), or raise
  `DISCHARGE_TOLERANCE_PCT` as an app-side margin.

## Export watchdog + reverse-direction settling guards (2026-09-22, user request)

- User: "I don't want to push power into the grid — make sure the ramp-down
  happens fast if I start exporting; check the algorithm, how does it work,
  is it efficient?" Answer was NO, and the closed-loop simulation (real
  `PowerPlanController` class, fake `Date.now`, device model with 60 s
  apply lag + 30 s cloud-reporting lag, mirroring production's
  `refreshHomeConsumption` formula incl. the median-of-3 despike) showed
  something worse than "slow": the old loop was **structurally blind to
  export** — `refreshHomeConsumption()` clamps negative grid to 0 and adds
  the cloud-lagged `outputW`, so during export the demand estimate reads
  ~the OLD demand forever and the preset never steps down meaningfully
  (sim: 370 W continuous export after a 600→200 W demand drop, never
  corrected within 6 min — only −30 W per 5-min "refresh" write).
- **Watchdog** (`server/power-plan.js` `tick()`, fed by `index.js` passing
  `getGridLive()`'s signed `gridW` + `gridSource` into tick): when the
  METER reports grid ≤ −`EXPORT_CORRECT_MIN_W` (20 W, env-configurable),
  cut the preset by exactly the exported amount plus `GRID_TARGET_W`
  (landing grid ON the 25 W target, not at 0), written immediately with a
  tightened deadband (20 W instead of 50) and write gap (15 s instead of
  30). Meter-source ONLY: the cloud-live grid channel is
  import-minus-PV-feed-in and can never report battery overshoot as
  negative. `EXPORT_RECORRECT_MS` (60 s ≈ device apply lag) prevents
  double-counting a correction that hasn't propagated yet. Surfaced as
  `exportW`/`exportCorrection` in `lastDecision` (Strategy tab's decision
  reason shows `export correction (-NNN W)`).
- **Two symmetric settling guards the simulation caught** (both real, the
  second one pre-existing): after a step-DOWN write the demand estimate is
  INFLATED by cloud-lagged outputW (watchdog correction nearly got
  reversed by the 90 s step-up hold 10 s before the cloud caught up);
  after a step-UP write it's DEFLATED (a false immediate step-down —
  predates the watchdog). Reverse-direction changes are now suppressed for
  `SETTLE_AFTER_WRITE_MS` (120 s = 60 s apply + 30 s reporting + 2-tick
  despike margin; 90 s was caught one tick short by the sim). Export
  corrections are EXEMPT from the suppression — export always corrects
  immediately.
- Verified by the same simulation: watchdog ON corrects a 370 W export in
  one tick (t=60s), export ends at the theoretical floor (device apply
  lag, t=120s), 6.17 Wh vs 27.94 Wh-and-counting with it off; no
  oscillation in either direction; a later demand rise (200→500) still
  steps up normally after the hold. CI smoke test reproduced locally.

## house_priority = native self-consumption mode (2026-09-22, user request)

- User, after learning Anker's loop is device-local and sub-second: "I want
  the behaviour of our app to match the one of the anker app... House
  Priority should behave exactly like Anker's Self-Consumption Mode — use
  the app's setting directly if there is one, otherwise implement it like
  the app does. Battery priority stays as-is; when the battery is full,
  continue like house priority WITHOUT emptying the battery."
- **There IS a direct setting** (community-verified, thomluther/
  anker-solix-api `SolarbankUsageMode` — "verified by mode switching"): the
  SB2 schedule payload we already write (param_type 6, cmd 17) carries
  `mode_type`: **1 = smartmeter = "AC output based on measured smart meter
  power" = the Anker app's Self-Consumption Mode** (no rate plan needed);
  3 = manual preset (what we wrote before); 5/7/8 = TOU / AI-EMS /
  dynamic-tariff. The account's own originalRaw snapshot shows the same
  payload shape (mode_type next to custom_rate_plan/ai_ems/dynamic_price).
- **Implementation** (`power-plan.js` tick()): house_priority + auto
  trigger now takes a native branch — writes `{...schedule, mode_type: 1}`
  ONCE (re-verified every REFRESH_MS=5 min in case the mode is changed in
  the Anker app), then only monitors. No preset writes, no export watchdog
  (zero export is enforced on-device, sub-second), no GRID_TARGET_W / floor
  margin (the device's own Anker-app SOC cutoffs apply instead). The manual
  discharge trigger is preset-based by nature and bypasses the native
  branch; battery_priority is unchanged (charge at preset 0 → ceiling →
  hold-phase PV-only hill-climb, never touches the cells = "continue like
  house priority without emptying the battery").
- **Transitions**: entering the preset path from native mode forces a fresh
  schedule read + unconditional write (lastWrittenPower null'd — in mode 1
  the custom-rate-plan value is dormant, so reconcileWrittenPower() now
  skips mode_type 1 payloads). After every preset write the template cache
  is updated to the written body — the sim caught that a stale cached
  template made switching BACK to house_priority silently skip the mode-1
  write (device left in mode 3) before this fix.
- **Strategy tab**: House priority copy + help modal rewritten (native
  mode, fastest possible reaction, Anker-app SOC limits apply); the
  decision card shows "Native self-consumption active" with live numbers
  (mirrors the anker_app card) when `lastDecision.nativeMode` is set; the
  manual toggle's description no longer claims "same as House priority"
  (it's the preset path with the grid target); the battery gauge's floor
  margin tick is suppressed in native mode (StrategyTab passes
  dischargeTolerancePct=0 → floor = the device's own cutoff; BatteryTab
  skips the second tick when it equals the min tick).
- **Verified by simulation** (stateful mock device, real controller class):
  mode-1 write happens exactly once on entry, zero writes in steady state,
  battery_priority switch writes mode 3 + preset 0, switching back writes
  mode 1 again; lastWrittenPower never reconciled from a dormant plan. The
  export-watchdog sim was re-pointed at the preset path via the manual
  trigger (house_priority no longer has one) and reproduces yesterday's
  results exactly (6.17 Wh, ends at apply-lag floor, no oscillation).
- Live note: production was running strategy `anker_app` at the time — no
  behavior change until the user picks House priority there again.

## Live tab: WebSocket push instead of 5 s polling (2026-09-22, user request)

- User: "make sure the UI/UX is like in the Anker app when it comes to
  displaying the current status — should be faster." The Anker app's live
  view is MQTT-push at ~3-5 s; our Live tab POLLED /api/live + /api/flow
  every 5 s, adding up to 5 s of pure UI latency on top of every reading.
- The server already had a WS broadcast (`/ws`) — but it sent raw meter
  poller state to ZERO consumers (nothing in web/src ever connected).
  Redefined the message: `{type:"live", meter: getLiveState(), flow:
  await computeFlowPayload()}` — same payloads as /api/live and /api/flow
  (both extracted into shared functions: `getLiveState()` includes the
  modbus-down cloud fallback; `computeFlowPayload()` is the /api/flow
  handler body verbatim, now also calling `refreshHomeConsumption()` so
  pushed Home values are as fresh as the triggering sample). Pushed on:
  every meter snapshot (5 s Modbus; 20 s in dev's MODBUS_TRANSIENT mode),
  every MQTT battery message (~3-5 s), and every 10 s scen_info REST sync
  — battery-triggered pushes throttled to >= 2 s. On connect, a full live
  message is sent immediately.
- `LiveTab.jsx`: WS subscription replaces the 5 s fast poll; initial REST
  fetch for instant paint; 30 s REST safety-net poll while the WS is down;
  reconnect with 2 s→30 s exponential backoff. Dev mode connects DIRECTLY
  to `ws://localhost:3001/ws` (never through the Vite proxy — the EPIPE
  noise rule already documented above finally gets its real consumer).
  Health (10 s) and today's profile (60 s) stay on their own REST polls.
- Verified: node WS client against the dev stack saw pushes at MQTT/REST
  cadence (3.8-10 s gaps) with the correct payload shape and real values;
  headless-Chrome screenshot of the Live tab rendering entirely from
  WS-delivered data (flow diagram, tiles, ETA). In production (5 s meter +
  3-5 s MQTT) updates land every ~2-5 s.

## Meter poll 5 s → 2 s (2026-09-22, user report)

- User after the WS-push deploy: "the UI is still 5 second interval
  updated... I want the same speed like the Anker app." Verified first,
  not assumed: production WAS already pushing `{type:"live"}` over /ws
  (measured gaps 2.7-10 s — meter + MQTT/REST battery triggers), and the
  served bundle DOES contain the WS code (grep `wss` — the asset-hash
  difference vs a local build is just minifier/version noise, NOT a stale
  bundle; initial suspicion disproven). The remaining 5 s cadence was the
  DATA itself: `POLL_INTERVAL_MS` defaulted to 5000 in index.js, so the
  meter values physically couldn't change faster. Anker's own live chain
  is ~1-2 s. Default lowered to 2000 ms (registers update ~1 s; 3 batch
  reads every 2 s is trivial for LAN Modbus TCP; snapshots table doubles
  to ~86k rows/48 h — nothing for SQLite). Env var still overrides; the
  MODBUS_TRANSIENT dev coexistence setup (20000 ms) is unaffected.

## Grid display deadband on the Live tab (2026-09-22, user report)

- User: "in my app it is almost always shown that we push power into the
  grid, and on the Anker app it's the opposite." Investigated with data
  before touching anything: live same-second comparison of our meter vs
  the cloud channels the Anker app displays (grid import 0=0, home
  310-314 vs 305-313 W, PV identical 846 W), today's totals (ours
  2.45 kWh import / 0.02 export vs Anker's own cloud totals 2.44 / 0.00 —
  within 0.4%), and a 24h negative-grid analysis: our meter reads
  negative in 11% of the day, ALL of it daylight hours (24% of sunny
  buckets), median just −9 W, worst −85 W, never at night; Anker's own
  cloud trend shows the same class (−7…−11 W, 4% of 20-min points).
  Conclusion: the small export is REAL physics (the Solarbank's
  zero-export regulation oscillates a few watts around zero when PV ≈
  demand), and the difference is PRESENTATION — Anker's app smooths that
  band to "0 W", we lit a visible export arc for every flicker.
- Fix (DISPLAY-ONLY, `web/src/live/LiveTab.jsx` +
  `FlowDiagram.jsx`): `GRID_DISPLAY_DEADBAND_W = 20` — |grid| ≤ 20 W
  shows as "Grid balanced · 0 W" on the tile and "0 W" with no export arc
  in the flow diagram (FlowDiagram's label logic also gained a real "0 W"
  case so a deadbanded zero never renders "−0 W"). Graphs, stats, the
  flip-side mini chart, and the controller's export watchdog keep the RAW
  signed value — real sustained export (> 20 W) still shows everywhere.
- Verified in a browser on the dev stack: with the meter flickering
  around zero at the time, the tile read "Grid balanced · 0 W" and the
  diagram showed Grid 0 W — the Anker-style presentation.

## Shared useLiveStream hook + Strategy-tab battery gauge goes live (2026-09-22, user request)

- User: "does the backend pull the values live? can we have them fast in
  the UI too?" Verified production first: pushes were already arriving at
  2.05 s (the 2 s meter poll, confirming that deploy) — the Live tab was
  fast; what still polled at 10 s was the OTHER current-status surface,
  the Strategy tab's battery gauge (`/api/battery/params`).
- New `web/src/useLiveStream.js`: shared singleton WS subscription — one
  connection fanned out to N subscribers (LiveTab + BatteryTab never open
  two sockets), lazy connect on first subscriber, disconnect when the
  last unmounts (the server skips building payloads with zero clients),
  2 s→30 s reconnect backoff. LiveTab's inline WS code was replaced by
  the hook (behavior unchanged: initial REST fetch + 30 s safety poll).
- `BatteryTab.jsx`: merges each pushed `flow.battery` into its polled
  `{live, config, features, constants}` state (soc/outputW/chargeW/pvW/
  pv1W/pv2W/cellsW/gridToBatteryW/ts; `storedKwh` recomputed from the
  pushed soc so the kWh subtitle can't disagree with the %). The 10 s
  REST poll stays for the slow-moving config/features/constants. The
  gauge, ETA, and the "updated" stamp now move at push cadence (2-5 s).
- Verified: dev-stack WS client logged pushes with live battery values
  while a headless-Chrome screenshot of the Strategy tab showed the gauge
  mid-charge (30 %, charging 394 W, ETA, fresh stamp) matching the
  pushed payload exactly.

## Stale open tabs self-reload on version change (2026-09-22, user report)

- User after the WS push + 2 s meter poll: "the UI still gets values once
  at 5 seconds." Investigation showed the server was NOT the problem:
  production was pushing at ~2 s (measured gaps 2050/3151/... ms) and
  serving the v1.5.41 bundle with the WS code inside, `max-age=0` on both
  index.html and assets, no service worker, and NO 5 s timer left anywhere
  in the frontend (grepped). Exactly-5-second updates = the OLD bundle's
  poll loop → the user's tab was opened before the deploy; an open tab
  never re-fetches index.html on its own, so it ran the pre-push code
  indefinitely.
- Fix (durable, not "tell the user to hard-refresh"): `APP_VERSION` (root
  package.json, read once at startup) is piggybacked as `v` on every WS
  live push; `useLiveStream.js` compares it against the bundle's baked-in
  `__APP_VERSION__` and reloads the page ONCE on mismatch (sessionStorage
  guard against reload loops — e.g. the brief dev window where a version
  bump hasn't rebuilt dist yet). Every tab benefits, since all live
  surfaces share the hook. Verified: push carries `v` and smoke test
  passes.
- Note for debugging future "UI is stale" reports: check the served
  bundle's embedded version (`curl -s .../assets/index-*.js | grep -o
  "1\\.5\\.[0-9]*"`) against root package.json — they differ exactly when
  the deploy is partial or the tab predates it (the latter now self-heals).

## HOTFIX: v1.5.42 crashed on boot in Docker — production down (2026-09-22)

- User: "nothing is served on 3001." Root cause: the version-stamp change
  read the ROOT package.json at startup (`readFileSync(new
  URL("../package.json", import.meta.url))` in index.js) — but the
  Dockerfile's RUNTIME stage only copies `server/` + `web/dist` (only the
  WEBBUILD stage had the root package.json, for vite). Every local/CI
  smoke test passes because the repo layout always has it; only the
  Docker layout doesn't. Reproduced exactly without Docker: old code in a
  server/+web/dist-only layout crashes `ENOENT .../package.json` on boot.
- Fix, two layers (defense in depth): (1) the read is now try/catch
  guarded with an "unknown" fallback — a cosmetic version string must
  never be able to take the server down; (2) the Dockerfile runtime stage
  now also `COPY package.json /app/package.json` so the real version
  ships (the tab self-reload feature needs the true value).
- **Standing lesson / known gap**: the CI smoke test (and local smoke
  runs) exercise the REPO layout, not the Docker runtime layout — a
  startup crash that only happens in the image layout sails through CI.
  If CI ever gains a `docker build` step, this class is covered; until
  then, any new startup-time file read must be checked against the
  Dockerfile's runtime COPY list.

## Sub-second meter cadence (2026-09-22, user request)

- User: "besides the REST API can you provide a kinda' direct socket
  connection where you can get the values faster, under a second if
  required. Check for the best practices and standards." Research
  conclusion: we're already ON the standard — WebSocket push is the
  canonical real-time dashboard transport (SSE is the one-way equivalent;
  MQTT-over-WS is what Anker itself uses internally); no change needed
  there. The only remaining latency was the meter SAMPLE rate.
- `POLL_INTERVAL_MS` default 2000 → 1000 ms. Tried to measure the AE1X0's
  register freshness directly with a brief transient connection — refused:
  production holds the meter's single Modbus connection persistently (by
  design after the .env fix). So: 1 s is the floor based on typical ~1 s
  register freshness; POLL_INTERVAL_MS=500 remains as an env-var
  experiment, but below ~1 s you mostly re-read the same value. The
  battery side is hard-limited by the device's own MQTT reporting
  (~3-5 s) — no faster channel exists for third parties (the direct
  10004-class control/telemetry path is blocked, per earlier findings).
- Net effect: grid values reach the UI ~1-1.2 s after physical change;
  battery values ~3-5 s (Anker's own cadence). DB cost of 1 s sampling:
  ~173k snapshot rows/48 h ≈ 4 MB — negligible per the same day's DB
  sizing analysis.

## How the Anker app is fast + scen_info 3 s fast path (2026-09-22, user report)

- User: "the Anker app is much faster and has other values; our UI is
  delayed a few seconds and intermediate steps are missing — figure out
  how the Anker app uses the Anker backend." Investigation:
  1. The MQTT realtime trigger (0057) has NO interval field (community
     CMD_REALTIME_TRIGGER: on/off + timeout only) — device telemetry
     (0405) is fixed at ~3-5 s for the battery, ~5 s for the meter's own
     MQTT (AE1X0 map: grid_power_signed etc.). Nobody gets faster data
     over MQTT, including the Anker app.
  2. **Anker's MQTT broker was stalled AGAIN** (the 2026-09-11 pattern):
     production battery readings were arriving only at the 10 s REST
     cadence; a dev instance with MQTT_DEBUG=1 confirmed connack/suback
     fine but ZERO messages routed (watchdog forcing 120 s reconnect
     loops), while the user's Anker app updated happily — so the app's
     live view does NOT depend on that MQTT stream: **it polls
     get_scen_info every few seconds while the screen is open.**
- Fix (index.js): `syncBatteryThrottled()` + a 1 s ticker that syncs every
  ~3 s whenever at least one WS client is connected (a UI is actually
  watching — zero cost when closed), deduped against the unconditional
  10 s baseline loop. ~20 req/min on that endpoint — above the
  ~10-12/min guideline, same on-demand precedent as the modbus-down 3 s
  sync (failures just log), and exactly the traffic pattern the Anker app
  itself generates. This also self-heals the MQTT stall case: when the
  broker routes nothing, the UI still gets 3 s data.
- `/api/health` gained `batteryMqtt: {connected, fresh, lastDataAt}` —
  `fresh=false` with `connected=true` is the stall signature; checkable
  from outside without touching the account.
- Verified live on the dev stack: with a WS client connected, distinct
  battery readings every ~3 s (REST ts advancing 3 s per reading, live
  values changing); health reports batteryMqtt connected-but-not-fresh
  during the stall. Note MQTT may silently resume later (both channels
  write into the same latestBattery — harmless).
