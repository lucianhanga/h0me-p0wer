import { resolveConstants } from "./battery-params.js";

const MQTT_KNOWN_PN = new Set(["A17C0", "A17C1", "A17C2", "A17C3", "AE103"]);

function moduleCapacitiesKwh(members) {
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

export function storedKwhByBucket(rows, members) {
  const capacities = moduleCapacitiesKwh(members);
  const stored = new Map();
  for (const row of rows) {
    const capacity = capacities.get(row.module);
    if (capacity == null || row.soc == null) continue;
    const kwh = (row.soc / 100) * capacity;
    stored.set(row.bt, (stored.get(row.bt) ?? 0) + kwh);
  }
  return stored;
}
