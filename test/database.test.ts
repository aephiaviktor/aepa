import assert from 'node:assert/strict';
import test from 'node:test';
import { AepaDatabase } from '../src/database.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

test('clearGameCache wipes chain-derived data but keeps local settings', () => {
  const database = new AepaDatabase(':memory:');
  const profile = '11111111111111111111111111111111';
  database.saveSettings({ ...DEFAULT_SETTINGS, playerProfile: profile });
  const fleet = { address: 'fleet-1', profile, name: 'MF-01', state: 'mining', shipCount: 1, snapshot: { exact: 'data' }, updatedAt: '2026-09-17T10:00:00.000Z' };
  database.replaceFleets(profile, [fleet]);
  database.beginFleetSync(profile, '2026-09-17T10:00:00.000Z');
  database.completeFleetSync(profile, [fleet], { startedAt: '2026-09-17T10:00:00.000Z', succeededAt: '2026-09-17T10:00:01.000Z', chainSlot: '100' });
  database.saveAutomationAssignment({ profile, fleetAddress: 'fleet-1', fleetName: 'MF-01', assignment: 'mining', homeSystemAddress: 'eternity', homeSystemId: 10, homeSystemName: 'Eternity', resourceId: 311, resourceName: 'Copper Ore', destinationAddress: 'ioki', destinationName: 'Ioki', travelMode: 'auto' });
  database.recordAutomationActivity({ kind: 'confirmed', action: 'start-mining', signature: 'sig-1', detail: 'seeded' });
  assert.equal(database.getFleetSnapshot(profile).fleets.length, 1);
  assert.equal(database.getAutomationAssignment()?.fleetName, 'MF-01');
  assert.ok(database.listAutomationActivity().length > 0);

  database.clearGameCache();

  assert.equal(database.getFleetSnapshot(profile).fleets.length, 0);
  assert.equal(database.getFleetSnapshot(profile).sync.status, 'never');
  assert.equal(database.getAutomationAssignment(), undefined);
  assert.equal(database.listAutomationActivity().length, 0);
  assert.equal(database.getSettings().playerProfile, profile);
  database.close();
});

test('SQLite persists settings and atomically replaces one profile fleet snapshot', () => {
  const database = new AepaDatabase(':memory:');
  const profile = '11111111111111111111111111111111';
  database.saveSettings({ ...DEFAULT_SETTINGS, playerProfile: profile, refreshIntervalSeconds: 90 });
  assert.equal(database.getSettings().refreshIntervalSeconds, 90);
  database.replaceFleets(profile, [{ address: 'fleet-1', profile, name: 'Alpha', state: 'idle', shipCount: 2, snapshot: { exact: 'data' }, updatedAt: '2026-09-14T07:00:00.000Z' }]);
  assert.deepEqual(database.listFleets(profile).map(({ name, shipCount, snapshot }) => ({ name, shipCount, snapshot })), [{ name: 'Alpha', shipCount: 2, snapshot: { exact: 'data' } }]);
  database.replaceFleets(profile, []);
  assert.deepEqual(database.listFleets(profile), []);
  database.close();
});

test('SQLite keeps the last-good fleet snapshot while refresh metadata records failure and recovery', () => {
  const database = new AepaDatabase(':memory:');
  const profile = '11111111111111111111111111111111';
  const alpha = { address: 'fleet-1', profile, name: 'Alpha', state: 'idle', shipCount: 2, snapshot: { exact: 'alpha' }, updatedAt: '2026-09-15T10:00:00.000Z' };
  const beta = { address: 'fleet-2', profile, name: 'Beta', state: 'docked', shipCount: 1, snapshot: { exact: 'beta' }, updatedAt: '2026-09-15T10:02:00.000Z' };

  database.beginFleetSync(profile, '2026-09-15T10:00:00.000Z');
  database.completeFleetSync(profile, [alpha], {
    startedAt: '2026-09-15T10:00:00.000Z', succeededAt: '2026-09-15T10:00:01.000Z', chainSlot: '100',
  });
  database.beginFleetSync(profile, '2026-09-15T10:01:00.000Z');
  assert.equal(database.getFleetSnapshot(profile).sync.status, 'refreshing');
  database.failFleetSync(profile, 'RPC unavailable', '2026-09-15T10:01:02.000Z');

  const failed = database.getFleetSnapshot(profile);
  assert.equal(failed.fleets[0]?.name, 'Alpha');
  assert.deepEqual(failed.sync, {
    dataset: 'fleets', scope: profile, status: 'error',
    lastStartedAt: '2026-09-15T10:01:00.000Z', lastSucceededAt: '2026-09-15T10:00:01.000Z',
    lastError: 'RPC unavailable', chainSlot: '100', updatedAt: '2026-09-15T10:01:02.000Z',
  });

  database.beginFleetSync(profile, '2026-09-15T10:02:00.000Z');
  database.completeFleetSync(profile, [beta], {
    startedAt: '2026-09-15T10:02:00.000Z', succeededAt: '2026-09-15T10:02:01.000Z', chainSlot: '101',
  });
  const recovered = database.getFleetSnapshot(profile);
  assert.deepEqual(recovered.fleets.map(({ name }) => name), ['Beta']);
  assert.equal(recovered.sync.status, 'ready');
  assert.equal(recovered.sync.lastError, undefined);
  assert.equal(recovered.sync.chainSlot, '101');
  database.close();
});

