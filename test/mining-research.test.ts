import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMiningResourceEligibility } from '../src/mining-research.js';

const character = {
  xp: {
    councilRank: { level: 0 }, dailyXp: { level: 3 }, pilot: { level: 0 }, dataRunner: { level: 0 },
    mining: { level: 1 }, building: { level: 0 }, crafting: { level: 1 }, combat: { level: 0 },
  },
  modifiers: { unlockedNodes: [0, 62], values: { researchTags: [0, 62], cargoCategories: [2] } },
};

const nodes = [
  { id: 0, name: 'Starting Node', requiredTagIds: [], xpCosts: [{ category: 'council-rank', minimumLevel: 0 }], modifier: { researchTags: [0], cargoCategories: [2], rareMineralDiscovery: [] } },
  { id: 62, name: 'Freelance Miner', requiredTagIds: [0], xpCosts: [{ category: 'mining', minimumLevel: 1 }], modifier: { researchTags: [62], cargoCategories: [], rareMineralDiscovery: [] } },
  { id: 377, name: 'Deep Vein Extraction', requiredTagIds: [62], xpCosts: [{ category: 'mining', minimumLevel: 3 }], modifier: { researchTags: [377], cargoCategories: [], rareMineralDiscovery: [{ cargoId: 311 }] } },
  { id: 82, name: 'Rare Mineral Discoveries', requiredTagIds: [62], xpCosts: [{ category: 'mining', minimumLevel: 5 }], modifier: { researchTags: [82], cargoCategories: [9], rareMineralDiscovery: [{ cargoId: 312 }] } },
];

test('rare-mineral yield modifiers do not lock mining resources', () => {
  assert.deepEqual(resolveMiningResourceEligibility(2, character, nodes), { available: true });
});

test('a missing cargo-category grant explains the exact research and XP requirement', () => {
  assert.deepEqual(resolveMiningResourceEligibility(9, character, nodes), {
    available: false,
    requirement: 'Requires research “Rare Mineral Discoveries” — Mining level 5 (current 1).',
  });
});

test('an unlocked cargo category remains valid after progression data changes', () => {
  const unlocked = { ...character, modifiers: { unlockedNodes: [0, 62, 82], values: { researchTags: [0, 62, 82], cargoCategories: [2, 9] } } };
  assert.deepEqual(resolveMiningResourceEligibility(9, unlocked, nodes), { available: true });
});
