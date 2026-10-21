# Safety-First Cleanup Design

## Goal

Remove proven duplication and stale/dead configuration while preserving current behavior exactly. Create small generic controls/helpers with specialized wrappers where the audit found repeated, stable patterns.

## Approved scope

### Frontend generic controls

- Extract shared ECharts theme constants/helpers from repeated tooltip/axis literals.
- Extract span buttons, period swipe handling, period navigation title, forward-hold chart bridging, and timestamp row merging.
- Remove the dead `envelope: false` branch from `usePolledResource.js` after grep verification.
- Remove verified dead i18n keys and the stale `allowScripts.esbuild` entry.

### Server generic controls

- Extract `parseSpan` for the seven identical from/to query preambles.
- Extract a generic aggregate-members route helper; keep each endpoint's member lookup and kWh function as the specialized wrapper.
- Remove duplicated `monthRows` and reuse the existing hourly home-energy bucketer in `stats.js`.
- Centralize the identical `localDate()` implementation in `welcome-sources.js` and import it where safe.
- Remove the unused `METER_MULTI_MEMBERS` export and dead `BATTERY_IP` example.

### Operations/docs

- Fix Docker healthcheck without weakening API token auth: call `/api/health` with `Authorization: Bearer $$API_TOKEN` from docker-compose. With no token configured, auth still fails open.
- Refresh the pre-dock README intro/tab tour and stale AGENTS.md version, Node requirement, WIP, and esbuild notes.

## Explicit non-goals

Do not touch these high-risk areas in this cleanup:

- Shared chart-window controller between Graph and Consume.
- `/api/timeseries` interpolation/anchor logic.
- Trapezoid integration unification; gap policies differ intentionally.
- Broad `server/index.js` restructuring.
- Generic server poller abstraction.
- Anker login/token in-flight dedupe.

## Safety constraints

- No dependency additions.
- No API response-shape changes.
- No UI behavior changes beyond removing dead code.
- No production deploy from the development machine; production remains the user's `git pull --ff-only && docker compose up -d --build` step.
- Every PR bumps root, server, and web package patch versions and updates `docs/agent-log.md`.

## Verification model

The repo has no automated test suite. Each PR must run:

- `npm --prefix web run build`.
- `node --check` on every modified server file.
- `git diff --check`.
- Focused dry-run assertions for every new pure helper.
- Before/after JSON diffs for every modified API route with fixed parameters.
- Headless Chrome browser checks for every modified UI flow.
- Final CI on each PR, then merge and delete the branch.
