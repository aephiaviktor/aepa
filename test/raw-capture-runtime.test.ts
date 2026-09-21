import test from 'node:test';
import assert from 'node:assert/strict';
import { RawTransactionStore } from '../src/raw-transaction-store.js';
import { RawCaptureRuntime } from '../src/raw-capture-runtime.js';

const settings = { network: 'zink-ptr' as const, rpcUrl: 'https://example.invalid/private', playerProfile: 'p', refreshIntervalSeconds: 60 };

test('runtime records before send and replays pending collection after restart', async () => {
  const store = new RawTransactionStore(':memory:');
  const runtime = new RawCaptureRuntime(store, () => settings, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).params[0], 'sig');
    return new Response('{"result":{"transaction":["AQ==","base64"],"meta":{},"slot":9007199254740993}}');
  });
  const recorder = runtime.recorder(settings);
  await recorder.beforeSend({ signature: 'sig', wire: 'AQ==' });
  assert.equal(store.pending().length, 1);
  await recorder.afterSend('unknown');
  await runtime.tick();
  assert.equal(store.pending().length, 0);
  await runtime.stop();
  store.close();
});

test('collector is single-flight, network scoped and stop aborts its request', async () => {
  const store = new RawTransactionStore(':memory:');
  store.beforeSend({ network:'other',resetEpoch:'x',profile:'p',signature:'other',wire:'AQ==' });
  let requests=0;
  const runtime = new RawCaptureRuntime(store, () => settings, async (_url, init) => {
    requests++;
    return new Promise<Response>((_resolve,reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once:true}));
  });
  await runtime.recorder(settings).beforeSend({signature:'sig',wire:'AQ=='});
  const first=runtime.tick(); const second=runtime.tick();
  await runtime.stop(); await Promise.all([first,second]);
  assert.equal(requests,1);
  assert.equal(store.pending().length,2);
  await assert.rejects(() => runtime.recorder(settings).beforeSend({signature:'later',wire:'AQ=='}), /stopped/);
  store.close();
});

test('both production send sites require raw capture and Electron starts the collector', async () => {
  const { readFileSync } = await import('node:fs');
  const c4 = readFileSync(new URL('../../src/c4.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8');
  assert.equal((c4.match(/onProgress, rawRecorderFor\(settings\)/g) ?? []).length, 2);
  assert.match(main, /configureRawCapture\(rawCapture\)/);
  assert.match(main, /rawCapture\.start\(\)/);
  assert.match(main, /rotateGeneration/);
});

test('rate limits stop the batch and honor Retry-After on subsequent ticks', async () => {
  const store = new RawTransactionStore(':memory:');
  let requests = 0;
  const runtime = new RawCaptureRuntime(store, () => settings, async () => {
    requests++;
    return new Response('', { status:429, headers:{ 'Retry-After':'120' } });
  });
  for (const signature of ['a','b']) await runtime.recorder(settings).beforeSend({signature,wire:'AQ=='});
  await runtime.tick(); await runtime.tick();
  assert.equal(requests,1);
  assert.equal(store.pending().length,2);
  await runtime.stop(); store.close();
});

test('fresh runtime recovers durable records without signing or resending', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'aepa-runtime-'));
  try {
    const file = join(dir, 'raw.sqlite');
    const first = new RawTransactionStore(file);
    const oldRuntime = new RawCaptureRuntime(first, () => settings);
    await oldRuntime.recorder(settings).beforeSend({signature:'sig',wire:'AQ=='});
    const generation = first.generation(settings.network);
    await oldRuntime.stop(); first.close();
    const second = new RawTransactionStore(file);
    assert.equal(second.generation(settings.network), generation);
    const resumed = new RawCaptureRuntime(second, () => settings, async (_url, init) => {
      assert.equal(JSON.parse(String(init.body)).method,'getTransaction');
      return new Response('{"result":{"transaction":["AQ==","base64"],"meta":{}}}');
    });
    await resumed.tick();
    assert.equal(second.pending().length,0);
    await resumed.stop(); second.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
