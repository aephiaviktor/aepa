import {
  createKeyPairSignerFromBytes,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransaction,
  type Base64EncodedWireTransaction,
  type Transaction,
} from '@solana/kit';

export interface SignedSimulationRpc {
  simulateTransaction(
    transaction: Base64EncodedWireTransaction,
    config: {
      commitment: 'confirmed';
      encoding: 'base64';
      sigVerify: true;
      replaceRecentBlockhash: false;
    },
  ): {
    send(): Promise<{
      context: { slot: bigint };
      value: {
        err: unknown | null;
        logs: readonly string[] | null;
        unitsConsumed?: bigint;
        returnData?: unknown | null;
      };
    }>;
  };
}

export interface SingleSendRpc extends SignedSimulationRpc {
  sendTransaction(
    transaction: Base64EncodedWireTransaction,
    config: {
      encoding: 'base64';
      skipPreflight: false;
      preflightCommitment: 'confirmed';
      maxRetries: 0n;
      minContextSlot: bigint;
    },
  ): { send(): Promise<string> };
}

export interface SignedSimulationResult {
  signature: string;
  signatureVerified: true;
  slot: bigint;
  unitsConsumed: bigint | undefined;
  logs: readonly string[];
  submitted: false;
}

export interface SingleSendResult extends Omit<SignedSimulationResult, 'submitted'> {
  submitted: true;
}

export class SignedSimulationFailedError extends Error {
  readonly transactionError: unknown;
  readonly logs: readonly string[];

  constructor(transactionError: unknown, logs: readonly string[]) {
    super('The signed transaction simulation failed; nothing was submitted');
    this.name = 'SignedSimulationFailedError';
    this.transactionError = transactionError;
    this.logs = logs;
  }
}

/** Signs one already-assembled transaction and invokes only simulateTransaction.
 * Source: https://solana.com/docs/rpc/http/simulatetransaction
 * sigVerify=true requires the signed transaction's original recent blockhash, so
 * replaceRecentBlockhash must remain false.
 */
export async function signAndSimulateTransaction(
  rpc: SignedSimulationRpc,
  transaction: Transaction,
  secretKey: Uint8Array,
  expectedAuthority: string,
): Promise<SignedSimulationResult> {
  const signer = await createKeyPairSignerFromBytes(secretKey);
  if (signer.address !== expectedAuthority) throw new Error('Stored signer does not match the active C4 Player Profile authority');

  const signedTransaction = await signTransaction([signer.keyPair], transaction);
  const response = await rpc.simulateTransaction(getBase64EncodedWireTransaction(signedTransaction), {
    commitment: 'confirmed',
    encoding: 'base64',
    sigVerify: true,
    replaceRecentBlockhash: false,
  }).send();
  const logs = Object.freeze([...(response.value.logs ?? [])]);
  if (response.value.err !== null) throw new SignedSimulationFailedError(response.value.err, logs);
  return Object.freeze({
    signature: getSignatureFromTransaction(signedTransaction),
    signatureVerified: true,
    slot: response.context.slot,
    unitsConsumed: response.value.unitsConsumed,
    logs,
    submitted: false,
  });
}

/** Signs, verifies by simulation, then makes exactly one client submission call.
 * maxRetries=0 also prevents the RPC node from retrying it on our behalf. The
 * caller must never resubmit after an ambiguous response.
 * Sources: https://solana.com/docs/rpc/http/sendtransaction
 *          https://solana.com/docs/rpc/http/getsignaturestatuses
 */
export async function signSimulateAndSendTransactionOnce(
  rpc: SingleSendRpc,
  transaction: Transaction,
  secretKey: Uint8Array,
  expectedAuthority: string,
  onProgress?: (stage: string, details?: Readonly<Record<string, string>>) => void,
): Promise<SingleSendResult> {
  const signer = await createKeyPairSignerFromBytes(secretKey);
  if (signer.address !== expectedAuthority) throw new Error('Stored signer does not match the active C4 Player Profile authority');
  onProgress?.('signer-verified');

  const signedTransaction = await signTransaction([signer.keyPair], transaction);
  const wire = getBase64EncodedWireTransaction(signedTransaction);
  const signature = getSignatureFromTransaction(signedTransaction);
  onProgress?.('transaction-signed', { signature });
  const simulation = await rpc.simulateTransaction(wire, {
    commitment: 'confirmed',
    encoding: 'base64',
    sigVerify: true,
    replaceRecentBlockhash: false,
  }).send();
  const logs = Object.freeze([...(simulation.value.logs ?? [])]);
  if (simulation.value.err !== null) throw new SignedSimulationFailedError(simulation.value.err, logs);
  onProgress?.('simulation-passed', { signature, slot: simulation.context.slot.toString() });

  onProgress?.('send-starting', { signature });
  const returnedSignature = await rpc.sendTransaction(wire, {
    encoding: 'base64',
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 0n,
    minContextSlot: simulation.context.slot,
  }).send();
  onProgress?.('send-returned', { signature: returnedSignature });
  if (returnedSignature !== signature) throw new Error('RPC returned a transaction signature different from the signed transaction');
  return Object.freeze({
    signature,
    signatureVerified: true,
    slot: simulation.context.slot,
    unitsConsumed: simulation.value.unitsConsumed,
    logs,
    submitted: true,
  });
}
