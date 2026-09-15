import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRegionCode, rankMiningDestinations } from '../src/automation-options.js';

test('formats live region ownership with the agreed compact labels', () => {
  assert.equal(formatRegionCode('ustur', 1), 'US-1');
  assert.equal(formatRegionCode('mud', 23), 'MT-23');
  assert.equal(formatRegionCode('oni', 8), 'OR-8');
  assert.equal(formatRegionCode('unaligned', 9), 'UN-9');
});

test('filters on system faction rather than region owner and ranks by home distance', () => {
  const ranked = rankMiningDestinations({
    faction: 'ustur',
    resourceId: 311,
    home: { x: 10, y: 10 },
    destinations: [
      { address: 'far', name: 'Belt B', systemAddress: 'sys-b', systemName: 'Second', systemFaction: 'ustur', coordinates: { x: 13, y: 14 }, regionId: 23, regionOwner: 'mud', resourceIds: [311] },
      { address: 'wrong-faction', name: 'Belt C', systemAddress: 'sys-c', systemName: 'Third', systemFaction: 'mud', coordinates: { x: 10, y: 10 }, regionId: 1, regionOwner: 'ustur', resourceIds: [311] },
      { address: 'home', name: 'Ioki', systemAddress: 'sys-a', systemName: 'Eternity', systemFaction: 'ustur', coordinates: { x: 10, y: 10 }, regionId: 1, regionOwner: 'ustur', resourceIds: [311] },
      { address: 'wrong-resource', name: 'Belt D', systemAddress: 'sys-d', systemName: 'Fourth', systemFaction: 'ustur', coordinates: { x: 11, y: 10 }, regionId: 2, regionOwner: 'ustur', resourceIds: [1] },
    ],
  });
  assert.deepEqual(ranked.map(({ address, label, distance }) => ({ address, label, distance })), [
    { address: 'home', label: 'US-1 | Eternity | Ioki | 0', distance: 0 },
    { address: 'far', label: 'MT-23 | Second | Belt B | 5', distance: 5 },
  ]);
});
