// Named plug groups (2026-10-16, user request — "add together all the
// cooking, cooking2, ... into one entry, like house light"): plugs whose
// (already display-stripped) name starts with a group's prefix collapse
// into ONE aggregate consumer on every plug surface — the same treatment
// the HmIP "house light" aggregate got (hmip.js). Unlike HmIP there is no
// synthetic storage: live watts are summed at read time, the members keep
// their own plug_samples/plug_daily rows, and the read paths (stats.js
// consumers split, /api/plugs/timeseries?sn=agg-*) sum the members — so
// the aggregate has full history and never double-counts "rest of home".

export const PLUG_GROUPS = [
  { sn: "agg-cooking", name: "cooking", prefix: "cooking" },
];

export function plugGroupForName(name) {
  const n = (name ?? "").toLowerCase();
  return PLUG_GROUPS.find((g) => n.startsWith(g.prefix)) ?? null;
}

export function plugGroupForSn(sn) {
  return PLUG_GROUPS.find((g) => g.sn === sn) ?? null;
}

// Split raw plug states into { display, members }:
// - display: non-member plugs + one aggregate state per group that has at
//   least one member (same shape as hmip.js getState() — `external: true`
//   is what makes the frontend card flippable)
// - members: Map(groupSn -> member plug states), used by the members
//   endpoint and the timeseries sum
export function applyPlugGroups(plugs) {
  const members = new Map();
  const display = [];
  for (const p of plugs) {
    const g = plugGroupForName(p.name);
    if (!g) {
      display.push(p);
      continue;
    }
    if (!members.has(g.sn)) members.set(g.sn, []);
    members.get(g.sn).push(p);
  }
  for (const g of PLUG_GROUPS) {
    const ms = members.get(g.sn);
    if (!ms?.length) continue;
    display.push({
      sn: g.sn,
      name: g.name,
      tag: "Group",
      typeTag: "Aggregate",
      watts: Math.round(ms.reduce((a, m) => a + (m.watts ?? 0), 0) * 10) / 10,
      online: ms.some((m) => m.online),
      external: true,
      ts: Math.max(...ms.map((m) => m.ts ?? 0)),
      deviceCount: ms.length,
      membersUrl: `/api/plugs/group/${g.sn}/members`,
    });
  }
  return { display, members };
}
