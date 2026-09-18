import assert from 'node:assert/strict';
import test from 'node:test';
import { address, getAddressEncoder } from '@solana/kit';
import { parseStopMiningXpModifiers } from '../src/stop-mining-xp.js';

const encoder = getAddressEncoder();
const pilot = address('11111111111111111111111111111111');
const mining = address('SysvarC1ock11111111111111111111111111111111');
const councilRank = address('Vote111111111111111111111111111111111111111');

const writeModifier = (raw: Uint8Array, record: number, modifier: Parameters<typeof encoder.encode>[0]) => {
  raw.set(encoder.encode(modifier), 73 + record * 65 + 32);
};

test('parses pilot, mining, and council-rank modifiers from the Game points layout', () => {
  const raw = new Uint8Array(73 + 6 * 65);
  writeModifier(raw, 1, councilRank);
  writeModifier(raw, 2, pilot);
  writeModifier(raw, 4, mining);
  assert.deepEqual(parseStopMiningXpModifiers(raw), { pilot, mining, councilRank });
});

test('rejects a truncated Game points layout', () => {
  assert.throws(() => parseStopMiningXpModifiers(new Uint8Array(73 + 6 * 65 - 1)), /points config is unreadable/);
});
