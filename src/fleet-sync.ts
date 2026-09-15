import type { AepaDatabase, FleetRecord } from './database.js';
import { SyncCoordinator, type SyncCoordinatorOptions, type SyncLoadResult } from './sync.js';

export interface FleetSyncLoadResult extends SyncLoadResult {
  fleets: FleetRecord[];
}

export interface FleetSyncCoordinatorOptions<T extends FleetSyncLoadResult = FleetSyncLoadResult> {
  database: AepaDatabase;
  getProfile: () => string;
  getIntervalMs: () => number;
  load: () => Promise<T>;
  toPayload?: (result: T) => unknown;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export class FleetSyncCoordinator<T extends FleetSyncLoadResult = FleetSyncLoadResult> extends SyncCoordinator<T> {
  constructor(options: FleetSyncCoordinatorOptions<T>) {
    const internal: SyncCoordinatorOptions<T> = {
      database: options.database,
      getProfile: options.getProfile,
      getIntervalMs: options.getIntervalMs,
      load: options.load,
      begin: (profile, startedAt) => options.database.beginFleetSync(profile, startedAt),
      publish: (profile, result, meta) => {
        options.database.completeFleetSync(profile, result.fleets, {
          startedAt: meta.startedAt,
          succeededAt: meta.succeededAt,
          ...(result.chainSlot === undefined ? {} : { chainSlot: result.chainSlot }),
          ...(options.toPayload === undefined ? {} : { payload: options.toPayload(result) }),
        });
      },
      fail: (profile, error, failedAt) => options.database.failFleetSync(profile, error, failedAt),
      now: options.now,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    };
    super(internal);
  }
}