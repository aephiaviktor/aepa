import assert from 'node:assert/strict';
import test from 'node:test';
import { AepaDatabase } from '../src/database.js';
import { FleetSyncCoordinator } from '../src/fleet-sync.js';

const profile = '11111111111111111111111111111111';
const fleet = { address: 'fleet-1', profile, name: 'Alpha', state: 'idle', shipCount: 1, snapshot: { exact: true }, updatedAt: '2026-09-15T10:00:01.000Z' };

test('fleet refreshes are single-flight and atomically publish the successful snapshot', async () => {
  const database = new AepaDatabase(':memory:');
  let resolveLoad!: (value: { fleets: typeof fleet[]; chainSlot: string }) => void;
  let loads = 0;
  const coordinator = new FleetSyncCoordinator({
    database,
    getProfile: () => profile,
    getIntervalMs: () => 60_000,
    now: (() => {
      const values = ['2026-09-15T10:00:00.000Z', '2026-09-15T10:00:02.000Z'];
      return () => new Date(values.shift()!);
    })(),
    load: () => {
      loads += 1;
      return new Promise<{ fleets: typeof fleet[]; chainSlot: string }>((resolve) => { resolveLoad = resolve; });
    },
  });

  const first = coordinator.refresh();
  const second = coordinator.refresh();
  assert.equal(loads, 1);
  assert.equal(database.getFleetSnapshot(profile).sync.status, 'refreshing');
  resolveLoad({ fleets: [fleet], chainSlot: '500' });
  assert.equal(await first, await second);

  const snapshot = database.getFleetSnapshot(profile);
  assert.deepEqual(snapshot.fleets.map(({ name }) => name), ['Alpha']);
  assert.equal(snapshot.sync.status, 'ready');
  assert.equal(snapshot.sync.chainSlot, '500');
  database.close();
});

test('failed refresh records an error without deleting the last-good fleets', async () => {
  const database = new AepaDatabase(':memory:');
  database.replaceFleets(profile, [fleet]);
  const coordinator = new FleetSyncCoordinator({
    database,
    getProfile: () => profile,
    getIntervalMs: () => 60_000,
    now: () => new Date('2026-09-15T10:03:00.000Z'),
    load: async () => { throw new Error('RPC unavailable'); },
  });

  await assert.rejects(coordinator.refresh(), /RPC unavailable/);
  const snapshot = database.getFleetSnapshot(profile);
  assert.deepEqual(snapshot.fleets.map(({ name }) => name), ['Alpha']);
  assert.equal(snapshot.sync.status, 'error');
  assert.equal(snapshot.sync.lastError, 'RPC unavailable');
  database.close();
});

test('a profile change queues a separate refresh instead of reusing the old profile request', async () => {
  const database = new AepaDatabase(':memory:');
  const secondProfile = '22222222222222222222222222222222';
  let activeProfile = profile;
  let resolveFirst!: (value: { fleets: typeof fleet[]; chainSlot: string }) => void;
  let loads = 0;
  const coordinator = new FleetSyncCoordinator({
    database,
    getProfile: () => activeProfile,
    getIntervalMs: () => 60_000,
    load: () => {
      loads += 1;
      if (loads === 1) return new Promise<{ fleets: typeof fleet[]; chainSlot: string }>((resolve) => { resolveFirst = resolve; });
      return Promise.resolve({ fleets: [{ ...fleet, profile: activeProfile, address: 'fleet-2', name: 'Beta' }], chainSlot: '701' });
    },
  });

  const oldRefresh = coordinator.refresh();
  activeProfile = secondProfile;
  const newRefresh = coordinator.refresh();
  assert.equal(loads, 1);
  resolveFirst({ fleets: [fleet], chainSlot: '700' });
  await oldRefresh;
  await newRefresh;

  assert.equal(loads, 2);
  assert.deepEqual(database.getFleetSnapshot(profile).fleets.map(({ name }) => name), ['Alpha']);
  assert.deepEqual(database.getFleetSnapshot(secondProfile).fleets.map(({ name }) => name), ['Beta']);
  database.close();
});

test('automatic fleet sync starts immediately, repeats at the configured interval, and stops cleanly', async () => {
  const database = new AepaDatabase(':memory:');
  const scheduled: Array<{ callback: () => void; delay: number; handle: NodeJS.Timeout }> = [];
  const cleared: NodeJS.Timeout[] = [];
  let nextHandle = 1;
  const coordinator = new FleetSyncCoordinator({
    database,
    getProfile: () => profile,
    getIntervalMs: () => 60_000,
    load: async () => ({ fleets: [fleet], chainSlot: '600' }),
    setTimer: (callback, delay) => {
      const handle = nextHandle++ as unknown as NodeJS.Timeout;
      scheduled.push({ callback, delay, handle });
      return handle;
    },
    clearTimer: (handle) => { cleared.push(handle); },
  });

  coordinator.start();
  coordinator.start();
  assert.deepEqual(scheduled.map(({ delay }) => delay), [0]);
  scheduled.shift()!.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduled.map(({ delay }) => delay), [60_000]);

  const periodicHandle = scheduled[0].handle;
  coordinator.stop();
  assert.deepEqual(cleared, [periodicHandle]);
  database.close();
});

test('failed automatic refresh retries with backoff and returns to the full interval after success', async () => {
  const database = new AepaDatabase(':memory:');
  const scheduled: Array<{ callback: () => void; delay: number; handle: NodeJS.Timeout }> = [];
  let nextHandle = 1;
  let attempts = 0;
  const coordinator = new FleetSyncCoordinator({
    database,
    getProfile: () => profile,
    getIntervalMs: () => 3_600_000,
    load: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('RPC down');
      return { fleets: [fleet], chainSlot: '800' };
    },
    setTimer: (callback, delay) => {
      const handle = nextHandle++ as unknown as NodeJS.Timeout;
      scheduled.push({ callback, delay, handle });
      return handle;
    },
    clearTimer: () => undefined,
  });

  coordinator.start();
  assert.deepEqual(scheduled.map(({ delay }) => delay), [0]);
  scheduled.shift()!.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduled.map(({ delay }) => delay), [60_000]);

  scheduled.shift()!.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduled.map(({ delay }) => delay), [3_600_000]);
  database.close();
});
