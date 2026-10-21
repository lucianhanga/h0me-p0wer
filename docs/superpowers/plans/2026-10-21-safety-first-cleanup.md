# Safety-First Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove proven duplication and stale/dead configuration through small generic helpers while preserving current behavior exactly.

**Architecture:** Three small PRs: frontend controls, server route/calculation helpers, and operations/docs. Every extraction keeps specialized call-site wrappers and avoids high-risk chart-window, interpolation, trapezoid, server-index, poller, and Anker-auth refactors.

**Tech Stack:** Node 22 ESM, React 19, Vite 8, Apache ECharts, SQLite (`node:sqlite`), Express, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-21-safety-first-cleanup-design.md`

## Global Constraints

- No dependency additions.
- No API response-shape changes.
- No UI behavior changes beyond dead-code removal.
- Do not modify `/api/timeseries` interpolation, trapezoid policies, chart-window controllers, server pollers, `server/index.js` structure, or Anker login dedupe.
- Every PR bumps root/server/web `package.json` patch version and appends `docs/agent-log.md`.
- Verify with build, syntax checks, dry-run assertions, fixed-parameter API diffs, browser flows, `git diff --check`, and green CI.
- Production remains the user's own deploy command; never deploy from the dev machine.

---

### Task 1: PR 1 — Frontend generic controls and dead frontend cleanup

**Files:**
- Create: `web/src/components/chartTheme.js`
- Create: `web/src/components/SpanButtons.jsx`
- Create: `web/src/components/usePeriodSwipe.js`
- Create: `web/src/components/PeriodNavTitle.jsx`
- Create: `web/src/graph/forwardHold.js`
- Create: `web/src/graph/mergeRowsByT.js`
- Modify: `web/src/graph/GraphTab.jsx`
- Modify: `web/src/simple/SimpleCharts.jsx`
- Modify: `web/src/plugs/PlugsTab.jsx`
- Modify: `web/src/components/ConsumersPeriodCard.jsx`
- Modify: `web/src/dashboard/Dashboard.jsx`
- Modify: `web/src/dashboard/BackBars.jsx`
- Modify: `web/src/live/TodayMiniChart.jsx`
- Modify: `web/src/roi/RoiTab.jsx`
- Modify: `web/src/usePolledResource.js`
- Modify: `web/src/i18n/{en,de,ro}.js`
- Modify: `web/package.json`
- Modify: `docs/superpowers/{specs,plans}/2026-10-21-safety-first-cleanup*.md`
- Modify: `docs/agent-log.md`, root/server/web package manifests

**Interfaces:**
- Produces:
  - `CHART_COLORS = { tooltipBg: "#1a2128", border: "#2a3238", text: "#e8ecef", muted: "#8b98a5", split: "#2a323866" }`
  - `SpanButtons({ active, onSelect, t })`
  - `usePeriodSwipe(go)` returning `{ onTouchStart, onTouchEnd }`
  - `PeriodNavTitle({ label, onOlder, onNewer, olderDisabled, newerDisabled, t })`
  - `forwardHoldBridge(data, maxGapMs)` for `[t, value][]`
  - `mergeRowsByT(existingRows, appendedRows, cutoffMs, getT)`

- [ ] **Step 1: Write the failing helper dry-run**

Create `/tmp/h0me-cleanup-frontend-test.mjs`:

```js
import assert from "node:assert/strict";
import { forwardHoldBridge } from "/repo/web/src/graph/forwardHold.js";
import { mergeRowsByT } from "/repo/web/src/graph/mergeRowsByT.js";

