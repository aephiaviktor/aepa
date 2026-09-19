import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAutomationCanEnable, assertAutomationCanReplace, validateSupportedAutomationAssignment } from '../src/automation-assignment.js';

const catalog = {
  faction: 'ustur' as const,
  fleets: [{ address: 'fleet-mf01', name: 'MF-01', state: 'docked' }, { address: 'fleet-mf02', name: 'MF-02', state: 'idle' }],
  homeStarbases: [{ systemAddress: 'eternity', systemId: 10, systemName: 'Eternity', regionId: 1, regionOwner: 'ustur' as const, coordinates: { x: 40, y: 30 } }],
  resources: [{ id: 311, name: 'Copper Ore' }, { id: 329, name: 'Carbon' }],
  destinations: [{ address: 'ioki', name: 'Ioki', systemAddress: 'eternity', systemName: 'Eternity', systemFaction: 'ustur' as const, coordinates: { x: 40, y: 30 }, regionId: 1, regionOwner: 'ustur' as const, resourceIds: [311, 329] }, { address: 'far', name: 'Far Belt', systemAddress: 'elsewhere', systemName: 'Elsewhere', systemFaction: 'ustur' as const, coordinates: { x: 41, y: 30 }, regionId: 1, regionOwner: 'ustur' as const, resourceIds: [329] }],
  mode: 'configuration-preview' as const,
};

const input = { fleetAddress: 'fleet-mf01', assignment: 'mining', homeSystemAddress: 'eternity', resourceId: 311, destinationAddress: 'ioki', travelMode: 'auto' };

test('accepts any catalog resource at a same-system destination for any catalog fleet', () => {
  const assignment = validateSupportedAutomationAssignment(input, catalog, 'profile-1');
  assert.equal(assignment.resourceName, 'Copper Ore');
  const carbon = validateSupportedAutomationAssignment({ ...input, fleetAddress: 'fleet-mf02', resourceId: 329 }, catalog, 'profile-1');
  assert.equal(carbon.fleetName, 'MF-02');
  assert.equal(carbon.resourceName, 'Carbon');
  assert.equal(carbon.destinationName, 'Ioki');
});

test('running assignments remain editable while paused assignments retain reconciliation safety', () => {
  assert.doesNotThrow(() => assertAutomationCanReplace({ enabled: true, status: 'running' }));
  const paused = { enabled: false, status: 'paused', lastError: 'submitted once but confirmation was not observed' } as const;
  assert.throws(() => assertAutomationCanEnable(paused), /reconciliation/i);
  assert.throws(() => assertAutomationCanReplace(paused), /reconciliation/i);
  assert.doesNotThrow(() => assertAutomationCanEnable({ enabled: false, status: 'disabled' }));
});

test('rejects unknown resources, mismatched destinations, and unsupported cross-system travel', () => {
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, resourceId: 999 }, catalog, 'profile-1'), /resource/i);
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, destinationAddress: 'far', resourceId: 311 }, catalog, 'profile-1'), /not available/i);
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, destinationAddress: 'far', resourceId: 329 }, catalog, 'profile-1'), /cross-system/i);
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, travelMode: 'warp' }, catalog, 'profile-1'), /does not use/i);
});
