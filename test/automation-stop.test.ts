import assert from 'node:assert/strict';
import test from 'node:test';
import { stoppingDirective } from '../src/automation-stop.js';

test('stop now interrupts active mining while end-of-cycle preserves the deadline', () => {
  assert.equal(stoppingDirective('now', 'mining', 'wait'), 'stop-mining');
  assert.equal(stoppingDirective('end-of-cycle', 'mining', 'wait'), 'continue');
  assert.equal(stoppingDirective('end-of-cycle', 'mining', 'stop-mining'), 'continue');
});

test('a stopping fleet docks instead of restarting and disables only after service', () => {
  assert.equal(stoppingDirective('now', 'idle', 'start-mining'), 'dock');
  assert.equal(stoppingDirective('end-of-cycle', 'idle', 'dock'), 'continue');
  assert.equal(stoppingDirective('now', 'docked', 'unload'), 'continue');
  assert.equal(stoppingDirective('now', 'docked', 'load'), 'continue');
  assert.equal(stoppingDirective('now', 'docked', 'undock'), 'complete');
});

test('saving unrelated rows does not restart a safely stopped fleet', async () => {
  const { shouldEnableSavedAssignment } = await import('../src/automation-stop.js');
  assert.equal(shouldEnableSavedAssignment({ enabled: false, status: 'disabled', lastAction: 'stopped' }), false);
  assert.equal(shouldEnableSavedAssignment({ enabled: false, status: 'disabled' }), true);
  assert.equal(shouldEnableSavedAssignment({ enabled: false, status: 'paused' }), false);
});
