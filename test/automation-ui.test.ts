import assert from 'node:assert/strict';
import test from 'node:test';
import { automationDraftsEqual, formatMiningProgress } from '../src/automation-ui.js';

test('assignment drafts compare canonically across row and resource ordering', () => {
  const saved = [
    { fleetAddress: 'fleet-2', assignment: 'mining', homeSystemAddress: 'home', destinationAddress: 'belt', resourceIds: [312, 309], travelMode: 'auto' },
    { fleetAddress: 'fleet-1', assignment: 'mining', homeSystemAddress: 'home', destinationAddress: 'belt', resourceIds: [311], travelMode: 'auto' },
  ];
  const same = [
    { fleetAddress: 'fleet-1', assignment: 'mining', homeSystemAddress: 'home', destinationAddress: 'belt', resourceIds: [311], travelMode: 'auto' },
    { fleetAddress: 'fleet-2', assignment: 'mining', homeSystemAddress: 'home', destinationAddress: 'belt', resourceIds: [309, 312], travelMode: 'auto' },
  ];
  assert.equal(automationDraftsEqual(saved, same), true);
  assert.equal(automationDraftsEqual(saved, same.map((draft, index) => index ? { ...draft, resourceIds: [309] } : draft)), false);
});

test('mining progress shows current from expected total for every selected resource without Estimated', () => {
  const progress = formatMiningProgress({
    targetStopAtUnixSeconds: 1_100n,
    targetMiningSeconds: 100n,
    expectedResources: [
      { name: 'Hydrogen', expectedRaw: 117n },
      { name: 'Copper Ore', expectedRaw: 73n },
    ],
  }, 1_050n);
  assert.equal(progress, 'Mining progress\nHydrogen: 58 / 117\nCopper Ore: 36 / 73');
  assert.doesNotMatch(progress, /Estimated/i);
});

test('mining progress clamps each resource at its expected cycle total', () => {
  assert.equal(formatMiningProgress({
    targetStopAtUnixSeconds: 1_100n,
    targetMiningSeconds: 100n,
    expectedResources: [{ name: 'Hydrogen', expectedRaw: 117n }],
  }, 1_200n), 'Mining progress\nHydrogen: 117 / 117');
});
