# h0me-p0wer

Home-energy dashboard **and controller** for the **Anker SOLIX** balcony
setup: Smart Meter Gen 2 (AE1X0, local Modbus TCP) + Solarbank 2 E1600 Plus
battery + 2×500 W PV — live monitoring, history, AI briefings, ROI tracking,
and its own PV-aware power plan that drives the battery's output preset.

| Welcome (AI briefing) | Live (power flow) | Battery |
|---|---|---|
| ![Welcome](docs/phone-welcome.png) | ![Live](docs/phone-live.png) | ![Battery](docs/phone-battery.png) |

| Graph (history) | Dashboard (consumption by source) | ROI (payback) |
|---|---|---|
| ![Graph](docs/phone-graph.png) | ![Dashboard](docs/phone-dashboard.png) | ![ROI](docs/phone-roi.png) |

## The six tabs

- **Welcome** — an AI briefing (any OpenAI-compatible endpoint; Kimi by
  default): today's weather with a sunrise→sunset arc, week/month sun
  outlook, estimated PV production for your system, measured start-of-day vs.
  predicted end-of-day battery/house state, and savings in € at your tariff.
  Facts are gathered deterministically (Nominatim + Open-Meteo + PVGIS — all
  free and keyless — plus your local history); ONE structured AI call per
  scheduled slot (6:00–22:00 every 2 h), deterministic fallback offline.
  Per-tile text-to-speech + a voice Q&A button (STT → AI → spoken answer).
- **Live** — animated power-flow diagram (PV / grid / home / battery with the
  correct Anker split: PV→home is inverter pass-through, never
  double-counted), main tiles (house, grid, battery with charge/discharge
  symbols, PV incl. per-string PV1/PV2), per-phase details, and the
  **Power Plan** section (see below).
- **Battery** — animated SOC gauge with charge/discharge animation and the
  configured min/max limits as markers on the gauge, kWh stored, plus every
  battery parameter (limits, backup reserve, zero-export switch, per-string
  PV, error codes; device config cached 6 h to respect Anker rate limits).
- **Graph** — three focused charts (Home Power Usage / Power Production /
  Battery), each with its own span buttons (1h/6h/12h/24h/7d/30d), pan/zoom,
  resolution that follows zoom (raw 5 s samples where local data exists,
  cloud 20-min anchors + interpolation for the past), and live updates.
- **Dashboard** — consumption by source for today/week/month/year: house
  total split into grid / PV-direct / from-battery (cells only — no double
  booking), plus PV→battery stored; € spent vs saved per source; ‹ › period
  navigation into the past; flip a tile for per-day stacked bars.
- **ROI** — bill of materials with snapshotted purchase prices (clickable to
  Amazon, thumbnails, PDF download), amortization chart with measured savings
  vs. a seasonally-shaped forecast, and payback/projections (1–15 y) computed
  from a **fixed AI-estimated baseline** (PVGIS climatology × your tariff —
  set once, recomputed only on demand) instead of noisy short-term averages.

## Power Plan (the controller)

The app can take over the battery's output preset (Anker weekly schedule,
write path verified) instead of relying on the static app schedule:

- PV = 0 → discharge `min(800 W, house demand)` until the SOC reserve
- PV > 0 → `min(floor(PV/100)×100, house demand)` — surplus trickles into the
  battery, never cycles (anti-jojo); PV above house demand charges fully
- **Evening bridge**: once the day has peaked and PV falls below 70 % of
  peak, the battery covers the sunset ramp instead of the grid
- Battery full → all PV to the house; zero export by construction (the
  device's 0 W feed-in switch stays untouched as the fast safety net)
- Writes only on meaningful changes (≥50 W, ≥30 s apart, up-steps held 3 min)
- Enable saves the existing Anker schedule; disable restores it byte-for-byte

Per instance (state file next to the DB) — run it on exactly ONE server.

## Architecture

```
                ┌─────────────┐   Modbus TCP :502 (5 s)   ┌──────────────┐
                │   Browser   │ ◄── WebSocket / REST ──── │  Node backend│
                │  (React +   │                           │  (Express)   │
                │   ECharts)  │                           │  SQLite DB   │
                └─────────────┘                           └──────┬───────┘
                              Anker EU cloud: REST (10 s battery sync,
                              15 min history) + MQTT telemetry push ▲
```

Local 5 s Modbus samples (48 h retention) + cached cloud history + battery
snapshots in SQLite (`node:sqlite`, no native deps); background-first: the
server always pulls, clients just read.

## Setup

```sh
cp .env.example .env   # ANKER_EMAIL / ANKER_PASSWORD, METER_IP,
                       # TARIFF_EUR_PER_KWH, HOME_ADDRESS, PV_*, AI_*
```

Enable Modbus TCP on the meter: Anker app → Smart Meter Gen 2 → Settings →
Three-Party Control Settings → Modbus TCP. The app shows the meter's local IP.

## Run

```sh
npm run setup   # once: install all dependencies
npm start       # builds the frontend, serves everything on http://localhost:3001
npm run dev     # dev mode: backend :3001 + Vite :5173 (hot reload)
```

Auto-start on login (macOS launchd — adjust paths in the plist first):

```sh
cp scripts/com.h0mep0wer.server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.h0mep0wer.server.plist
```

## Deploy (Docker, production)

Every merge to `main` publishes an image to
`ghcr.io/lucianhanga/h0me-p0wer:latest` (GitHub Actions → CI + Publish).

```sh
# one-time setup
mkdir h0me-p0wer && cd h0me-p0wer
curl -O https://raw.githubusercontent.com/lucianhanga/h0me-p0wer/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/lucianhanga/h0me-p0wer/main/.env.example
$EDITOR .env          # credentials + METER_IP + TARIFF_EUR_PER_KWH + AI_*
chmod 600 .env        # secrets stay only on this machine

# run / update
docker compose pull
docker compose up -d
```

The dashboard is then on `http://<server>:3001`. SQLite + the power-plan
state live in the `h0me-p0wer-data` volume and survive updates.

### Operational notes

- **The meter accepts only ONE Modbus TCP connection** — never run two
  instances against it at the same time.
- **The power plan is per-instance too** — enable it on exactly one server.
- **Cloud rate limits**: Anker aggressively rate-limits *logins* (repeated
  fresh logins lock the account for 7 minutes). The backend persists the auth
  token in `/data/.token-cache.json` and backs off automatically — avoid
  restart loops and second cloud-connected instances from the same public IP.
- **Graceful stop**: SIGTERM/SIGINT handled (Modbus released immediately).

## Notes

- The register map comes from Anker's official Home Assistant integration
  (input registers / FC04, big-endian, value = raw ÷ gain).
- Cloud endpoints are unofficial (reverse-engineered from the Android app),
  rate-limited (~10–12 req/min/endpoint/IP) and may change without notice.
- `.env`, `node_modules`, build output and the local database are git-ignored.
