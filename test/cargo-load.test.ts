import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCopperLoadFitsCargoStorage, calculateCopperLoadStorageRaw } from '../src/c4.js';
import { PLAN_STAGE_MARKER, isPostSubmissionFailure, planStageReason } from '../src/automatic-c4.js';

test('load storage is scaled by CARGO_STORAGE_SCALE so a small refill fits the fleet cargo hold', () => {
  // Regression: the live MF-01 has a 249-unit cargo hold and needs to load 13 Food.
  // Food storageCost is 256. The buggy planner billed 13 x 256 = 3328 raw units and
  // rejected every refill. AEPA's own math divides by the 256 storage scale:
  // 13 x 256 / 256 = 13 storage units, which fits inside 249.
  const foodStorageCost = 256n;
  assert.equal(calculateCopperLoadStorageRaw({ foodRaw: 13n, foodStorageCost }), 13n);
  assert.doesNotThrow(() => assertCopperLoadFitsCargoStorage({
    cargoCapacityRaw: 249n,
    cargoUsedRaw: 0n,
    foodRaw: 13n,
    foodStorageCost,
  }));
});

test('load storage math still rejects a genuinely oversized cargo load', () => {
  assert.throws(() => assertCopperLoadFitsCargoStorage({
    cargoCapacityRaw: 249n,
    cargoUsedRaw: 0n,
    foodRaw: 300n,
    foodStorageCost: 256n,
  }), /requires 300 raw units/);
});

test('plan-stage classification marks pre-submission failures and never post-submit ambiguity', () => {
  assert.equal(planStageReason('cargo planner rejected the transfer').startsWith(PLAN_STAGE_MARKER), true);
  assert.equal(isPostSubmissionFailure('start-mining transaction sig-1 was submitted once but confirmation was not observed within 90 seconds'), true);
  assert.equal(isPostSubmissionFailure('it must not be resubmitted'), true);
  assert.equal(isPostSubmissionFailure('cargo storage capacity has 249 units remaining'), false);
  assert.match(planStageReason('planning failed'), /\[plan-stage\] planning failed/);
});