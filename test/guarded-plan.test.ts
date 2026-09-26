import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { blockhash, compileTransaction, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, createKeyPairSignerFromBytes, signTransaction, getBase64EncodedWireTransaction, getSignatureFromTransaction, type Signature } from '@solana/kit';
import { guardedPlanTransport, finishGuardedPlan } from '../src/guarded-plan.js';
import { isPostSubmissionFailure } from '../src/automatic-c4.js';
async function fixture() {
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const secret=new Uint8Array([...privateKey.export({format:'der',type:'pkcs8'}).subarray(-32),...publicKey.export({format:'der',type:'spki'}).subarray(-32)]);
  const signer=await createKeyPairSignerFromBytes(secret);
  const transaction=compileTransaction(setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash('11111111111111111111111111111111'),lastValidBlockHeight:1n},setTransactionMessageFeePayer(signer.address,createTransactionMessage({version:0}))));
  const signed=await signTransaction([signer.keyPair],transaction);
  return {wire:getBase64EncodedWireTransaction(signed),signature:getSignatureFromTransaction(signed)};
}
test('SDK transport simulates signed wire then durably records before exactly one non-retrying send', async () => {
  const {wire,signature}=await fixture(); const events:string[]=[];
  const rpc={simulateTransaction(_wire:unknown,config:unknown) {assert.equal(_wire,wire); assert.deepEqual(config,{commitment:'confirmed',encoding:'base64',sigVerify:true,replaceRecentBlockhash:false}); return {send:async()=>{events.push('simulate');return {context:{slot:1n},value:{err:null,logs:[]}};}};},
    sendTransaction(_wire:unknown,config:unknown) {assert.equal(_wire,wire);assert.deepEqual(config,{encoding:'base64',skipPreflight:true,maxRetries:0n});return {send:async()=>{events.push('send');return signature;}};}};
  const recorder={beforeSend:async(value:{wire:string;signature:string})=>{assert.deepEqual(value,{wire,signature});events.push('durable');},afterSend:async()=>{events.push('submitted');},complete:async()=>{events.push('complete');}};
  await guardedPlanTransport(rpc,recorder,()=>events.push('boundary')).sendTransaction(wire).send();
  assert.deepEqual(events,['simulate','durable','boundary','send','submitted']);
});
test('simulation and durable-storage failures submit nothing',async()=>{
  const {wire}=await fixture(); let sends=0;
  for(const failure of ['simulation','storage']) {
    const rpc={simulateTransaction(){return {send:async()=>({context:{slot:1n},value:{err:failure==='simulation'?{}:null,logs:[]}})};},sendTransaction(){sends++;return {send:async()=>''};}};
    const recorder={beforeSend:async()=>{throw new Error('storage failure');},afterSend:async()=>{},complete:async()=>{}};
    await assert.rejects(()=>guardedPlanTransport(rpc,recorder,()=>{}).sendTransaction(wire).send());
  }
  assert.equal(sends,0);
});
test('ambiguous send retains unresolved evidence and cannot be auto-retried',async()=>{
  const {wire}=await fixture();let sends=0;let outcome='';let completed=false;
  const rpc={simulateTransaction(){return {send:async()=>({context:{slot:1n},value:{err:null,logs:[]}})};},sendTransaction(){return {send:async()=>{sends++;throw new Error('lost connection');}};}};
  const recorder={beforeSend:async()=>{},afterSend:async(value:string)=>{outcome=value;},complete:async()=>{completed=true;}};
  await assert.rejects(()=>guardedPlanTransport(rpc,recorder,()=>{}).sendTransaction(wire).send(),error=>isPostSubmissionFailure(String(error)));
  assert.equal(sends,1);assert.equal(outcome,'unknown');assert.equal(completed,false);
});
test('post-state mismatch/read failure/DB completion failure remain unknown barriers; only observed success completes',async()=>{
  const result={status:'confirmed' as const,signature:'sig' as Signature,slot:1n,commitment:'confirmed' as const};
  for (const failure of ['mismatch','read','storage']) {
    let completes=0;
    const recorder={beforeSend:async()=>{},afterSend:async()=>{},complete:async()=>{completes++;if(failure==='storage')throw new Error('db');}};
    await assert.rejects(()=>finishGuardedPlan(result,async()=>{if(failure==='read')throw new Error('read');return failure==='storage';},recorder,async()=>{},1),error=>isPostSubmissionFailure(String(error)));
    assert.equal(completes,failure==='storage'?1:0);
  }
  let completes=0;
  await finishGuardedPlan(result,async()=>true,{beforeSend:async()=>{},afterSend:async()=>{},complete:async()=>{completes++;}},async()=>{},1);
  assert.equal(completes,1);
});

test('unknown SDK execution never clears a barrier or treats a fresh snapshot as confirmation',async()=>{
  let reads=0,completes=0;
  await assert.rejects(()=>finishGuardedPlan({status:'unknown',signature:'sig' as Signature,reason:'timeout',lastCheckedBlockHeight:1n,lastValidBlockHeight:2n},async()=>{reads++;return true;},{beforeSend:async()=>{},afterSend:async()=>{},complete:async()=>{completes++;}},async()=>{},1),error=>isPostSubmissionFailure(String(error)));
  assert.equal(reads,0);assert.equal(completes,0);
});
