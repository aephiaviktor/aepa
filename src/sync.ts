import type { AepaDatabase } from './database.js';

export interface SyncLoadResult {
  chainSlot?: string;
}

export interface SyncCoordinatorOptions<T> {
  database: AepaDatabase;
  getProfile: () => string;
  getIntervalMs: () => number;
  load: () => Promise<T>;
  begin: (profile: string, startedAt: string) => void;
  publish: (profile: string, result: T, meta: { startedAt: string; succeededAt: string }) => void;
  fail: (profile: string, error: string, failedAt: string) => void;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export class SyncCoordinator<T> {
  protected inFlight?: Promise<T>;
  private inFlightScope?: string;
  protected timer?: NodeJS.Timeout;
  private stopped = true;
  private consecutiveFailures = 0;
  protected readonly now: () => Date;
  private readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;

  constructor(protected readonly options: SyncCoordinatorOptions<T>) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  refresh(): Promise<T> {
    const profile = this.options.getProfile();
    if (this.inFlight) {
      if (this.inFlightScope === profile) return this.inFlight;
      return this.inFlight.catch(() => undefined).then(() => this.refresh());
    }
    const startedAt = this.now().toISOString();
    this.options.begin(profile, startedAt);
    const run = this.options.load().then((result) => {
      this.options.publish(profile, result, { startedAt, succeededAt: this.now().toISOString() });
      return result;
    }).catch((error) => {
      this.options.fail(profile, String((error as Error)?.message ?? error), this.now().toISOString());
      throw error;
    }).finally(() => {
      this.inFlight = undefined;
      this.inFlightScope = undefined;
    });
    this.inFlight = run;
    this.inFlightScope = profile;
    return run;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = this.setTimer(() => {
      const intervalMs = Math.max(this.options.getIntervalMs(), 15_000);
      void this.refresh().then(() => {
        this.consecutiveFailures = 0;
        this.schedule(intervalMs);
      }).catch(() => {
        this.consecutiveFailures += 1;
        const backoff = Math.min(intervalMs, 60_000 * Math.pow(2, this.consecutiveFailures - 1));
        this.schedule(Math.max(Math.trunc(backoff), 1_000));
      });
    }, delayMs);
  }
}