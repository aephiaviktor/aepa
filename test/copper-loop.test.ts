import assert from 'node:assert/strict';
import test from 'node:test';
import { decideCopperLoopNextStep, requireStarbaseRegistration } from '../src/copper-loop.js';

const ready = {
  atEternity: true,
  fleetName: 'MF-01',
  homeSystemName: 'Eternity',
  foodRaw: 13n,
  targetFoodRaw: 13n,
  copperRaw: 0n,
  ammoRaw: 1040n,
  ammoTargetRaw: 1040n,
  fuelRaw: 450n,
  fuelTargetRaw: 450n,
};

test('idle ready fleet starts mining and idle unbalanced fleet docks first', () => {
  assert.equal(decideCopperLoopNextStep({ ...ready, state: { kind: 'idle' } }).kind, 'start-mining');
  assert.equal(decideCopperLoopNextStep({ ...ready, foodRaw: 59n, state: { kind: 'idle' } }).kind, 'dock');
  assert.equal(decideCopperLoopNextStep({ ...ready, copperRaw: 10n, state: { kind: 'idle' } }).kind, 'dock');
});

test('docked fleet unloads excess first, then loads deficits, then undocks', () => {
  assert.deepEqual(decideCopperLoopNextStep({ ...ready, state: { kind: 'docked' }, copperRaw: 20n, foodRaw: 20n }), {
    kind: 'unload', copperRaw: 20n, foodRaw: 7n,
  });
  assert.deepEqual(decideCopperLoopNextStep({ ...ready, state: { kind: 'docked' }, foodRaw: 10n, ammoRaw: 1000n, fuelRaw: 440n }), {
    kind: 'load', foodRaw: 3n, ammoRaw: 40n, fuelRaw: 10n,
  });
  assert.equal(decideCopperLoopNextStep({ ...ready, state: { kind: 'docked' } }).kind, 'undock');
});

test('mining waits until the on-chain end and then stops', () => {
  assert.deepEqual(decideCopperLoopNextStep({ ...ready, state: { kind: 'mining' }, targetStopAtUnixSeconds: 200n, nowUnixSeconds: 199n }), { kind: 'wait', untilUnixSeconds: 200n });
  assert.equal(decideCopperLoopNextStep({ ...ready, state: { kind: 'mining' }, targetStopAtUnixSeconds: 200n, nowUnixSeconds: 200n }).kind, 'stop-mining');
  const missing = decideCopperLoopNextStep({ ...ready, state: { kind: 'mining' } });
  assert.equal(missing.kind, 'blocked');
  if (missing.kind === 'blocked') assert.match(missing.reason, /durable target stop time/);
});

test('blocks unknown location and unsupported states', () => {
  const location = decideCopperLoopNextStep({ ...ready, atEternity: false, state: { kind: 'idle' } });
  const unsupported = decideCopperLoopNextStep({ ...ready, state: { kind: 'warp' } });
  assert.equal(location.kind, 'blocked');
  assert.equal(unsupported.kind, 'blocked');
  if (location.kind === 'blocked') assert.match(location.reason, /Eternity/);
  if (unsupported.kind === 'blocked') assert.match(unsupported.reason, /Unsupported/);
});

test('registration is inserted before docked cargo service at a new home starbase', () => {
  assert.equal(requireStarbaseRegistration({ kind: 'unload' }, false), true);
  assert.equal(requireStarbaseRegistration({ kind: 'load' }, false), true);
  assert.equal(requireStarbaseRegistration({ kind: 'undock' }, false), false);
  assert.equal(requireStarbaseRegistration({ kind: 'load' }, true), false);
});
