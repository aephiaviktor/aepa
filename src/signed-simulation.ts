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

export interface SendOnlyRpc {
  sendTransaction(
    transaction: Base64EncodedWireTransaction,
    config: {
      encoding: 'base64';
      skipPreflight: true;
      maxRetries: 0n;
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

export interface SingleSendResult {
  signature: string;
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

/** Signs one already-assembled transaction and submits it exactly once without
 * any client-side or node-preflight simulation. maxRetries=0 prevents the RPC
 * node from retrying the transaction on our behalf. On-chain failure surfaces
 * through confirmation polling after submission. The caller must never
 * resubmit after an ambiguous response.
 * Source: https://solana.com/docs/rpc/http/sendtransaction
 */
export async function signAndSendTransactionOnce(
  rpc: SendOnlyRpc,
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

  onProgress?.('send-starting', { signature });
  const returnedSignature = await rpc.sendTransaction(wire, {
    encoding: 'base64',
    skipPreflight: true,
    maxRetries: 0n,
  }).send();
  onProgress?.('send-returned', { signature: returnedSignature });
  if (returnedSignature !== signature) throw new Error('RPC returned a transaction signature different from the signed transaction');
  return Object.freeze({ signature, submitted: true } as const);
}