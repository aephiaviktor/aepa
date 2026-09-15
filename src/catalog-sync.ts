import { loadMiningAutomationCatalog, type MiningAutomationCatalog } from './automation-catalog.js';
import type { AepaDatabase } from './database.js';
import { SyncCoordinator, type SyncCoordinatorOptions } from './sync.js';

export const CATALOG_TTL_MS = 60 * 60_000; // 1h: measured cold live load is ~67s; world data (regions/systems/belts/resources) changes slowly

export interface CatalogResolveResult {
  source: 'cache' | 'live';
  value: MiningAutomationCatalog;
}

export interface CatalogSyncCoordinatorOptions {
  database: AepaDatabase;
  getScope: () => string;
  getIntervalMs?: () => number;
  load?: () => Promise<MiningAutomationCatalog>;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export class CatalogSyncCoordinator extends SyncCoordinator<MiningAutomationCatalog> {
  constructor(options: CatalogSyncCoordinatorOptions) {
    const internal: SyncCoordinatorOptions<MiningAutomationCatalog> = {
      database: options.database,
      getProfile: options.getScope,
      getIntervalMs: options.getIntervalMs ?? (() => CATALOG_TTL_MS),
      load: options.load ?? (() => loadMiningAutomationCatalog(options.database.getSettings())),
      begin: (scope, startedAt) => options.database.beginCatalogSync(scope, startedAt),
      publish: (scope, catalog, meta) => options.database.completeCatalogSync(scope, catalog, { startedAt: meta.startedAt, succeededAt: meta.succeededAt }),
      fail: (scope, error, failedAt) => options.database.failCatalogSync(scope, error, failedAt),
      now: options.now,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    };
    super(internal);
  }

  async resolve(): Promise<CatalogResolveResult> {
    const scope = this.options.getProfile();
    const snapshot = this.options.database.getCatalogSnapshot(scope);
    const lastSucceededAt = snapshot.sync.lastSucceededAt;
    const cachedAgeMs = lastSucceededAt === undefined
      ? Number.POSITIVE_INFINITY
      : this.now().getTime() - new Date(lastSucceededAt).getTime();
    if (snapshot.sync.status === 'ready' && snapshot.catalog !== undefined && cachedAgeMs < CATALOG_TTL_MS) {
      return { source: 'cache', value: snapshot.catalog as MiningAutomationCatalog };
    }
    const value = await this.refresh();
    return { source: 'live', value };
  }
}