# h0me-p0wer

Proof-of-concept dashboard for the Anker SOLIX Smart Meter Gen 2.

- **Live data**: local Modbus TCP directly from the meter (no cloud, ~5 s updates)
- **Cloud data**: Anker EU cloud API (sites, scene info, devices, energy history)
- **Frontend**: React dashboard (live power cards, history chart, site/device info)

## Setup

```sh
cp .env.example .env   # fill in ANKER_EMAIL / ANKER_PASSWORD, adjust METER_IP
```

Enable Modbus TCP on the meter: Anker app → Smart Meter Gen 2 → Settings →
Three-Party Control Settings → Modbus TCP. The app shows the meter's local IP.

## Run

```sh
cd server && npm install && npm start     # backend on http://localhost:3001
cd web && npm install && npm run dev      # frontend on http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to the backend.

## Notes

- The backend talks Modbus TCP (port 502, input registers / FC04) to the meter
  using the register map from Anker's official Home Assistant integration.
- Cloud endpoints are unofficial (reverse-engineered from the Android app),
  rate-limited (~10–12 req/min/endpoint/IP) and may change without notice.
- The app works in "live-only" mode if cloud credentials are missing or wrong,
  and in "cloud-only" mode if the meter is unreachable — each panel shows a
  readable error instead of breaking the whole dashboard.
