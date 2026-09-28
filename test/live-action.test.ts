import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAuthorizedCopperStep, selectAutomaticMiningDecision } from '../src/c4.js';

const authority = '5sHs3Gjw43Csi9WN582iqoHUZrVZE8LhyJ7xqtcoQFCw';

test('accepts only the exact authorized MF-01 action and authority', () => {
  assert.doesNotThrow(() => assertAuthorizedCopperStep('register-starbase', { fleet: 'MF-01', action: 'register-starbase', authority }));
  assert.doesNotThrow(() => assertAuthorizedCopperStep('unload', { fleet: 'MF-01', action: 'unload', authority }));
  assert.doesNotThrow(() => assertAuthorizedCopperStep('load', { fleet: 'MF-01', action: 'load', authority }));
  assert.doesNotThrow(() => assertAuthorizedCopperStep('undock', { fleet: 'MF-01', action: 'undock', authority }));
  assert.doesNotThrow(() => assertAuthorizedCopperStep('start-mining', { fleet: 'MF-01', action: 'start-mining', authority }));
  assert.doesNotThrow(() => assertAuthorizedCopperStep('stop-mining', { fleet: 'MF-01', action: 'stop-mining', authority }));
  assert.throws(() => assertAuthorizedCopperStep('stop-mining', { fleet: 'MF-01', action: 'dock', authority }), /not stop-mining/);
  assert.throws(() => assertAuthorizedCopperStep('load', { fleet: 'MF-02', action: 'load', authority }), /not MF-01/);
  assert.throws(() => assertAuthorizedCopperStep('load', { fleet: 'MF-01', action: 'load', authority: '11111111111111111111111111111111' }), /authority changed/);
});


test('automatic load keeps the observed refill amounts unless stop handling overrides the action', () => {
  const observed = { kind: 'load' as const, foodRaw: 51n, ammoRaw: 70n, fuelRaw: 20n };

  assert.equal(selectAutomaticMiningDecision(observed, 'continue'), observed);
  assert.deepEqual(selectAutomaticMiningDecision(observed, 'stop-mining'), { kind: 'stop-mining' });
  assert.deepEqual(selectAutomaticMiningDecision(observed, 'dock'), { kind: 'dock' });
});
