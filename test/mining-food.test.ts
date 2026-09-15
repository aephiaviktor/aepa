import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMiningFoodPlan } from '../src/mining-food.js';

const rate = (numerator: bigint, denominator = 1n) => ({ numerator, denominator });

test('loads food for the cargo limit when cargo fills before ammo empties', () => {
  const plan = calculateMiningFoodPlan({
    cargoCapacityRaw: 249n,
    preservedCargoStorageRaw: 0n,
    copperStoragePerUnit: rate(1n),
    foodStoragePerUnit: rate(1n),
    copperUnitsPerSecond: rate(2n),
    foodUnitsPerSecond: rate(1n),
    ammoAmountRaw: 1_000n,
    ammoUnitsPerSecond: rate(1n),
  });
  assert.deepEqual(plan, {
    limitingEvent: 'cargo',
    targetMiningSeconds: rate(249n, 2n),
    foodForCargoRaw: 125n,
    foodForAmmoRaw: 1_000n,
    foodToLoadRaw: 125n,
    copperAtStopRaw: 249n,
    cargoStorageAtStopRaw: 249n,
    unavoidableFoodRoundingRaw: 1n,
  });
});

test('loads food for the ammo limit when ammo empties first', () => {
  const plan = calculateMiningFoodPlan({
    cargoCapacityRaw: 249n,
    preservedCargoStorageRaw: 9n,
    copperStoragePerUnit: rate(1n),
    foodStoragePerUnit: rate(1n),
    copperUnitsPerSecond: rate(2n),
    foodUnitsPerSecond: rate(1n),
    ammoAmountRaw: 60n,
    ammoUnitsPerSecond: rate(1n),
  });
  assert.equal(plan.limitingEvent, 'ammo');
  assert.deepEqual(plan.targetMiningSeconds, rate(60n));
  assert.equal(plan.foodForCargoRaw, 120n);
  assert.equal(plan.foodForAmmoRaw, 60n);
  assert.equal(plan.foodToLoadRaw, 60n);
  assert.equal(plan.copperAtStopRaw, 120n);
  assert.equal(plan.cargoStorageAtStopRaw, 129n);
  assert.equal(plan.unavoidableFoodRoundingRaw, 0n);
});

test('reports a simultaneous limit and preserves unrelated cargo', () => {
  const plan = calculateMiningFoodPlan({
    cargoCapacityRaw: 100n,
    preservedCargoStorageRaw: 20n,
    copperStoragePerUnit: rate(2n),
    foodStoragePerUnit: rate(1n),
    copperUnitsPerSecond: rate(4n),
    foodUnitsPerSecond: rate(3n, 2n),
    ammoAmountRaw: 10n,
    ammoUnitsPerSecond: rate(1n),
  });
  assert.equal(plan.limitingEvent, 'simultaneous');
  assert.equal(plan.foodToLoadRaw, 15n);
  assert.equal(plan.copperAtStopRaw, 40n);
  assert.equal(plan.cargoStorageAtStopRaw, 100n);
});

test('uses exact rational rates and minimum sufficient integer food without a reserve', () => {
  const plan = calculateMiningFoodPlan({
    cargoCapacityRaw: 10n,
    preservedCargoStorageRaw: 0n,
    copperStoragePerUnit: rate(1n),
    foodStoragePerUnit: rate(1n),
    copperUnitsPerSecond: rate(3n, 2n),
    foodUnitsPerSecond: rate(1n, 3n),
    ammoAmountRaw: 100n,
    ammoUnitsPerSecond: rate(1n),
  });
  assert.equal(plan.foodForCargoRaw, 3n);
  assert.equal(plan.foodToLoadRaw, 3n);
  assert.equal(plan.unavoidableFoodRoundingRaw, 1n);
});

test('rejects invalid or impossible inputs', () => {
  const valid = {
    cargoCapacityRaw: 10n,
    preservedCargoStorageRaw: 0n,
    copperStoragePerUnit: rate(1n),
    foodStoragePerUnit: rate(1n),
    copperUnitsPerSecond: rate(1n),
    foodUnitsPerSecond: rate(1n),
    ammoAmountRaw: 1n,
    ammoUnitsPerSecond: rate(1n),
  };
  assert.throws(() => calculateMiningFoodPlan({ ...valid, preservedCargoStorageRaw: 11n }), /preserved cargo/i);
  assert.throws(() => calculateMiningFoodPlan({ ...valid, copperUnitsPerSecond: rate(0n) }), /positive/i);
  assert.throws(() => calculateMiningFoodPlan({ ...valid, ammoAmountRaw: -1n }), /ammo/i);
});
