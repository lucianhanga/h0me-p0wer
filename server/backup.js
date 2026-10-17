import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { kvGet, kvSet, logActivity } from "./db.js";

// Azure Blob backup (2026-10-17, user request): a daily consistent snapshot
// of the SQLite DB (VACUUM INTO — WAL-safe), gzipped, uploaded to an Azure
// blob container via a SAS URL, plus a GFS retention prune after each
// upload (user's scheme): 7 daily, 4 weekly, 12 monthly, 1 per year.
// AZURE_BACKUP_URL in .env holds the FULL container URL incl. the SAS token
// — a secret: never logged, never sent anywhere but blob.core.windows.net.
// Recovery: download → gunzip → staging file → SQLite sanity check → swap
// over DB_PATH → process exit, so the Docker restart policy comes back on
// the restored data (an in-process swap is meaningless — node:sqlite holds
// the open handle).

const DB_PATH =
  process.env.DB_PATH ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "data.db");
const BLOB_PREFIX = "h0me-p0wer-";
const SCHEDULE_HOUR = 3; // daily at 03:17 local
const SCHEDULE_MINUTE = 17;

function azureParts() {
  const raw = process.env.AZURE_BACKUP_URL ?? "";
  const q = raw.indexOf("?");
  if (q < 0) return null;
  return { base: raw.slice(0, q), token: raw.slice(q + 1) };
}

const blobUrl = (name) => {
  const az = azureParts();
  return `${az.base}/${name}?${az.token}`;
};

export function backupEnabled() {
  return azureParts() != null;
}

// List our backup blobs: [{name, sizeMb}].
export async function listBackups() {
  const az = azureParts();
  if (!az) return [];
  const url = `${az.base}?restype=container&comp=list&prefix=${BLOB_PREFIX}&${az.token}`;
  const xml = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`list failed: HTTP ${r.status}`);
    return r.text();
  });
  const blobs = [];
  const re = /<Name>([^<]+)<\/Name>[\s\S]*?<Content-Length>(\d+)<\/Content-Length>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1].endsWith(".db.gz")) blobs.push({ name: m[1], sizeMb: Math.round((Number(m[2]) / 1048576) * 10) / 10 });
  }
  return blobs.sort((a, b) => a.name.localeCompare(b.name));
}

// GFS retention (user's exact tiers): 7 daily · 4 weekly · 12 monthly ·
// 1 per year. Returns the keep-set of blob names.
export function retentionKeep(names, now = new Date()) {
  const keep = new Set();
  for (const [n, tier] of retentionTiers(names, now)) if (tier != null) keep.add(n);
  return keep;
}

