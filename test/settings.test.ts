import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, validateSettings } from '../src/settings.js';

test('defaults are locked to C4 testnet', () => {
  assert.equal(DEFAULT_SETTINGS.network, 'zink-ptr');
  assert.equal(DEFAULT_SETTINGS.rpcUrl, 'https://testnet-rpc.z.ink');
});

test('settings reject another network and invalid profiles', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, network: 'mainnet' }), /locked to C4 Testnet/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, playerProfile: 'not-a-profile' }));
});

test('settings accept a public Player Profile address', () => {
  const playerProfile = '11111111111111111111111111111111';
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, playerProfile }).playerProfile, playerProfile);
});
