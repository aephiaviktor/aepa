import assert from 'node:assert/strict';
import test from 'node:test';
import { TtlPromiseCache } from '../src/ttl-cache.js';

test('TTL cache reuses in-flight and resolved values until expiry', async () => {
  let now = 1_000;
  let loads = 0;
  const cache = new TtlPromiseCache<string, number>(100, () => now);
  const load = async () => ++loads;

  const [first, concurrent] = await Promise.all([
    cache.get('catalog', load),
    cache.get('catalog', load),
  ]);
  assert.equal(first, 1);
  assert.equal(concurrent, 1);
  assert.equal(await cache.get('catalog', load), 1);
  assert.equal(loads, 1);

  now = 1_101;
  assert.equal(await cache.get('catalog', load), 2);
  assert.equal(loads, 2);
});

test('TTL cache evicts a rejected load so the next read can recover', async () => {
  const cache = new TtlPromiseCache<string, number>(100, () => 1_000);
  let loads = 0;
  await assert.rejects(() => cache.get('catalog', async () => {
    loads += 1;
    throw new Error('temporary');
  }), /temporary/);
  assert.equal(await cache.get('catalog', async () => ++loads), 2);
});
