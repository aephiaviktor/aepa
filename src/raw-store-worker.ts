import { Worker } from 'node:worker_threads';
import type { RawTransactionStore, RawSubmission } from './raw-transaction-store.js';

export type RawStoreMethods = Pick<RawTransactionStore,
  'generation' | 'rotateGeneration' | 'beforeOperationSend' | 'resolveOperation' |
  'recordOutcome' | 'claimDue' | 'recordResponse' | 'health'>;
export type CaptureStore = { [K in keyof RawStoreMethods]:
  (...args: Parameters<RawStoreMethods[K]>) => ReturnType<RawStoreMethods[K]> | Promise<ReturnType<RawStoreMethods[K]>> };

/** One FIFO worker owns SQLite. A resolved write means SQLite committed, not just
 * that a message was queued. Worker death rejects every outstanding request. */
export class RawStoreWorker implements CaptureStore {
  private readonly worker: Worker;
  private sequence = 0;
  private closing = false;
  private failure?: Error;
  private closePromise?: Promise<void>;
  private readonly pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void}>();
  constructor(file: string) {
    this.worker = new Worker(new URL('./raw-store-worker-entry.js', import.meta.url), {workerData:{file}});
    this.worker.on('message', (reply: {id:number; value?:unknown; error?:string}) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.value);
    });
    this.worker.on('error', () => this.fail(new Error('Raw storage worker failed')));
    this.worker.on('exit', () => this.fail(new Error('Raw storage worker exited')));
  }
  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private dispatch(method: string, args: unknown[]): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve,reject) => {
      this.pending.set(id,{resolve,reject});
      try { this.worker.postMessage({id,method,args}); }
      catch { this.pending.delete(id); reject(new Error('Raw storage request failed')); }
    });
  }
  private call<K extends keyof RawStoreMethods>(method: K, ...args: Parameters<RawStoreMethods[K]>): Promise<ReturnType<RawStoreMethods[K]>> {
    if (this.closing) return Promise.reject(new Error('Raw storage worker is closed'));
    return this.dispatch(method,args) as Promise<ReturnType<RawStoreMethods[K]>>;
  }
  health(network:string,profile:string) { return this.call('health',network,profile); }
  generation(network:string) { return this.call('generation',network); }
  rotateGeneration(network:string) { return this.call('rotateGeneration',network); }
  beforeOperationSend(input:RawSubmission, scope:string) { return this.call('beforeOperationSend',input,scope); }
  resolveOperation(id:string) { return this.call('resolveOperation',id); }
  recordOutcome(id:string, outcome:'submitted'|'unknown') { return this.call('recordOutcome',id,outcome); }
  claimDue(network:string, now?:number) { return this.call('claimDue',network,now); }
  recordResponse(id:string,text:string) { return this.call('recordResponse',id,text); }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.dispatch('close',[]).then(() => undefined)
      .finally(async () => { await this.worker.terminate(); });
    return this.closePromise;
  }
}
