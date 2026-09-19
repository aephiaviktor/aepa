import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAutomationCanEnable, assertAutomationCanReplace, validateSupportedAutomationAssignment } from '../src/automation-assignment.js';

const catalog = {
  faction: 'ustur' as const,
  fleets: [{ address: 'fleet-mf01', name: 'MF-01', state: 'docked' }, { address: 'fleet-mf02', name: 'MF-02', state: 'idle' }],
  homeStarbases: [{ systemAddress: 'eternity', systemId: 10, systemName: 'Eternity', regionId: 1, regionOwner: 'ustur' as const, coordinates: { x: 40, y: 30 } }],
  resources: [{ id: 311, name: 'Copper Ore' }, { id: 329, name: 'Iron Ore' }],
  destinations: [{ address: 'ioki', name: 'Ioki', systemAddress: 'eternity', systemName: 'Eternity', systemFaction: 'ustur' as const, coordinates: { x: 40, y: 30 }, regionId: 1, regionOwner: 'ustur' as const, resourceIds: [311] }],
  mode: 'configuration-preview' as const,
};

const input = { fleetAddress: 'fleet-mf01', assignment: 'mining', homeSystemAddress: 'eternity', resourceId: 311, destinationAddress: 'ioki', travelMode: 'auto' };

test('accepts the proven Eternity Ioki Copper assignment for any catalog fleet', () => {
  const assignment = validateSupportedAutomationAssignment(input, catalog, 'profile-1');
  assert.deepEqual(assignment, {
    profile: 'profile-1', fleetAddress: 'fleet-mf01', fleetName: 'MF-01', assignment: 'mining',
    homeSystemAddress: 'eternity', homeSystemId: 10, homeSystemName: 'Eternity', resourceId: 311,
    resourceName: 'Copper Ore', destinationAddress: 'ioki', destinationName: 'Ioki', travelMode: 'auto',
  });
  const second = validateSupportedAutomationAssignment({ ...input, fleetAddress: 'fleet-mf02' }, catalog, 'profile-1');
  assert.equal(second.fleetName, 'MF-02');
  assert.equal(second.fleetAddress, 'fleet-mf02');
});

test('requires out-of-band reconciliation before a runner-paused assignment can be retried or replaced', () => {
  const paused = { enabled: false, status: 'paused', lastError: 'submitted once but confirmation was not observed' } as const;
  assert.throws(() => assertAutomationCanEnable(paused), /reconciliation/i);
  assert.throws(() => assertAutomationCanReplace(paused), /reconciliation/i);
  assert.doesNotThrow(() => assertAutomationCanEnable({ enabled: false, status: 'disabled' }));
});

test('rejects unproven resources, destinations, and travel modes', () => {
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, resourceId: 329 }, catalog, 'profile-1'), /only Copper Ore/i);
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, destinationAddress: 'elsewhere' }, catalog, 'profile-1'), /Ioki/i);
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, travelMode: 'warp' }, catalog, 'profile-1'), /same-system/i);
});