// Same GFS split, but per-blob for the UI: Map(name → "daily" | "weekly" |
// "monthly" | "yearly" | null) — null = next prune deletes it.
export function retentionTiers(names, now = new Date()) {
  const DAY_MS = 86400000;
  const dated = names
    .map((n) => ({ n, d: n.slice(BLOB_PREFIX.length, BLOB_PREFIX.length + 10) }))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d))
    .map((x) => ({ ...x, ts: new Date(`${x.d}T12:00:00`).getTime() }));
  const tiers = new Map(names.map((n) => [n, null]));
  const latestBy = (keyOf, candidates) => {
    const byKey = new Map();
    for (const x of candidates) {
      const k = keyOf(new Date(x.ts));
      if (!byKey.has(k) || byKey.get(k).ts < x.ts) byKey.set(k, x);
    }
    return byKey;
  };
  const isoWeek = (d) => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - yearStart) / DAY_MS + 1) / 7)).padStart(2, "0")}`;
  };
  for (const x of dated) if (now.getTime() - x.ts <= 7 * DAY_MS) tiers.set(x.n, "daily");
  const older7 = dated.filter((x) => now.getTime() - x.ts > 7 * DAY_MS);
  const weeks = [...latestBy(isoWeek, older7).entries()].sort((a, b) => b[0].localeCompare(a[0]));
  for (const [, x] of weeks.slice(0, 4)) if (tiers.get(x.n) == null) tiers.set(x.n, "weekly");
  const months = [...latestBy((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, dated).entries()]
    .sort((a, b) => b[0].localeCompare(a[0]));
  for (const [, x] of months.slice(0, 12)) if (tiers.get(x.n) == null) tiers.set(x.n, "monthly");
  for (const [, x] of latestBy((d) => String(d.getFullYear()), dated)) if (tiers.get(x.n) == null) tiers.set(x.n, "yearly");
  return tiers;
}

async function applyRetention() {
  const blobs = await listBackups();
  const keep = retentionKeep(blobs.map((b) => b.name));
  let deleted = 0;
  for (const b of blobs) {
    if (keep.has(b.name)) continue;
    const r = await fetch(blobUrl(b.name), { method: "DELETE" });
    if (r.ok || r.status === 202) deleted++;
    else console.warn(`[backup] delete ${b.name} failed: HTTP ${r.status}`);
  }
  return deleted;
}

// One backup run: snapshot → gzip → upload → prune → kv record. Returns the
// blob info; throws on failure (the caller logs/activities it).
export async function backupNow() {
  const az = azureParts();
  if (!az) throw new Error("AZURE_BACKUP_URL not configured");
  const day = new Date().toLocaleDateString("sv");
  const name = `${BLOB_PREFIX}${day}.db.gz`;
  const tmp = path.join(os.tmpdir(), `h0me-p0wer-backup-${Date.now()}.db`);
  try {
    const snap = new DatabaseSync(DB_PATH, { readOnly: true });
    snap.exec("PRAGMA busy_timeout = 30000");
    snap.exec(`VACUUM INTO '${tmp}'`);
    snap.close();
    const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 6 });
    const r = await fetch(blobUrl(name), {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/gzip" },
      body: gz,
    });
    if (r.status !== 201) throw new Error(`upload failed: HTTP ${r.status}`);
    const sizeMb = Math.round((gz.length / 1048576) * 10) / 10;
    const deleted = await applyRetention().catch((err) => {
      console.warn(`[backup] retention prune failed: ${err.message}`);
      return 0;
    });
    kvSet("azure_backup_last", { at: Date.now(), name, sizeMb, deleted });
    logActivity("backup_done", { name, sizeMb });
    return { name, sizeMb, deleted };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Restore one blob over the live DB. Validates before swapping; keeps the
// current file as data.db.pre-restore (same dir) for manual recovery. The
// process EXITS afterwards — the Docker restart policy boots the restored
// DB; locally the dev server must be restarted by hand.
export async function restoreFromBackup(name) {
  const az = azureParts();
  if (!az) throw new Error("AZURE_BACKUP_URL not configured");
  if (!/^h0me-p0wer-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(name)) {
    throw new Error("not a backup blob name");
  }
  const r = await fetch(blobUrl(name));
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  const gz = Buffer.from(await r.arrayBuffer());
  const raw = zlib.gunzipSync(gz);
  // Sanity: SQLite magic + a readable page count.
  if (raw.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") {
    throw new Error("downloaded file is not a SQLite database");
  }
  const staging = `${DB_PATH}.restore-next`;
  fs.writeFileSync(staging, raw);
  const check = new DatabaseSync(staging, { readOnly: true });
  check.prepare("PRAGMA page_count").get();
  check.close();
  const prev = `${DB_PATH}.pre-restore`;
  fs.rmSync(prev, { force: true });
  fs.renameSync(DB_PATH, prev);
  fs.renameSync(staging, DB_PATH);
  // The VACUUM'd snapshot is self-contained — any WAL/SHM left beside the
  // old file belongs to the OLD database and would be applied to the
  // restored one ("database disk image is malformed" on next boot,
  // first restore test 2026-10-17).
  fs.rmSync(`${DB_PATH}-wal`, { force: true });
  fs.rmSync(`${DB_PATH}-shm`, { force: true });
  logActivity("backup_restored", { name });
  return { name };
}

// Daily scheduler: hourly tick, fires once per day at 03:17 local.
let lastRunDay = null;
export function startBackupScheduler() {
  if (!backupEnabled()) {
    console.log("[backup] AZURE_BACKUP_URL not set — Azure backup disabled");
    return;
  }
  const tick = async () => {
    const now = new Date();
    const day = now.toLocaleDateString("sv");
    if (now.getHours() === SCHEDULE_HOUR && now.getMinutes() >= SCHEDULE_MINUTE && lastRunDay !== day) {
      lastRunDay = day; // latch first — a failed run must not retry every hour
      try {
        const { name, sizeMb } = await backupNow();
        console.log(`[backup] uploaded ${name} (${sizeMb} MB)`);
      } catch (err) {
        console.warn(`[backup] daily backup failed: ${err.message}`);
        logActivity("backup_failed", { error: err.message });
      }
    }
  };
  setInterval(tick, 3600 * 1000).unref();
  console.log(`[backup] Azure backup scheduled daily at ${String(SCHEDULE_HOUR).padStart(2, "0")}:${String(SCHEDULE_MINUTE).padStart(2, "0")}`);
}

export function lastBackupInfo() {
  return kvGet("azure_backup_last")?.value ?? null;
}