test('SQLite persists a disabled assignment, runtime state, and durable activity', () => {
  const database = new AepaDatabase(':memory:');
  database.saveAutomationAssignment({
    profile: 'profile-1', fleetAddress: 'fleet-mf01', fleetName: 'MF-01', assignment: 'mining',
    homeSystemAddress: 'eternity', homeSystemId: 10, homeSystemName: 'Eternity', resourceId: 311,
    resourceName: 'Copper Ore', destinationAddress: 'ioki', destinationName: 'Ioki', travelMode: 'auto',
  });
  assert.equal(database.getAutomationAssignment()?.status, 'disabled');
  assert.equal(database.getAutomationAssignment()?.enabled, false);

  database.setAutomationEnabled(true);
  database.setAutomationTargetStop(2_000n);
  database.recordAutomationActivity({ kind: 'confirmed', action: 'start-mining', signature: 'signature-1', detail: 'Mining observed' });
  assert.equal(database.getAutomationAssignment()?.status, 'running');
  assert.equal(database.getAutomationAssignment()?.targetStopAtUnixSeconds, 2_000n);
  assert.deepEqual(database.listAutomationActivity(10).map(({ kind, action, signature }) => ({ kind, action, signature })), [
    { kind: 'confirmed', action: 'start-mining', signature: 'signature-1' },
  ]);

  database.pauseAutomation('ambiguous submission outcome');
  assert.equal(database.getAutomationAssignment()?.enabled, false);
  assert.equal(database.getAutomationAssignment()?.status, 'paused');
  assert.equal(database.getAutomationAssignment()?.lastError, 'ambiguous submission outcome');
  database.close();
});

test('SQLite persists independent runtime state for multiple fleet assignments', () => {
  const database = new AepaDatabase(':memory:');
  const base = {
    profile: 'profile-1', assignment: 'mining' as const,
    homeSystemAddress: 'eternity', homeSystemId: 10 as const, homeSystemName: 'Eternity' as const,
    resourceId: 311 as const, resourceName: 'Copper Ore' as const,
    destinationAddress: 'ioki', destinationName: 'Ioki' as const, travelMode: 'auto' as const,
  };
  database.saveAutomationAssignments([
    { ...base, fleetAddress: 'fleet-mf01', fleetName: 'MF-01' },
    { ...base, fleetAddress: 'fleet-mf02', fleetName: 'MF-02' },
  ]);
  database.setAutomationEnabled(true, 'fleet-mf01');
  database.setAutomationEnabled(true, 'fleet-mf02');
  database.setAutomationTargetStop(2_000n, 'fleet-mf02');
  database.pauseAutomation('MF-01 issue', 'fleet-mf01');
  assert.deepEqual(database.listAutomationAssignments().map(({ fleetName, status, targetStopAtUnixSeconds }) => ({ fleetName, status, targetStopAtUnixSeconds })), [
    { fleetName: 'MF-01', status: 'paused', targetStopAtUnixSeconds: undefined },
    { fleetName: 'MF-02', status: 'running', targetStopAtUnixSeconds: 2_000n },
  ]);
  database.close();
});

test('SQLite persists catalog sync metadata and keeps the last-good catalog across failures', () => {
  const database = new AepaDatabase(':memory:');
  const scope = 'profile-1';
  const catalog = { faction: 'ustur', fleets: [{ address: 'fleet-1', name: 'MF-01', state: 'docked' }], homeStarbases: [], resources: [], destinations: [], mode: 'configuration-preview' };

  database.beginCatalogSync(scope, '2026-09-15T11:00:00.000Z');
  database.completeCatalogSync(scope, catalog, {
    startedAt: '2026-09-15T11:00:00.000Z', succeededAt: '2026-09-15T11:00:05.000Z',
  });
  assert.equal(database.getCatalogSnapshot(scope).sync.status, 'ready');
  assert.deepEqual(database.getCatalogSnapshot(scope).catalog, catalog);

  database.beginCatalogSync(scope, '2026-09-15T11:30:00.000Z');
  database.failCatalogSync(scope, 'RPC timeout', '2026-09-15T11:30:02.000Z');
  const failed = database.getCatalogSnapshot(scope);
  assert.equal(failed.sync.status, 'error');
  assert.equal(failed.sync.lastError, 'RPC timeout');
  assert.equal(failed.sync.lastStartedAt, '2026-09-15T11:30:00.000Z');
  assert.equal(failed.sync.lastSucceededAt, '2026-09-15T11:00:05.000Z');
  assert.deepEqual(failed.catalog, catalog);
  database.close();
});
