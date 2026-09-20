import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMultiResourceFoodPlan } from '../src/mining-food.js';

test('splits mining effort across four resources and plans their combined cargo', () => {
  const plan = calculateMultiResourceFoodPlan({ cargoCapacityRaw: 1000n, preservedCargoStorageRaw: 0n,
    resources: [329,334,342,361].map(id => ({ id, richness: { numerator: 1n, denominator: 1n }, storagePerUnit: { numerator: 1n, denominator: 1n } })),
    fleetUnitsPerSecond: { numerator: 1016n, denominator: 16384n },
    foodStoragePerUnit: { numerator: 1n, denominator: 1n }, foodUnitsPerSecond: { numerator: 48n, denominator: 16384n },
    ammoAmountRaw: 9120n, ammoUnitsPerSecond: { numerator: 64n, denominator: 16384n },
  });
  assert.equal(plan.outputs.length, 4);
  for (const output of plan.outputs) assert.equal(658n * output.unitsPerSecond.numerator / output.unitsPerSecond.denominator, 10n);
  assert.equal(plan.foodToLoadRaw, 48n);
  assert.ok(plan.cargoStorageAtStopRaw <= 1000n);
});

test('weights unequal richness and storage, and limits by ammo without multiplying upkeep', () => {
  const plan = calculateMultiResourceFoodPlan({ cargoCapacityRaw: 10000n, preservedCargoStorageRaw: 50n,
    resources: [{ id: 1, richness: { numerator: 1n, denominator: 1n }, storagePerUnit: { numerator: 2n, denominator: 1n } },
      { id: 2, richness: { numerator: 1n, denominator: 2n }, storagePerUnit: { numerator: 1n, denominator: 1n } }],
    fleetUnitsPerSecond: { numerator: 4n, denominator: 1n }, foodStoragePerUnit: { numerator: 1n, denominator: 1n },
    foodUnitsPerSecond: { numerator: 1n, denominator: 1n }, ammoAmountRaw: 100n, ammoUnitsPerSecond: { numerator: 1n, denominator: 1n },
  });
  assert.equal(plan.limitingEvent, 'ammo');
  assert.deepEqual(plan.outputs.map(x => x.amountRaw), [200n, 100n]);
  assert.equal(plan.foodToLoadRaw, 100n);
  assert.equal(plan.targetMiningSeconds.numerator, 100n);
});
