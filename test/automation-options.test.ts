import assert from 'node:assert/strict';
import test from 'node:test';
import { formatHomeStarbaseOption, formatRegionCode, isRoundTripReachable, rankHomeStarbases, rankMiningDestinations } from '../src/automation-options.js';

test('formats live region ownership with the agreed compact labels', () => {
  assert.equal(formatRegionCode('ustur', 1), '1-US');
  assert.equal(formatRegionCode('mud', 23), '23-MT');
  assert.equal(formatRegionCode('oni', 8), '8-OR');
  assert.equal(formatRegionCode('unaligned', 9), '9-UN');
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
    { address: 'home', label: '1-US | Eternity | Ioki | 0', distance: 0 },
    { address: 'far', label: '23-MT | Second | Belt B | 5', distance: 5 },
  ]);
});

test('neutral codes use system faction', () => {
  assert.equal(formatRegionCode('unaligned', 9, 'mud'), '9-MN');
  assert.equal(formatRegionCode('unaligned', 9, 'oni'), '9-ON');
});

test('destination-first lists all resources and sorts on precise distance', () => {
  const base = { name: 'Belt', systemAddress: 's', systemName: 'S', systemFaction: 'ustur' as const, regionId: 1, regionOwner: 'unaligned' as const, resourceIds: [999] };
  const rows = rankMiningDestinations({ faction: 'ustur', home: { x: 0, y: 0 }, destinations: [
    { ...base, address: 'far', coordinates: { x: 1.004, y: 0 } },
    { ...base, address: 'near', coordinates: { x: 1.001, y: 0 } },
  ] });
  assert.deepEqual(rows.map(row => row.address), ['near', 'far']);
});

test('home starbases sort by numeric sector before name', () => {
  const homes = rankHomeStarbases([
    { systemAddress: 'z', systemId: 90, systemName: 'Zeta', regionId: 23 },
    { systemAddress: 'b', systemId: 11, systemName: 'Beta', regionId: 2 },
    { systemAddress: 'a', systemId: 10, systemName: 'Alpha', regionId: 2 },
    { systemAddress: 'c', systemId: 5, systemName: 'Core', regionId: 1 },
  ]);
  assert.deepEqual(homes.map(home => home.systemAddress), ['c', 'a', 'b', 'z']);
});

test('home starbase labels show fleet distance without cluttering auto-registration', () => {
  assert.deepEqual(formatHomeStarbaseOption({
    regionId: 1,
    regionOwner: 'ustur',
    systemFaction: 'ustur',
    systemName: 'Eternity',
    coordinates: { x: 4, y: 6 },
    registered: false,
  }, { x: 1, y: 2 }), {
    label: '1-US | Eternity | 5',
    title: 'Auto-registers on first service at Eternity.',
  });
});

test('travel reachability reserves fuel for both legs and enforces coordinate-warp range', () => {
  const fleet = { fuelCapacityRaw: '11', maxWarpDistance: 4, subwarpFuelConsumptionRate: 1, warpFuelConsumptionRate: 1 };
  assert.equal(isRoundTripReachable('subwarp', 5, fleet), true);
  assert.equal(isRoundTripReachable('subwarp', 5.01, fleet), false);
  assert.equal(isRoundTripReachable('warp', 4, fleet), true);
  assert.equal(isRoundTripReachable('warp', 4.01, fleet), false);
  assert.equal(isRoundTripReachable('warp-lane', 5, fleet), true);
});
