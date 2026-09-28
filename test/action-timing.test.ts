import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionStageTimer, formatActionTimings } from '../src/action-timing.js';

test('action timing records sequential stage durations and a stable total', () => {
  const values = [100, 112, 140, 145, 165, 170, 190, 200];
  const timer = new ActionStageTimer(() => values.shift()!);
  timer.complete('observation');
  timer.complete('planning');
  timer.complete('atlas-prepare');
  timer.complete('simulation');
  timer.complete('send');
  timer.complete('confirmation');
  timer.complete('post-state');
  assert.deepEqual(timer.snapshot(), {
    observation: 12,
    planning: 28,
    'atlas-prepare': 5,
    simulation: 20,
    send: 5,
    confirmation: 20,
    'post-state': 10,
    total: 100,
  });
  assert.equal(
    formatActionTimings(timer.snapshot()),
    'timings observation=12ms planning=28ms atlas-prepare=5ms simulation=20ms send=5ms confirmation=20ms post-state=10ms total=100ms',
  );
});

test('repeated stage marks accumulate and durations never become negative', () => {
  const values = [50, 40, 55];
  const timer = new ActionStageTimer(() => values.shift()!);
  timer.complete('observation');
  timer.complete('observation');
  assert.equal(timer.snapshot().observation, 15);
  assert.equal(timer.snapshot().total, 5);
});
