import test from 'node:test';
import assert from 'node:assert/strict';
import { RawTransactionStore } from '../src/raw-transaction-store.js';
import { collectRawTransactions } from '../src/raw-transaction-collector.js';

test('collector stores untouched finalized RPC response and requests base64 wire data', async () => {
  const store = new RawTransactionStore(':memory:');
  const id = store.beforeSend({ network: 'ptr', resetEpoch: '1', profile: 'p', signature: 'sig', wire: 'AQ==' });
  const text = '{"result":{"slot":9007199254740993,"transaction":["AQ==","base64"],"meta":{}}}';
  await collectRawTransactions(store, async (signature, options) => {
    assert.equal(signature, 'sig'); assert.equal(options.encoding, 'base64'); assert.equal(options.commitment, 'finalized');
    return text;
  });
  assert.deepEqual(store.responses(id), [text]);
  assert.equal(store.pending().length, 0);
  store.close();
});

test('collector leaves failed requests pending without blocking other records', async () => {
  const store = new RawTransactionStore(':memory:');
  for (const signature of ['a','b']) store.beforeSend({ network:'ptr', resetEpoch:'1', profile:'p', signature, wire:'AQ==' });
  const result = await collectRawTransactions(store, async () => { throw new Error('endpoint credential must not be saved'); });
  assert.equal(result.unavailable, 2);
  assert.equal(store.pending().length, 2);
  store.close();
});