assert.deepEqual(
  forwardHoldBridge([[0, 10], [50, null], [100, null], [200, null]], 100),
  [[0, 10], [50, 10], [100, 10], [200, null]],
);
assert.deepEqual(
  mergeRowsByT([[0, "a"], [50, "b"]], [[50, "B"], [75, "c"]], 0, (r) => r[0]),
  [[0, "a"], [50, "B"], [75, "c"]],
);
```

Run it. Expected: module-not-found for both helpers.

- [ ] **Step 2: Implement helpers and shared controls**

Create the six helper files with the exact interfaces above. Keep implementation behavior copied from the current duplicate code, not redesigned:

- `forwardHoldBridge`: track `lastT/lastV`; fill nulls only when `t - lastT <= maxGapMs`.
- `mergeRowsByT`: merge into `Map`, overwrite old keys with appended rows, sort ascending by timestamp.
- `SpanButtons`: map `SHORTCUTS` from `web/src/graph/GraphTab.jsx`; preserve `span-active` behavior.
- `usePeriodSwipe`: preserve button guard, 50 px threshold, 1.5× horizontal dominance, left=older/right=newer via `go(1)`/`go(-1)`.
- `PeriodNavTitle`: preserve existing `tile-title src-title`, `src-nav`, disabled states, and aria labels.

- [ ] **Step 3: Replace duplicate chart literals and controls**

Use `CHART_COLORS` for repeated tooltip/axis colors in the modified chart files. Use `SpanButtons` in `GraphTab.jsx` and `PlugsTab.jsx`, keeping GraphTab's extra expected/phases/reset buttons as siblings and PlugsTab's `stopPropagation` wrapper. Use `usePeriodSwipe` and `PeriodNavTitle` in `Dashboard.jsx` and `ConsumersPeriodCard.jsx`. Use `forwardHoldBridge` for module series and plug charts. Use `mergeRowsByT` for both live append paths.

- [ ] **Step 4: Remove verified dead frontend code**

Remove the unused `envelope` option and branch from `usePolledResource.js` after:

```bash
grep -R "envelope" web/src
```

shows only the hook. Remove these i18n keys from all three language files:

```text
common.error, common.live,
header.voiceCommand, header.voiceUnsupported,
battery.gauge.minTip, battery.gauge.floorTip, battery.gauge.maxTip,
battery.liveOnlyNote, dashboard.consumers.title, provider.sourceLabel,
ask.title, ask.placeholder, ask.thinking, ask.corrected
```

Remove the stale `allowScripts.esbuild` block from `web/package.json` after confirming no esbuild package exists in `web/package-lock.json`.

- [ ] **Step 5: Run focused and global verification**

```bash
node /tmp/h0me-cleanup-frontend-test.mjs
npm --prefix web run build
git diff --check
node /tmp/h0me-consume-cache-check.mjs
node /tmp/h0me-pvgis-check.mjs
```

Expected: helper assertions pass, build succeeds, simple/advanced Consume flows pass, Graph expected-face flow passes, no browser exceptions.

- [ ] **Step 6: Bump, document, commit, PR, CI, merge**

Set all package manifests to `1.5.308`. Append a frontend cleanup entry to `docs/agent-log.md`. Commit the plan/spec and code. Open PR, wait for `build-and-check`, merge with branch deletion, and return `main` to `origin/main`.

---

### Task 2: PR 2 — Server span/members/stat helpers and localDate centralization

**Files:**
- Create: `server/http-span.js`
- Create: `server/member-routes.js`
- Modify: `server/index.js`
- Modify: `server/stats.js`
- Modify: `server/roi.js`
- Modify: `server/meter-consumers.js`
- Modify: `.env.example`
- Modify: `docs/agent-log.md`, root/server/web package manifests

**Interfaces:**
- Produces:
  - `parseSpan(req, res)` returning `{ from, to }` or writing the existing 400 and returning `null`.
  - `respondMembers(res, from, to, devices)` sorting by descending `kwh` and returning `{ ok: true, data: { from, to, devices } }`.
  - `monthRowsFor(meterSns, ym)` in `stats.js`.
  - Existing canonical `localDate()` imported from `server/welcome-sources.js`.

- [ ] **Step 1: Capture fixed API fixtures before edits**

Run:

```bash
curl -fsS "http://localhost:3001/api/stats/consumers?type=day&offset=0" > /tmp/consumers-day-before.json
curl -fsS "http://localhost:3001/api/stats/consumers?type=month&offset=0" > /tmp/consumers-month-before.json
curl -fsS "http://localhost:3001/api/estimated-consumers/routers/members" > /tmp/members-estimated-before.json
curl -fsS "http://localhost:3001/api/hmip/devices" > /tmp/members-hmip-before.json
curl -fsS "http://localhost:3001/api/meter-multi/members" > /tmp/members-meter-before.json
curl -fsS "http://localhost:3001/api/plugs/group/agg-cooking/members" > /tmp/members-cooking-before.json
```

- [ ] **Step 2: Write failing parseSpan dry-run**

Create `/tmp/h0me-cleanup-server-test.mjs` asserting:

- `to` is clamped to now.
- default `from` is 24 h before `to`.
- `from >= to` writes exactly `{ ok: false, error: "from must be before to" }` with status 400.

Run it. Expected: module-not-found for `server/http-span.js`.

- [ ] **Step 3: Implement server helpers**

Implement `parseSpan` exactly from the existing seven-route preamble. Implement `respondMembers` exactly from the four aggregate-member route endings. Replace all seven span preambles and four members route endings. Keep each endpoint's specialized member lookup and kWh function unchanged.

- [ ] **Step 4: Deduplicate stats calculations and localDate**

In `server/stats.js`, add module-scope `monthRowsFor(meterSns, ym)` and use it in both duplicated places. Replace the consumer day-bars inline home-hour loop with the existing `hourlyKwhFromRows(getCloudHomeDayPower(startStr, endStr))`.

Import `localDate` from `welcome-sources.js` in `server/index.js`, `server/stats.js`, and `server/roi.js`; delete their identical local definitions. Delete the unused `METER_MULTI_MEMBERS` export from `server/meter-consumers.js`. Remove the dead `BATTERY_IP` block from `.env.example`.

- [ ] **Step 5: Run API and syntax verification**

Restart the dev server, then run:

```bash
node /tmp/h0me-cleanup-server-test.mjs
node --check server/http-span.js server/member-routes.js server/index.js server/stats.js server/roi.js server/meter-consumers.js
curl -fsS "http://localhost:3001/api/stats/consumers?type=day&offset=0" > /tmp/consumers-day-after.json
curl -fsS "http://localhost:3001/api/stats/consumers?type=month&offset=0" > /tmp/consumers-month-after.json
# capture all four members endpoints as after fixtures
diff -u /tmp/consumers-day-before.json /tmp/consumers-day-after.json
diff -u /tmp/consumers-month-before.json /tmp/consumers-month-after.json
# diff all four members fixtures
npm --prefix web run build
git diff --check
```

Expected: all fixture diffs empty, syntax/build/diff checks pass.

- [ ] **Step 6: Bump, document, commit, PR, CI, merge**

Set all package manifests to `1.5.309`. Append a server cleanup entry to `docs/agent-log.md`. Commit, PR, wait for green CI, merge with branch deletion, and fast-forward `main`.

---

### Task 3: PR 3 — Docker healthcheck and current docs

**Files:**
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/agent-log.md`, root/server/web package manifests

