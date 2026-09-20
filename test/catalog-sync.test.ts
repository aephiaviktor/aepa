import assert from 'node:assert/strict';
import test from 'node:test';
import type { MiningAutomationCatalog } from '../src/automation-catalog.js';
import { AepaDatabase } from '../src/database.js';
import { CatalogSyncCoordinator, CATALOG_TTL_MS } from '../src/catalog-sync.js';

const scope = 'profile-1';
assert.equal(CATALOG_TTL_MS, 3_600_000);
const catalog: MiningAutomationCatalog = {
  faction: 'ustur',
  fleets: [],
  homeStarbases: [],
  resources: [],
  destinations: [],
  mode: 'configuration-preview',
};

test('catalog resolve returns the fresh cached catalog without reloading', async () => {
  const database = new AepaDatabase(':memory:');
  const now = new Date('2026-09-15T12:00:00.000Z');
  database.beginCatalogSync(scope, '2026-09-15T11:45:00.000Z');
  database.completeCatalogSync(scope, catalog, {
    startedAt: '2026-09-15T11:45:00.000Z', succeededAt: '2026-09-15T11:45:05.000Z',
  });
  let loads = 0;
  const coordinator = new CatalogSyncCoordinator({
    database,
    getScope: () => scope,
    now: () => now,
    load: async () => { loads += 1; return catalog; },
  });

  const view = await coordinator.resolve();
  assert.equal(view.source, 'cache');
  assert.deepEqual(view.value, catalog);
  assert.equal(loads, 0);
  database.close();
});

test('stale or missing catalog reloads, persists, and reports live source', async () => {
  const database = new AepaDatabase(':memory:');
  const now = new Date('2026-09-15T12:00:00.000Z');
  database.beginCatalogSync(scope, '2026-09-15T11:00:00.000Z');
  database.completeCatalogSync(scope, catalog, {
    startedAt: '2026-09-15T11:00:00.000Z', succeededAt: '2026-09-15T10:00:05.000Z',
  });
  let loads = 0;
  const coordinator = new CatalogSyncCoordinator({
    database,
    getScope: () => scope,
    now: () => now,
    load: async () => { loads += 1; return { ...catalog, faction: 'oni' }; },
  });

  const view = await coordinator.resolve();
  assert.equal(view.source, 'live');
  assert.equal(view.value.faction, 'oni');
  assert.equal(loads, 1);
  const snapshot = database.getCatalogSnapshot(scope);
  assert.equal(snapshot.sync.status, 'ready');
  assert.equal((snapshot.catalog as MiningAutomationCatalog).faction, 'oni');
  database.close();
});

test('a fresh legacy catalog without fleet travel data reloads before reaching the UI', async () => {
  const database = new AepaDatabase(':memory:');
  const now = new Date('2026-09-15T12:00:00.000Z');
  database.beginCatalogSync(scope, '2026-09-15T11:55:00.000Z');
  database.completeCatalogSync(scope, {
    ...catalog,
    fleets: [{ address: 'fleet-1', name: 'MF-01', state: 'docked' }],
  }, {
    startedAt: '2026-09-15T11:55:00.000Z', succeededAt: '2026-09-15T11:55:05.000Z',
  });
  let loads = 0;
  const coordinator = new CatalogSyncCoordinator({
    database,
    getScope: () => scope,
    now: () => now,
    load: async () => { loads += 1; return catalog; },
  });

  const view = await coordinator.resolve();
  assert.equal(view.source, 'live');
  assert.equal(loads, 1);
  database.close();
});
