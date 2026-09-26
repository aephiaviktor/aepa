import { executePlan, type Plan, type PlanExecutionResult } from '@aephia/atlas-kit/planning';
import type { SageContext, SageWriteRpc } from '@aephia/atlas-kit/client';
import { createKeyPairSignerFromBytes, createSolanaRpc, getTransactionDecoder, getSignatureFromTransaction, type Base64EncodedWireTransaction } from '@solana/kit';
import { rawRecorderFor, type OperationRecorder } from './raw-capture-runtime.js';
import { sendSignedWireOnce, SignedSimulationFailedError, type SignedSimulationRpc, type SendOnlyRpc } from './signed-simulation.js';
import type { AppSettings } from './settings.js';

/** SDK execution performs its fresh precondition revalidation before signing.
 * This transport adds AEPA's signature-verified simulation and the same durable
 * raw-before-send barrier used by mining. No opaque wallet/sending signer. */
export function guardedPlanTransport(rpc: SignedSimulationRpc & SendOnlyRpc, recorder: OperationRecorder, onSubmission: () => void) {
  return {
    sendTransaction(wire: Base64EncodedWireTransaction) {
      return {send: async () => {
        const simulation = await rpc.simulateTransaction(wire, {commitment:'confirmed',encoding:'base64',sigVerify:true,replaceRecentBlockhash:false}).send();
        if (simulation.value.err !== null) throw new SignedSimulationFailedError(simulation.value.err, simulation.value.logs ?? []);
        const signature = getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(wire,'base64')));
        const outcome = await sendSignedWireOnce(rpc,wire,signature,stage => {
          if (stage === 'send-starting') onSubmission();
        },recorder);
        return outcome.signature;
      }};
    },
  };
}

export async function finishGuardedPlan(result: PlanExecutionResult, observe: () => Promise<boolean>, recorder: OperationRecorder, poll: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve,1_000)), attempts = 45): Promise<{signature:string;slot:bigint}> {
  try {
    if (result.status !== 'confirmed') throw new Error('Unknown execution outcome');
    for (let i=0;i<attempts;i++) {
      if (await observe()) {
        await recorder.complete();
        return {signature:result.signature,slot:result.slot};
      }
      await poll();
    }
    throw new Error('Confirmed post-state was not observed');
  } catch {
    throw new Error(`Transaction ${result.signature} was submitted once but confirmation or resulting state was not observed; it must not be resubmitted`);
  }
}

export async function executeGuardedPlan(input: {
  settings: AppSettings; context: SageContext; rpc: ReturnType<typeof createSolanaRpc>;
  plan: Plan; authority: string; secretKey: Uint8Array; fleetAddress: string;
  observeConfirmed(): Promise<boolean>;
}): Promise<{signature: string; slot: bigint}> {
  const signer = await createKeyPairSignerFromBytes(input.secretKey);
  if (signer.address !== input.authority) throw new Error('Stored signer does not match active Profile authority');
  const recorder = rawRecorderFor(input.settings, `fleet:${input.fleetAddress}`);
  let submitted = false;
  let gateFailure: unknown;
  const transport = guardedPlanTransport(input.rpc,recorder,() => {submitted = true;});
  // Forward read/confirmation RPCs unchanged; replace only the write boundary.
  const writeRpc = new Proxy(input.rpc, {get(target,key) {
    if (key !== 'sendTransaction') return Reflect.get(target,key);
    return (wire: Base64EncodedWireTransaction) => ({send: async () => {
      try { return await transport.sendTransaction(wire).send(); }
      catch(error) { gateFailure = error; throw error; }
    }});
  }}) as SageWriteRpc;
  let result: PlanExecutionResult;
  try {
    result = await executePlan({...input.context,writeRpc},input.plan,{feePayer:signer,commitment:'confirmed',timeoutMs:90_000,pollIntervalMs:1_000});
  } catch(error) {
    if (submitted) throw new Error('Submitted scanning transaction requires reconciliation; it must not be resubmitted');
    throw gateFailure ?? error;
  }
  // SDK maps transport exceptions to unknown, including a failed pre-send gate.
  if (gateFailure && !submitted) throw gateFailure;
  return finishGuardedPlan(result,input.observeConfirmed,recorder);
}
