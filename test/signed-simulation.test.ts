import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  address,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Base64EncodedWireTransaction,
} from '@solana/kit';
import { encodeBase58 } from '../src/signer-store.js';
import { signAndSendTransactionOnce, signAndSimulateTransaction } from '../src/signed-simulation.js';

function signerSecret(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return new Uint8Array([
    ...privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    ...publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]);
}

function unsignedTransaction(feePayer: string) {
  const message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 1n },
    setTransactionMessageFeePayer(address(feePayer), createTransactionMessage({ version: 0 })),
  );
  return compileTransaction(message);
}

test('signs with the expected authority and simulates with signature verification without sending', async () => {
  const secret = signerSecret();
  const authority = encodeBase58(secret.subarray(32));
  let simulateCalls = 0;
  let capturedConfig: unknown;
  let capturedWire: Base64EncodedWireTransaction | undefined;
  const rpc = {
    simulateTransaction(wire: Base64EncodedWireTransaction, config: unknown) {
      simulateCalls += 1;
      capturedWire = wire;
      capturedConfig = config;
      return { send: async () => ({ context: { slot: 44n }, value: { err: null, logs: ['signature verified'], unitsConsumed: 123n, returnData: null } }) };
    },
  };

  const result = await signAndSimulateTransaction(rpc, unsignedTransaction(authority), secret, authority);
  assert.equal(simulateCalls, 1);
  assert.ok(capturedWire);
  assert.deepEqual(capturedConfig, { commitment: 'confirmed', encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false });
  assert.equal(result.signatureVerified, true);
  assert.equal(result.submitted, false);
  assert.equal(result.slot, 44n);
  assert.equal(result.unitsConsumed, 123n);
  assert.match(result.signature, /^[1-9A-HJ-NP-Za-km-z]+$/);
});

test('rejects a signer-authority mismatch before RPC simulation', async () => {
  const secret = signerSecret();
  const authority = encodeBase58(secret.subarray(32));
  let called = false;
  const rpc = { simulateTransaction() { called = true; throw new Error('must not run'); } };
  await assert.rejects(() => signAndSimulateTransaction(rpc, unsignedTransaction(authority), secret, '11111111111111111111111111111111'), /does not match/);
  assert.equal(called, false);
});

test('submits exactly one non-retrying transaction with no simulation and no RPC preflight', async () => {
  const secret = signerSecret();
  const authority = encodeBase58(secret.subarray(32));
  const calls: string[] = [];
  const progress: string[] = [];
  let sendConfig: unknown;
  const rpc = {
    simulateTransaction() {
      calls.push('simulate');
      throw new Error('must not be called');
    },
    sendTransaction(wire: Base64EncodedWireTransaction, config: unknown) {
      calls.push('send');
      sendConfig = config;
      const signature = encodeBase58(Buffer.from(wire, 'base64').subarray(1, 65));
      return { send: async () => signature };
    },
  };
  const result = await signAndSendTransactionOnce(rpc, unsignedTransaction(authority), secret, authority, (stage) => progress.push(stage));
  assert.deepEqual(calls, ['send']);
  assert.deepEqual(progress, ['signer-verified', 'transaction-signed', 'send-starting', 'send-returned']);
  assert.deepEqual(sendConfig, { encoding: 'base64', skipPreflight: true, maxRetries: 0n });
  assert.match(result.signature, /^[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(result.submitted, true);
});

test('send-only path rejects a signer-authority mismatch before any RPC call', async () => {
  const secret = signerSecret();
  const authority = encodeBase58(secret.subarray(32));
  let called = false;
  const rpc = { sendTransaction() { called = true; throw new Error('must not run'); } };
  await assert.rejects(() => signAndSendTransactionOnce(rpc, unsignedTransaction(authority), secret, '11111111111111111111111111111111'), /does not match/);
  assert.equal(called, false);
});