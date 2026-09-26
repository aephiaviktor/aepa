import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAutomationCanEnable, assertAutomationCanReplace, validateSupportedAutomationAssignment } from '../src/automation-assignment.js';

const catalog = {
  faction: 'ustur' as const,
  fleets: [
    { address: 'fleet-mf01', name: 'MF-01', state: 'docked', location: { x: 40, y: 30 }, travel: { fuelCapacityRaw: '100', maxWarpDistance: 10, subwarpFuelConsumptionRate: 1, warpFuelConsumptionRate: 1 } },
    { address: 'fleet-mf02', name: 'MF-02', state: 'idle', location: { x: 40, y: 30 }, travel: { fuelCapacityRaw: '100', maxWarpDistance: 10, subwarpFuelConsumptionRate: 1, warpFuelConsumptionRate: 1 } },
  ],
  homeStarbases: [{ systemAddress: 'eternity', systemId: 10, systemName: 'Eternity', regionId: 1, regionOwner: 'ustur' as const, coordinates: { x: 40, y: 30 }, registered: true }],
  resources: [{ id: 311, name: 'Copper Ore', available: true }, { id: 329, name: 'Carbon', available: true }, { id: 312, name: 'Cryo Formation Crystals', available: false, requirement: 'Requires research “Rare Mineral Discoveries” — Mining level 5 (current 1).' }],
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

test('rejects unknown resources, mismatched destinations, and invalid travel modes', () => {
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, resourceId: 999 }, catalog, 'profile-1'), /resource/i);
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, destinationAddress: 'far', resourceId: 311 }, catalog, 'profile-1'), /not available/i);
  assert.equal(validateSupportedAutomationAssignment({ ...input, destinationAddress: 'far', resourceId: 329, travelMode: 'subwarp' }, catalog, 'profile-1').travelMode, 'subwarp');
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, destinationAddress: 'far', resourceId: 329, travelMode: 'same-system' }, catalog, 'profile-1'), /cross-system/i);
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, travelMode: 'warp' }, catalog, 'profile-1'), /same-system/i);
  assert.throws(() => validateSupportedAutomationAssignment({ ...input, travelMode: 'teleport' }, catalog, 'profile-1'), /travel mode/i);
});

test('validates and sorts one to eight unique resources at the destination', () => {
  const result = validateSupportedAutomationAssignment({ ...input, resourceIds: [329, 311] }, catalog, 'profile-1');
  assert.deepEqual(result.resourceIds, [311, 329]);
  for (const resourceIds of [[], [311, 311], [999], Array.from({ length: 9 }, (_, i) => i)]) {
    assert.throws(() => validateSupportedAutomationAssignment({ ...input, resourceIds }, catalog, 'profile-1'), /resource/i);
  }
});

test('rejects a resource blocked by current research progression', () => {
  const withRare = { ...catalog, destinations: [{ ...catalog.destinations[0], resourceIds: [311, 312, 329] }, catalog.destinations[1]] };
  assert.throws(
    () => validateSupportedAutomationAssignment({ ...input, resourceId: 312 }, withRare, 'profile-1'),
    /Rare Mineral Discoveries.*Mining level 5/i,
  );
});

test('scanning persists the selected SDK pattern and signed sector, never a movement pattern', () => {
  const scans = { ...catalog, scanRegions: [{id:1,available:true,border:[[-128,-128],[127,-128],[127,127],[-128,127]].map(([x,y])=>({xRaw:(BigInt(x)*(1n<<56n)).toString(),yRaw:(BigInt(y)*(1n<<56n)).toString()}))}], scanPatterns: [{ id: 0, name: 'Broad Spectrum', available: true, costs: [] }] };
  const scan = { ...input, assignment: 'scanning', travelMode: 'subwarp', scanPatternId: 0, scanSectorX: -1, scanSectorY: 0 };
  // Give the signed destination sufficient fuel capacity.
  scans.fleets = scans.fleets.map(fleet => ({...fleet, travel: {...fleet.travel, fuelCapacityRaw: '1000'}}));
  const saved = validateSupportedAutomationAssignment(scan, scans, 'profile-1');
  assert.equal(saved.scanSectorX, -1);
  assert.equal(saved.scanPatternId, 0);
  assert.equal(saved.resourceName, 'Broad Spectrum');
  for (const travelMode of ['auto','same-system','warp-lane']) assert.throws(() => validateSupportedAutomationAssignment({...scan, travelMode}, scans, 'profile-1'), /Warp or Subwarp/);
  assert.throws(() => validateSupportedAutomationAssignment({...scan, scanPatternId: 99}, scans, 'profile-1'), /Scan Pattern/);
});

test('scanning refuses a route that fits nominal fuel but leaves no rounding reserve',()=>{
  const scans={...catalog,scanRegions:[{id:1,available:true,border:[[0,0],[100,0],[100,100],[0,100]].map(([x,y])=>({xRaw:(BigInt(x)*(1n<<56n)).toString(),yRaw:(BigInt(y)*(1n<<56n)).toString()}))}],scanPatterns:[{id:0,name:'Broad Spectrum',available:true,costs:[]}]};
  assert.throws(()=>validateSupportedAutomationAssignment({...input,assignment:'scanning',travelMode:'subwarp',scanPatternId:0,scanSectorX:90,scanSectorY:30},scans,'profile-1'),/return reserve/);
});
