import test from 'node:test';
import assert from 'node:assert/strict';
import { scanningServiceTargets, scanningTransfers, travelFuelBudget } from '../src/scanning-logistics.js';
test('scan supplies use half the hold at most, leaving recovery capacity', () => {
  assert.deepEqual(scanningServiceTargets([{ cargoId: 5, name: 'Data', amount: 3n, storageCost: 256 }], 100n), [{ cargoId: 5, amount: 48n }]);
  assert.throws(() => scanningServiceTargets([{ cargoId: 5, name: 'Data', amount: 51n, storageCost: 256 }], 100n), /capacity/);
});
test('service unloads excess and unrelated loot without confusing tank fuel with scan fuel in hold', () => {
  const result = scanningTransfers([{ id: 2, amount: 7n }, {id: 50, amount: 12n}], [{cargoId: 2, amount: 10n}]);
  assert.deepEqual(result.unload, [{cargoId: 50, amount: 12n}]);
  assert.deepEqual(result.load, [{cargoId: 2, amount: 3n}]);
});
test('travel reserves fuel for both contact leg and home leg', () => {
  assert.equal(travelFuelBudget({x:0,y:0},{x:3,y:4},{x:0,y:0},1), 12n);
  assert.throws(() => travelFuelBudget({x:0,y:0},{x:3,y:4},{x:0,y:0},NaN));
});
