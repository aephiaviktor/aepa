import test from 'node:test';
import assert from 'node:assert/strict';
import { RawTransactionStore } from '../src/raw-transaction-store.js';

test('raw archive preserves exact response bytes and durable pending work', () => {
  const store = new RawTransactionStore(':memory:');
  const raw = '{"result":{"slot":9007199254740993,"futureField":{"x":1},"transaction":["AQ==","base64"],"meta":{}},"id":1}';
  const id = store.beforeSend({ network: 'ptr', resetEpoch: 'epoch', profile: 'p', signature: 'sig', wire: 'AQ==' });
  assert.equal(store.pending()[0]?.signature, 'sig');
  store.recordResponse(id, raw);
  assert.equal(store.responses(id)[0], raw);
  assert.equal(store.pending().length, 0);
  assert.equal(store.recordResponse(id, raw), false);
  store.close();
});

test('missing transaction response is retained but does not complete collection', () => {
  const store = new RawTransactionStore(':memory:');
  const id = store.beforeSend({ network: 'ptr', resetEpoch: 'epoch', profile: 'p', signature: 'sig', wire: 'AQ==' });
  store.recordResponse(id, '{"result":null}');
  assert.equal(store.pending().length, 1);
  assert.throws(() => store.beforeSend({ network: 'ptr', resetEpoch: 'epoch', profile: 'other', signature: 'sig', wire: 'Ag==' }), /different/);
  store.close();
});

test('pending signed bytes survive restart and network/reset identities stay separate', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'aepa-raw-'));
  try {
    const file = join(dir, 'raw.sqlite');
    const first = new RawTransactionStore(file);
    for (const resetEpoch of ['one', 'two']) first.beforeSend({ network:'ptr',resetEpoch,profile:'p',signature:'sig',wire:'AQ==' });
    first.close();
    const second = new RawTransactionStore(file);
    assert.equal(second.pending().length, 2);
    assert.ok(second.pending().every(row => row.wire === 'AQ=='));
    second.close();
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('an unrelated RPC transaction cannot complete the pending record', () => {
  const store = new RawTransactionStore(':memory:');
  const id = store.beforeSend({ network:'ptr',resetEpoch:'one',profile:'p',signature:'sig',wire:'AQ==' });
  store.recordResponse(id, '{"result":{"transaction":["Ag==","base64"],"meta":{}}}');
  assert.equal(store.pending().length, 1);
  store.close();
});

test('local capture generations are durable namespaces, not claimed chain reset identifiers', async () => {
  const store = new RawTransactionStore(':memory:');
  const first = store.generation('ptr');
  assert.match(first, /^local-generation:/);
  assert.equal(store.generation('ptr'), first);
  assert.notEqual(store.rotateGeneration('ptr'), first);
  store.close();
});

test('durable retry claims are fair and scoped by network', () => {
  const store = new RawTransactionStore(':memory:');
  for (const signature of ['a','b']) store.beforeSend({network:'ptr',resetEpoch:'one',profile:'p',signature,wire:'AQ=='});
  store.beforeSend({network:'other',resetEpoch:'one',profile:'p',signature:'c',wire:'AQ=='});
  const first = store.claimDue('ptr', 1000)!;
  const second = store.claimDue('ptr', 1000)!;
  assert.notEqual(first.id, second.id);
  assert.equal(store.claimDue('ptr', 1000), undefined);
  assert.ok(store.claimDue('ptr', 61000));
  store.close();
});
