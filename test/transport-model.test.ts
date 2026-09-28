import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectedReturnAvailability,
  rankTransportTargets,
  validateTransportQuantities,
  decideTransportStep,
} from '../src/transport-model.js';

const fleet = {
  fuelCapacityRaw: '100', maxWarpDistance: 10,
  subwarpFuelConsumptionRate: 1, warpFuelConsumptionRate: 2,
};
const systems = [
  { address: 'home', name: 'Home', systemId: 1, coordinates: { x: 0, y: 0 }, connections: [2] },
  { address: 'direct', name: 'Direct', systemId: 2, coordinates: { x: 5, y: 0 }, connections: [1] },
  { address: 'one-way', name: 'One Way', systemId: 3, coordinates: { x: 4, y: 0 }, connections: [] },
  { address: 'far', name: 'Far', systemId: 4, coordinates: { x: 60, y: 0 }, connections: [1] },
];

test('transport targets require full-tank round trip and reciprocal direct lanes', () => {
  assert.deepEqual(rankTransportTargets({ home: systems[0]!, systems, fleet, travelMode: 'subwarp' }).map(x => x.address), ['one-way', 'direct']);
  assert.deepEqual(rankTransportTargets({ home: systems[0]!, systems, fleet, travelMode: 'warp-lane' }).map(x => x.address), ['direct']);
});

test('return availability includes the configured outbound delivery without changing live balance', () => {
  assert.deepEqual(projectedReturnAvailability(
    [{ cargoId: 10, amountRaw: '7' }, { cargoId: 11, amountRaw: '3' }],
    [{ cargoId: 10, amountRaw: '5' }, { cargoId: 12, amountRaw: '2' }],
  ), [
    { cargoId: 10, liveRaw: '7', projectedRaw: '12' },
    { cargoId: 11, liveRaw: '3', projectedRaw: '3' },
    { cargoId: 12, liveRaw: '0', projectedRaw: '2' },
  ]);
});

test('transport quantities stay exact and reject stale source or capacity assumptions', () => {
  assert.deepEqual(validateTransportQuantities({
    requested: [{ cargoId: 10, amountRaw: '9007199254740993' }],
    available: [{ cargoId: 10, amountRaw: '9007199254740994' }],
    storageCostByCargoId: new Map([[10, 256n]]), remainingStorageRaw: 9_007_199_254_740_993n,
  }), [{ cargoId: 10, amount: 9_007_199_254_740_993n }]);
  assert.throws(() => validateTransportQuantities({ requested: [{ cargoId: 10, amountRaw: '8' }], available: [{ cargoId: 10, amountRaw: '7' }], storageCostByCargoId: new Map([[10, 1n]]), remainingStorageRaw: 100n }), /available/i);
  assert.throws(() => validateTransportQuantities({ requested: [{ cargoId: 10, amountRaw: '8' }], available: [{ cargoId: 10, amountRaw: '9' }], storageCostByCargoId: new Map([[10, 256n]]), remainingStorageRaw: 7n }), /capacity/i);
});

test('transport phase decisions resume from authoritative state without duplicating confirmed work', () => {
  assert.equal(decideTransportStep({ phase: 'load-outbound', location: 'home', fleetState: 'docked', outboundLoaded: false, outboundUnloaded: false, returnLoaded: false, returnUnloaded: true }), 'load-outbound');
  assert.equal(decideTransportStep({ phase: 'load-outbound', location: 'home', fleetState: 'docked', outboundLoaded: true, outboundUnloaded: false, returnLoaded: false, returnUnloaded: true }), 'undock-outbound');
  assert.equal(decideTransportStep({ phase: 'travel-outbound', location: 'target', fleetState: 'idle', outboundLoaded: true, outboundUnloaded: false, returnLoaded: false, returnUnloaded: true }), 'dock-target');
  assert.equal(decideTransportStep({ phase: 'service-target', location: 'target', fleetState: 'docked', outboundLoaded: false, outboundUnloaded: true, returnLoaded: true, returnUnloaded: true }), 'undock-return');
  assert.equal(decideTransportStep({ phase: 'service-home', location: 'home', fleetState: 'docked', outboundLoaded: false, outboundUnloaded: true, returnLoaded: false, returnUnloaded: false }), 'unload-return');
});
