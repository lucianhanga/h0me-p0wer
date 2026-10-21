const DEFAULT_CONSUMERS = [
  { name: "FritzPoE", count: 5, averageWatts: 10, category: "routers" },
  { name: "Netgear Orbi", count: 2, averageWatts: 20, category: "routers" },
];

function slug(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sinceMs(value, name) {
  if (value == null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`estimated consumer ${name}: since must be yyyy-MM-dd`);
  return new Date(`${value}T00:00:00`).getTime();
}

export function estimatedCategories(env = process.env) {
  const raw = env.ESTIMATED_CONSUMERS_JSON;
  let rows = DEFAULT_CONSUMERS;
  if (raw != null && raw !== "") {
    try {
      rows = JSON.parse(raw);
    } catch (err) {
      throw new Error(`ESTIMATED_CONSUMERS_JSON is not valid JSON: ${err.message}`);
    }
  }
  if (!Array.isArray(rows)) throw new Error("ESTIMATED_CONSUMERS_JSON must be an array");
  const categories = new Map();
  for (const row of rows) {
    const name = String(row?.name ?? "").trim();
    const category = String(row?.category ?? "").trim();
    const count = Number(row?.count);
    const averageWatts = Number(row?.averageWatts);
    if (!name) throw new Error("estimated consumer: name is required");
    if (!category) throw new Error(`estimated consumer ${name}: category is required`);
    if (!Number.isInteger(count) || count <= 0) throw new Error(`estimated consumer ${name}: count must be a positive integer`);
    if (!Number.isFinite(averageWatts) || averageWatts < 0) throw new Error(`estimated consumer ${name}: averageWatts must be >= 0`);
    if (!categories.has(category)) {
      const sn = `est-${slug(category)}`;
      categories.set(category, { sn, name: category, watts: 0, members: [], sinceMs: null, allMembersBounded: true });
    }
    const group = categories.get(category);
    const member = {
      sn: `${group.sn}-${slug(name)}`,
      name,
      count,
      averageWatts,
      watts: count * averageWatts,
      since: row.since ?? null,
      sinceMs: sinceMs(row.since, name),
    };
    group.members.push(member);
    group.watts += member.watts;
    if (member.sinceMs == null) group.allMembersBounded = false;
    else if (group.allMembersBounded) group.sinceMs = Math.min(group.sinceMs ?? Infinity, member.sinceMs);
  }
  for (const group of categories.values()) {
    if (!group.allMembersBounded) group.sinceMs = null;
    delete group.allMembersBounded;
  }
  return [...categories.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findEstimatedConsumer(sn, env = process.env) {
  for (const category of estimatedCategories(env)) {
    if (category.sn === sn) return category;
    const member = category.members.find((m) => m.sn === sn);
    if (member) return member;
  }
  return null;
}

export function estimatedKwhForSpan(consumer, fromMs, toMs, nowMs = Date.now()) {
  const from = Number(fromMs);
  const to = Math.min(Number(toMs), nowMs);
  if (!consumer || !Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const start = Math.max(from, consumer.sinceMs ?? from);
  if (to <= start) return 0;
  return Math.round(((consumer.watts * (to - start)) / 3600000 / 1000) * 100000) / 100000;
}

export function estimatedAvgWattsForSpan(consumer, fromMs, toMs, nowMs = Date.now()) {
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return (estimatedKwhForSpan(consumer, from, to, nowMs) * 1000 * 3600000) / (to - from);
}
