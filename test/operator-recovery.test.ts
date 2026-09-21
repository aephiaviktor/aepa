import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverPausedOperation } from '../src/operator-recovery.js';

test('operator recovery checks state and leaves automation disabled before clearing barrier', async () => {
  const calls:string[]=[];
  await recoverPausedOperation('finalized-success', {
    inspect:async()=>{calls.push('inspect');},
    disable:async()=>{calls.push('disable');},
    resolve:async()=>{calls.push('resolve');},
  });
  assert.deepEqual(calls,['inspect','disable','resolve']);
});
test('missing evidence or failed state inspection cannot clear barrier', async () => {
  const hooks={inspect:async()=>{throw new Error('state unavailable');},disable:async()=>assert.fail(),resolve:async()=>assert.fail()};
  await assert.rejects(recoverPausedOperation('missing',hooks),/finalized/);
  await assert.rejects(recoverPausedOperation('finalized-success',hooks),/state unavailable/);
});
