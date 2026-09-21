import test from 'node:test';
import assert from 'node:assert/strict';
import { RawStoreWorker } from '../src/raw-store-worker.js';

test('worker serializes durable barriers and drains accepted writes before close', async () => {
  const worker = new RawStoreWorker(':memory:');
  const generation = await worker.generation('ptr');
  const input = {network:'ptr',profile:'p',resetEpoch:generation,signature:'sig',wire:'AQ=='};
  const id = await worker.beforeOperationSend(input,'fleet');
  await assert.rejects(worker.beforeOperationSend({...input,signature:'other'},'fleet'), /must not be resubmitted/);
  const outcome = worker.recordOutcome(id,'submitted');
  await worker.close();
  await outcome;
  await assert.rejects(worker.generation('ptr'), /closed/);
});

test('worker retains raw response precision and frees operation barrier only explicitly', async () => {
  const worker = new RawStoreWorker(':memory:');
  try {
    const id = await worker.beforeOperationSend({network:'ptr',profile:'p',resetEpoch:'1',signature:'sig',wire:'AQ=='},'fleet');
    await worker.recordResponse(id,'{"result":{"slot":9007199254740993,"transaction":["AQ==","base64"],"meta":{}}}');
    assert.equal(await worker.claimDue('ptr'),undefined);
    await worker.resolveOperation(id);
    await worker.beforeOperationSend({network:'ptr',profile:'p',resetEpoch:'1',signature:'next',wire:'AQ=='},'fleet');
  } finally { await worker.close(); }
});

test('worker startup failure rejects requests rather than leaving a send waiting', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(),'raw-worker-error-'));
  const worker = new RawStoreWorker(dir); // a directory is not a database file
  try { await assert.rejects(worker.generation('ptr'), /worker/); }
  finally { await worker.close().catch(() => {}); rmSync(dir,{recursive:true,force:true}); }
});

test('SQLite lock wait occurs in worker while main-thread timers keep running', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(),'raw-worker-lock-'));
  const file = join(dir,'raw.sqlite');
  const worker = new RawStoreWorker(file);
  await worker.generation('ptr');
  const lock = new DatabaseSync(file);
  lock.exec('BEGIN IMMEDIATE');
  let timerRan=false;
  const timer = setTimeout(() => { timerRan=true; lock.exec('COMMIT'); },100);
  try {
    await worker.beforeOperationSend({network:'ptr',profile:'p',resetEpoch:'1',signature:'sig',wire:'AQ=='},'fleet');
    assert.equal(timerRan,true);
  } finally { clearTimeout(timer); await worker.close(); lock.close(); rmSync(dir,{recursive:true,force:true}); }
});
