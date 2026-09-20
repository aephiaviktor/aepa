export interface MiningProgressionInput {
  xp: {
    councilRank: { level: number };
    dailyXp: { level: number };
    pilot: { level: number };
    dataRunner: { level: number };
    mining: { level: number };
    building: { level: number };
    crafting: { level: number };
    combat: { level: number };
  };
  modifiers: {
    unlockedNodes: readonly number[];
    values: { researchTags: readonly number[]; cargoCategories: readonly number[] };
  };
}

export interface MiningResearchNodeInput {
  id: number;
  name: string;
  requiredTagIds: readonly number[];
  xpCosts: readonly { category: string; minimumLevel: number }[];
  modifier: {
    researchTags: readonly number[];
    cargoCategories: readonly number[];
    rareMineralDiscovery: readonly { cargoId: number }[];
  };
}

export interface MiningResourceEligibility {
  available: boolean;
  requirement?: string;
}

const XP_KEYS: Readonly<Record<string, string>> = {
  'council-rank': 'councilRank',
  daily: 'dailyXp',
  pilot: 'pilot',
  'data-runner': 'dataRunner',
  mining: 'mining',
  building: 'building',
  crafting: 'crafting',
  combat: 'combat',
};

function xpLevel(character: MiningProgressionInput, category: string): number {
  const key = XP_KEYS[category] as keyof MiningProgressionInput['xp'] | undefined;
  return key ? character.xp[key].level : 0;
}

function titleCaseCategory(category: string): string {
  return category.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function joinRequirements(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

export function resolveMiningResourceEligibility(
  cargoCategoryId: number,
  character: MiningProgressionInput,
  nodes: readonly MiningResearchNodeInput[],
): MiningResourceEligibility {
  if (character.modifiers.values.cargoCategories.includes(cargoCategoryId)) return { available: true };
  const gates = nodes.filter(node => node.modifier.cargoCategories.includes(cargoCategoryId));
  if (!gates.length) return { available: false, requirement: `Cargo category ${String(cargoCategoryId)} is not unlocked.` };

  const nodeByTag = new Map<number, MiningResearchNodeInput>();
  for (const node of nodes) for (const tag of node.modifier.researchTags) nodeByTag.set(tag, node);
  const gate = [...gates].sort((left, right) => {
    const leftLevel = Math.max(0, ...left.xpCosts.map(cost => cost.minimumLevel));
    const rightLevel = Math.max(0, ...right.xpCosts.map(cost => cost.minimumLevel));
    return leftLevel - rightLevel || left.id - right.id;
  })[0]!;
  const missing: string[] = [];
  const missingPrerequisites = gate.requiredTagIds
    .filter(tag => !character.modifiers.values.researchTags.includes(tag))
    .map(tag => `“${nodeByTag.get(tag)?.name ?? `research tag ${String(tag)}`}”`);
  if (missingPrerequisites.length) missing.push(`prerequisite ${joinRequirements(missingPrerequisites)}`);
  for (const cost of gate.xpCosts) {
    const current = xpLevel(character, cost.category);
    if (current < cost.minimumLevel) missing.push(`${titleCaseCategory(cost.category)} level ${String(cost.minimumLevel)} (current ${String(current)})`);
  }
  const detail = missing.length ? joinRequirements(missing) : 'unlock it in the Research tree';
  return { available: false, requirement: `Requires research “${gate.name}” — ${detail}.` };
}

export function assertMiningResourcesAvailable(
  resourceIds: readonly number[],
  resources: readonly { id: number; name: string; available: boolean; requirement?: string }[],
): void {
  for (const id of resourceIds) {
    const resource = resources.find(candidate => candidate.id === id);
    if (!resource) throw new Error(`Unknown mining resource ${String(id)}`);
    if (!resource.available) throw new Error(`${resource.name} is unavailable. ${resource.requirement ?? 'Required research is not unlocked.'}`);
  }
}
