import { parentPort, workerData } from 'node:worker_threads';
import { RawTransactionStore } from './raw-transaction-store.js';

const port = parentPort;
if (!port) throw new Error('Raw store requires a worker');
const store = new RawTransactionStore(workerData.file as string);
// Explicit allowlist: this port is internal, never exposed over IPC to renderers.
const methods = new Set(['generation','rotateGeneration','beforeOperationSend','resolveOperation','recordOutcome','claimDue','recordResponse','health','inspectRecovery','close']);
port.on('message', ({id,method,args}: {id:number;method:string;args:unknown[]}) => {
  try {
    if (!methods.has(method)) throw new Error('Unknown method');
    const fn = store[method as keyof RawTransactionStore] as (...args: unknown[]) => unknown;
    const value = fn.apply(store,args);
    port.postMessage({id,value});
  } catch (error) {
    const blocked = error instanceof Error && error.message.includes('must not be resubmitted');
    port.postMessage({id,error:blocked
      ? 'Unresolved transaction for this operation; it must not be resubmitted'
      : 'Raw storage operation failed'});
  }
});