**Interfaces:**
- Produces a Compose healthcheck that authenticates with the existing `API_TOKEN` environment variable and checks the real API without changing `server/auth.js`.

- [ ] **Step 1: Fix the healthcheck**

Replace `docker-compose.yml:20` with:

```yaml
test: ["CMD-SHELL", "wget -qO- --header=\"Authorization: Bearer $$API_TOKEN\" http://localhost:3001/api/health"]
```

Rationale: `$$API_TOKEN` stays a container environment variable; when no token is configured, auth deliberately fails open. This preserves token auth and fixes the current 401-based `unhealthy` status.

- [ ] **Step 2: Refresh README for the dock-era app**

Update the intro to describe the Power Dock AE100, Solarbank 4 E5000 Pro, Solarbank 2 E1600 Pro, Smart Meter Gen 2, 12×500 W PV, smart plugs, provider meter, live monitoring, history, AI briefings, ROI, and PV-aware power plan. Update the tab tour to include all current tabs: Welcome, Live, Strategy, Graph, Consume, Dashboard, ROI. Keep the existing screenshot table even though its images are separately known-stale.

- [ ] **Step 3: Refresh AGENTS.md stale facts**

Update the current-state header to 2026-10-21 / v1.5.310, change Node 20+ to Node 22+, remove the completed `wip/watch-consumers-today` note, and remove/replace the stale esbuild allow-scripts instruction with a note to inspect current lockfile packages before approving install scripts.

- [ ] **Step 4: Verify compose and docs consistency**

Run:

```bash
docker compose config --quiet
npm --prefix web run build
git diff --check
grep -n "wip/watch-consumers-today\|Node 20\|esbuild" AGENTS.md || true
grep -n "balcony setup\|The six tabs" README.md || true
```

Expected: compose config valid, build passes, stale strings gone except any deliberate historical decision-log entries.

- [ ] **Step 5: Bump, document, commit, PR, CI, merge**

Set all package manifests to `1.5.310`. Append an operations/docs entry to `docs/agent-log.md`. Commit, PR, wait for green CI, merge with branch deletion, and fast-forward `main`.

---

### Task 4: Final release audit and tag

**Files:**
- No source edits expected.

- [ ] **Step 1: Verify final repo state**

Run:

```bash
git status --short --branch
gh pr list --state open --limit 20
git branch -r --no-merged origin/main
npm run setup
npm --prefix web run build
node --check server/index.js
```

Expected: clean `main`, no open PRs, no unmerged feature branches, install/build/syntax all green.

- [ ] **Step 2: Run final browser verification**

Run:

```bash
node /tmp/h0me-consume-cache-check.mjs
node /tmp/h0me-pvgis-check.mjs
```

Expected: simple/advanced Consume and Graph flows pass with zero browser exceptions.

- [ ] **Step 3: Tag the release**

```bash
git tag -a v1.5.310 -m "Release v1.5.310"
git push origin v1.5.310
```

- [ ] **Step 4: Report**

Report the three PRs, exact verification evidence, final tag, and the user's production deploy command:

```bash
git pull --ff-only && docker compose up -d --build
```
