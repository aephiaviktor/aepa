import assert from 'node:assert/strict';
import test from 'node:test';
import { address, getAddressEncoder } from '@solana/kit';
import { decodeBase64AccountData, deriveCareerXpBudget, deriveXpBudgetConfig, parseStopMiningXpModifiers } from '../src/stop-mining-xp.js';

const encoder = getAddressEncoder();
const pilot = address('11111111111111111111111111111111');
const mining = address('SysvarC1ock11111111111111111111111111111111');
const councilRank = address('Vote111111111111111111111111111111111111111');

const writeModifier = (raw: Uint8Array, record: number, modifier: Parameters<typeof encoder.encode>[0]) => {
  raw.set(encoder.encode(modifier), 73 + record * 65 + 32);
};

test('derives the deployed CareerXpBudget PDA from Game and Character', async () => {
  assert.equal(
    await deriveCareerXpBudget(
      address('EKEj47SzaCjPM3m4T4vRXrrsVtkEmiNgPMMFye3AkXj4'),
      address('6YEfNTb74aiqj4m7PA5pfTPEBb8xYybuPkX9JmWXsYXP'),
    ),
    '5bVyKv6vXgBRyudtW7g3uVusELSsauCBNRSqEEAxs2Cq',
  );
});

test('derives the deployed XpBudgetConfig PDA from Game', async () => {
  assert.equal(
    await deriveXpBudgetConfig(address('EKEj47SzaCjPM3m4T4vRXrrsVtkEmiNgPMMFye3AkXj4')),
    'DH7x9Cm5rGRwficYVDmUmkVrFSjYYp47b8BYUHLXpLai',
  );
});

test('normalizes the direct base64 tuple returned by current Kit RPC clients', () => {
  assert.deepEqual(decodeBase64AccountData([Buffer.from([1, 2, 3]).toString('base64'), 'base64']), new Uint8Array([1, 2, 3]));
});

test('normalizes the nested legacy base64 account-data shape', () => {
  assert.deepEqual(decodeBase64AccountData({ data: [Buffer.from([4, 5]).toString('base64'), 'base64'] }), new Uint8Array([4, 5]));
});

test('rejects an unknown account-data shape', () => {
  assert.throws(() => decodeBase64AccountData({}), /not base64-readable/);
});

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
