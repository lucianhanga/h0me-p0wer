import { resolveConstants } from "./battery-params.js";

const MQTT_KNOWN_PN = new Set(["A17C0", "A17C1", "A17C2", "A17C3", "AE103"]);

export function moduleCapacitiesKwh(members) {
  const capacities = new Map();
  for (const member of members) {
    if (!member?.sn) continue;
    const constants = resolveConstants(member.pn, member.expansionPacks ?? 0);
    const perModule = MQTT_KNOWN_PN.has(member.pn);
    capacities.set(member.sn, perModule ? constants.baseCapacityKwh : constants.capacityKwh);
    if (!perModule) continue;
    for (const [index, expansion] of (member.expansions ?? []).entries()) {
      capacities.set(expansion.sn ?? `${member.sn}-exp${index + 1}`, constants.expansionPackKwh);
    }
  }
  return capacities;
}

export function systemModuleCapacityKwh(members) {
  return [...moduleCapacitiesKwh(members).values()].reduce((sum, capacity) => sum + capacity, 0);
}

export function storedKwhByBucket(rows, members, initialSoc = {}) {
  const capacities = moduleCapacitiesKwh(members);
  const lastSoc = new Map(Object.entries(initialSoc));
  const stored = new Map();
  for (const row of rows) {
    if (!capacities.has(row.module)) continue;
    if (row.soc != null) lastSoc.set(row.module, row.soc);
    let total = 0;
    for (const [module, capacity] of capacities) {
      if (lastSoc.has(module)) total += (lastSoc.get(module) / 100) * capacity;
    }
    stored.set(row.bt, total);
  }
  return stored;
}
