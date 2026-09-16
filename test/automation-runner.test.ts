import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomaticCopperRunner, nextAutomationTickDelayMs } from '../src/automation-runner.js';
import { AepaDatabase } from '../src/database.js';

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
