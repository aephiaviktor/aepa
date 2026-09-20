import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMiningResourceEligibility } from '../src/mining-research.js';

const character = {
  xp: {
    councilRank: { level: 0 }, dailyXp: { level: 3 }, pilot: { level: 0 }, dataRunner: { level: 0 },
    mining: { level: 1 }, building: { level: 0 }, crafting: { level: 1 }, combat: { level: 0 },
  },
  modifiers: { unlockedNodes: [0, 62], values: { researchTags: [0, 62] } },
};

const nodes = [
  { id: 62, name: 'Freelance Miner', requiredTagIds: [0], xpCosts: [{ category: 'mining', minimumLevel: 1 }], modifier: { researchTags: [62], rareMineralDiscovery: [] } },
  { id: 377, name: 'Deep Vein Extraction', requiredTagIds: [62], xpCosts: [{ category: 'mining', minimumLevel: 3 }], modifier: { researchTags: [377], rareMineralDiscovery: [{ cargoId: 311 }] } },
  { id: 82, name: 'Rare Mineral Discoveries', requiredTagIds: [62], xpCosts: [{ category: 'mining', minimumLevel: 5 }], modifier: { researchTags: [82], rareMineralDiscovery: [{ cargoId: 312 }] } },
];

test('base mining resources remain selectable without research', () => {
  assert.deepEqual(resolveMiningResourceEligibility(310, character, nodes), { available: true });
});

test('locked mining resources explain the exact research and XP requirement', () => {
  assert.deepEqual(resolveMiningResourceEligibility(311, character, nodes), {
    available: false,
    requirement: 'Requires research “Deep Vein Extraction” — Mining level 3 (current 1).',
  });
});

test('unlocked resource research remains valid even after progression data changes', () => {
  const unlocked = { ...character, modifiers: { unlockedNodes: [0, 62, 377], values: { researchTags: [0, 62, 377] } } };
  assert.deepEqual(resolveMiningResourceEligibility(311, unlocked, nodes), { available: true });
});

test('missing prerequisite research is named', () => {
  const noPrerequisite = { ...character, modifiers: { unlockedNodes: [0], values: { researchTags: [0] } } };
  assert.deepEqual(resolveMiningResourceEligibility(311, noPrerequisite, nodes), {
    available: false,
    requirement: 'Requires research “Deep Vein Extraction” — prerequisite “Freelance Miner” and Mining level 3 (current 1).',
  });
});
