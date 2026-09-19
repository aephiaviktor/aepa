import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomaticCopperRunner, nextAutomationTickDelayMs, shouldAutoRetryPaused } from '../src/automation-runner.js';
import { AepaDatabase, type AutomationAssignmentRecord } from '../src/database.js';

function enabledDatabase(): AepaDatabase {
  const database = new AepaDatabase(':memory:');
  database.saveAutomationAssignment({
    profile: 'profile-1', fleetAddress: 'fleet-mf01', fleetName: 'MF-01', assignment: 'mining',
    homeSystemAddress: 'eternity', homeSystemId: 10, homeSystemName: 'Eternity', resourceId: 311,
    resourceName: 'Copper Ore', destinationAddress: 'ioki', destinationName: 'Ioki', travelMode: 'auto',
  });
  database.setAutomationEnabled(true);
  return database;
}

test('runs only one transaction at a time and durably records confirmed progress', async () => {
  const database = enabledDatabase();
  let release!: () => void;
  let calls = 0;
  const runner = new AutomaticCopperRunner(database, async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    return { kind: 'confirmed', action: 'start-mining', signature: 'sig-1', detail: 'Mining observed', targetStopAtUnixSeconds: 2_000n };
  });
  const first = runner.tick();
  assert.deepEqual(await runner.tick(), { kind: 'busy' });
  release();
  assert.equal((await first).kind, 'confirmed');
  assert.equal(calls, 1);
  assert.equal(database.getAutomationAssignment()?.targetStopAtUnixSeconds, 2_000n);
  assert.equal(database.listAutomationActivity()[0].signature, 'sig-1');
  database.close();
});

test('pauses on every execution error and never retries while paused', async () => {
  const database = enabledDatabase();
  let calls = 0;
  const runner = new AutomaticCopperRunner(database, async () => {
    calls += 1;
    throw new Error('submitted once but confirmation was not observed');
  });
  const first = await runner.tick();
  assert.equal(first.kind, 'paused');
  assert.match(database.getAutomationAssignment()?.lastError ?? '', /must be inspected before any retry/i);
  assert.deepEqual(await runner.tick(), { kind: 'idle' });
  assert.equal(calls, 1);
  database.close();
});

test('clears the durable mining deadline only after stop-mining is confirmed', async () => {
  const database = enabledDatabase();
  database.setAutomationTargetStop(2_000n);
  const runner = new AutomaticCopperRunner(database, async () => ({ kind: 'confirmed', action: 'stop-mining', signature: 'sig-stop', detail: 'Idle observed' }));
  assert.equal((await runner.tick()).kind, 'confirmed');
  assert.equal(database.getAutomationAssignment()?.targetStopAtUnixSeconds, undefined);
  assert.equal(database.listAutomationActivity()[0].signature, 'sig-stop');
  database.close();
});

test('exposes a fast-follow delay after a confirmed action instead of the full refresh interval', () => {
  // SLYA-style snappiness: as soon as one action confirms, the next runner tick
  // should follow within a couple of seconds, not after the 60s (or 15s floor)
  // refresh interval.
  assert.equal(nextAutomationTickDelayMs('confirmed', 60), 2_500);
  assert.equal(nextAutomationTickDelayMs('confirmed', 15), 2_500);
  assert.equal(nextAutomationTickDelayMs('confirmed', 5), 2_500);
  // Waiting / idle / paused / busy keep the configured cadence (15s floor).
  assert.equal(nextAutomationTickDelayMs('waiting', 60), 60_000);
  assert.equal(nextAutomationTickDelayMs('idle', 20), 20_000);
  assert.equal(nextAutomationTickDelayMs('paused', 10), 15_000);
  assert.equal(nextAutomationTickDelayMs('busy', 3), 15_000);
});

test('persists a wait deadline without sending a transaction', async () => {
  const database = enabledDatabase();
  const runner = new AutomaticCopperRunner(database, async () => ({ kind: 'waiting', untilUnixSeconds: 2_000n, detail: 'Mining until target' }));
  assert.deepEqual(await runner.tick(), { kind: 'waiting', untilUnixSeconds: 2_000n });
  assert.equal(database.listAutomationActivity()[0].kind, 'waiting');
  database.close();
});

test('round-robins every enabled fleet assignment instead of starving later fleets', async () => {
  const database = new AepaDatabase(':memory:');
  const base = {
    profile: 'profile-1', assignment: 'mining' as const, homeSystemAddress: 'eternity', homeSystemId: 10,
    homeSystemName: 'Eternity', destinationAddress: 'ioki', destinationName: 'Ioki', travelMode: 'auto' as const,
  };
  database.saveAutomationAssignments([
    { ...base, fleetAddress: 'fleet-2', fleetName: 'MF-02', resourceId: 309, resourceName: 'Carbon' },
    { ...base, fleetAddress: 'fleet-3', fleetName: 'MF-03', resourceId: 310, resourceName: 'Biomass' },
    { ...base, fleetAddress: 'fleet-4', fleetName: 'MF-04', resourceId: 312, resourceName: 'Hydrogen' },
  ]);
  for (const fleet of ['fleet-2', 'fleet-3', 'fleet-4']) database.setAutomationEnabled(true, fleet);
  const visited: string[] = [];
  const runner = new AutomaticCopperRunner(database, async (assignment) => {
    visited.push(`${assignment.fleetName}:${assignment.resourceName}`);
    return { kind: 'waiting', untilUnixSeconds: 2_000n, detail: 'Waiting' };
  });
  await runner.tick(); await runner.tick(); await runner.tick();
  assert.deepEqual(visited, ['MF-02:Carbon', 'MF-03:Biomass', 'MF-04:Hydrogen']);
  database.close();
});

test('auto-retries plan-stage pauses but never post-submission failures', () => {
  const base: AutomationAssignmentRecord = {
    profile: 'profile-1', fleetAddress: 'fleet-mf01', fleetName: 'MF-01', assignment: 'mining',
    homeSystemAddress: 'eternity', homeSystemId: 10, homeSystemName: 'Eternity', resourceId: 311,
    resourceName: 'Copper Ore', destinationAddress: 'ioki', destinationName: 'Ioki', travelMode: 'auto',
    enabled: false, status: 'paused', lastError: 'PLAN_STAGE Planning failed before any send', updatedAt: '2026-09-16T00:00:00Z',
  };
  assert.equal(shouldAutoRetryPaused(base), true);
  assert.equal(shouldAutoRetryPaused({ ...base, status: 'running' }), false);
  assert.equal(shouldAutoRetryPaused({ ...base, lastError: 'submitted once but confirmation was not observed' }), false);
  assert.equal(shouldAutoRetryPaused(undefined), false);
});
