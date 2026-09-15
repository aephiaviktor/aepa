import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateServiceBundleAmounts } from '../src/c4.js';

test('service bundle unloads Copper and loads only resource deficits', () => {
  assert.deepEqual(calculateServiceBundleAmounts({
    copperRaw: 18n,
    foodRaw: 12n,
    targetFoodRaw: 13n,
    ammoRaw: 1038n,
    ammoTargetRaw: 1040n,
    fuelRaw: 445n,
    fuelTargetRaw: 450n,
  }), {
    copperToStarbaseRaw: 18n,
    foodToFleetRaw: 1n,
    ammoToFleetRaw: 2n,
    fuelToFleetRaw: 5n,
  });
});

test('service bundle fails closed instead of unloading excess Food implicitly', () => {
  assert.throws(() => calculateServiceBundleAmounts({
    copperRaw: 18n,
    foodRaw: 14n,
    targetFoodRaw: 13n,
    ammoRaw: 1038n,
    ammoTargetRaw: 1040n,
    fuelRaw: 445n,
    fuelTargetRaw: 450n,
  }), /will not unload excess Food/);
});
