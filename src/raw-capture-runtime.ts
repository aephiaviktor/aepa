import type { AppSettings } from './settings.js';
import type { RawSendRecorder } from './signed-simulation.js';
import type { CaptureStore } from './raw-store-worker.js';

export interface OperationRecorder extends RawSendRecorder { complete(): Promise<void> }

type FetchRaw = (url: string, init: RequestInit) => Promise<Response>;
let activeRuntime: RawCaptureRuntime | undefined;
export function configureRawCapture(runtime: RawCaptureRuntime): void { activeRuntime = runtime; }
export function rawRecorderFor(settings: AppSettings, scope: string): OperationRecorder {
  if (!activeRuntime) throw new Error('Raw transaction recorder is not initialized; nothing submitted');
  return activeRuntime.recorder(settings, scope);
}

/** Endpoint credentials stay in memory. Only public transaction facts enter SQLite.
 * Local generations are provenance boundaries, NOT authoritative chain reset IDs. */
export class RawCaptureRuntime {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private controller?: AbortController;
  private endpointNotBefore = 0;
  constructor(
    private readonly store: CaptureStore,
    private readonly settings: () => AppSettings,
    private readonly request: FetchRaw = fetch,
    private readonly report: (message: string) => void = () => {},
  ) {}

  recorder(settings: AppSettings, scope = 'profile'): OperationRecorder {
    const context = { network: settings.network, profile: settings.playerProfile };
    let id: string | undefined;
    return {
      beforeSend: async ({ wire, signature }) => {
        if (this.stopped) throw new Error('Raw capture is stopped; nothing submitted');
        const resetEpoch = await this.store.generation(context.network);
        if (this.stopped) throw new Error('Raw capture is stopped; nothing submitted');
        id = await this.store.beforeOperationSend({ ...context, resetEpoch, wire, signature }, scope);
        if (this.stopped) throw new Error('Raw capture is stopped; nothing submitted');
      },
      complete: async () => {
        if (!id) throw new Error('Missing operation record');
        await this.store.resolveOperation(id);
      },
      afterSend: async outcome => {
        if (!id) throw new Error('Missing pre-send raw record');
        await this.store.recordOutcome(id, outcome);
      },
    };
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, 5_000);
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.collect().catch(() => {
      // Never leak a fetch/SQLite exception containing endpoints or response data.
      this.report('Raw transaction evidence collection failed; pending records retained');
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async collect(): Promise<void> {
    for (let i = 0; i < 20 && !this.stopped && Date.now() >= this.endpointNotBefore; i++) {
      const settings = this.settings();
      const row = await this.store.claimDue(settings.network);
      if (!row || this.stopped) return;
      this.controller = new AbortController();
      const timeout = setTimeout(() => this.controller?.abort(), 10_000);
      let text: string;
      try {
        const response = await this.request(settings.rpcUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getTransaction', params:[row.signature, {
            encoding:'base64', commitment:'finalized', maxSupportedTransactionVersion:0,
          }] }), signal: this.controller.signal,
        });
        if (response.status === 429 || response.status === 503) {
          const retry = response.headers.get('retry-after');
          const seconds = retry === null ? NaN : Number(retry);
          const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry ?? '');
          this.endpointNotBefore = Math.max(Date.now() + 30_000, Number.isFinite(until) ? until : 0);
          return;
        }
        if (!response.ok) return;
        text = await response.text();
        // Do not archive arbitrary HTML/error pages that may echo endpoint credentials.
        const envelope = JSON.parse(text) as { result?: unknown; error?: unknown } | null;
        if (!envelope || typeof envelope !== 'object' || envelope.error || !('result' in envelope)) continue;
      } catch { return; }
      finally { clearTimeout(timeout); this.controller = undefined; }
      // A DB write failure reaches the supervisor; it is not an RPC miss.
      await this.store.recordResponse(row.id, text);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.running;
    // App shutdown may still have a send unwinding. Do not close its SQLite handle
    // here; OS process teardown closes it after durable FULL/WAL writes.
  }
}
