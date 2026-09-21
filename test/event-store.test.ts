import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AepaEventStore } from '../src/event-store.js';

const planned = (eventId: string) => ({
  eventId,
  network: 'zink-ptr',
  resetEpoch: 'ptr-2026-09',
  profile: 'profile-1',
  fleetAddress: 'fleet-1',
  fleetName: 'MF-01',
  action: 'start-mining',
  occurredAt: '2026-09-21T06:00:00.000Z',
  payload: { resourceIds: [311], destination: 'Ioki' },
});

test('event store persists an append-only, cursor-readable transaction lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aepa-events-'));
  const file = join(dir, 'aepa-events.sqlite');
  try {
    const store = new AepaEventStore(file);
    const first = store.recordPlanned(planned('event-1'));
    assert.equal(first.sequence, 1);
    assert.equal(first.revision, 1);
    assert.equal(first.status, 'planned');

    const submitted = store.recordStatus('event-1', {
      status: 'submitted', changedAt: '2026-09-21T06:00:01.000Z', signature: 'signature-1', instructionIndex: 0,
    });
    const confirmed = store.recordStatus('event-1', {
      status: 'confirmed', changedAt: '2026-09-21T06:00:02.000Z', signature: 'signature-1', instructionIndex: 0,
    });
    const finalized = store.recordStatus('event-1', {
      status: 'finalized', changedAt: '2026-09-21T06:00:03.000Z', signature: 'signature-1', instructionIndex: 0,
    });
    assert.deepEqual([submitted.revision, confirmed.revision, finalized.revision], [2, 3, 4]);

    const duplicate = store.recordStatus('event-1', {
      status: 'finalized', changedAt: '2026-09-21T06:00:04.000Z', signature: 'signature-1', instructionIndex: 0,
    });
    assert.equal(duplicate.sequence, finalized.sequence);
    assert.equal(store.listChanges(0, 20).length, 4);
    store.close();

    const reopened = new AepaEventStore(file);
    const page = reopened.listChanges(first.sequence, 2);
    assert.equal(page.length, 2);
    assert.deepEqual(page.map((row) => row.status), ['submitted', 'confirmed']);
    assert.deepEqual(page[0]?.payload, planned('event-1').payload);
    assert.equal(reopened.listChanges(finalized.sequence, 20).length, 0);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('event store rejects backward transitions and duplicate chain identities', () => {
  const store = new AepaEventStore(':memory:');
  store.recordPlanned(planned('event-1'));
  store.recordStatus('event-1', {
    status: 'submitted', changedAt: '2026-09-21T06:00:01.000Z', signature: 'signature-1', instructionIndex: 0,
  });
  assert.throws(() => store.recordStatus('event-1', {
    status: 'planned', changedAt: '2026-09-21T06:00:02.000Z',
  }), /Invalid event status transition/);

  store.recordPlanned({ ...planned('event-2'), fleetAddress: 'fleet-2', fleetName: 'MF-02' });
  assert.throws(() => store.recordStatus('event-2', {
    status: 'submitted', changedAt: '2026-09-21T06:00:03.000Z', signature: 'signature-1', instructionIndex: 0,
  }), /UNIQUE constraint failed/);
  store.close();
});

test('profile-wide transactions retain multiple instructions without fleet context', () => {
  const store = new AepaEventStore(':memory:');
  const input = { ...planned('profile-action'), fleetAddress: undefined, fleetName: undefined,
    action: 'future-action', instructions: [
      { programAddress: 'program-1', accounts: [{ address: 'account-1', role: 1 }], dataBase64: 'AQ==' },
      { programAddress: 'program-2', accounts: [], dataBase64: 'Ag==' },
    ] };
  const row = store.recordPlanned(input);
  assert.equal(row.fleetAddress, undefined);
  assert.deepEqual(row.instructions, input.instructions);
  assert.equal(store.recordPlanned(input).sequence, row.sequence);
  store.close();
});

test('one signature identifies one transaction regardless of instruction index', () => {
  const store = new AepaEventStore(':memory:');
  store.recordPlanned(planned('a'));
  store.recordPlanned(planned('b'));
  store.recordStatus('a', { status: 'submitted', changedAt: planned('a').occurredAt, signature: 'shared', instructionIndex: 0 });
  assert.throws(() => store.recordStatus('b', { status: 'submitted', changedAt: planned('b').occurredAt, signature: 'shared', instructionIndex: 1 }), /UNIQUE constraint/);
  store.close();
});

test('late execution evidence advances the cursor without duplicating the transaction', () => {
  const store = new AepaEventStore(':memory:');
  store.recordPlanned(planned('a'));
  store.recordStatus('a', { status: 'submitted', changedAt: planned('a').occurredAt, signature: 'sig' });
  const confirmed = store.recordStatus('a', { status: 'confirmed', changedAt: planned('a').occurredAt });
  const evidence = { slot: '123', feeRaw: '5000', logs: ['executed'], balanceChanges: [], error: null };
  const enriched = store.recordStatus('a', { status: 'confirmed', changedAt: planned('a').occurredAt, evidence });
  assert.ok(enriched.sequence > confirmed.sequence);
  assert.deepEqual(enriched.evidence, evidence);
  assert.equal(store.recordStatus('a', { status: 'confirmed', changedAt: planned('a').occurredAt, evidence }).sequence, enriched.sequence);
  assert.equal(store.listChanges(confirmed.sequence).length, 1);
  store.close();
});

test('transaction identity is isolated by network and reset epoch', () => {
  const store = new AepaEventStore(':memory:');
  for (const [eventId, network, resetEpoch] of [['a', 'ptr', '1'], ['b', 'ptr', '2'], ['c', 'other', '1']]) {
    store.recordPlanned({ ...planned(eventId!), network: network!, resetEpoch: resetEpoch! });
    store.recordStatus(eventId!, { status: 'submitted', changedAt: planned('a').occurredAt, signature: 'same' });
  }
  assert.equal(store.listChanges().length, 6);
  store.close();
});

test('v1 store migrates without losing cursor history or inventing instruction evidence', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'aepa-v1-'));
  const file = join(dir, 'events.sqlite');
  try {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, '2026-09-21');
      CREATE TABLE events(event_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1),
        network TEXT, reset_epoch TEXT, profile TEXT, fleet_address TEXT, fleet_name TEXT, action TEXT,
        occurred_at TEXT, payload_json TEXT, signature TEXT, instruction_index INTEGER);
      CREATE UNIQUE INDEX events_chain_identity_idx ON events(network, reset_epoch, signature, instruction_index);
      CREATE TABLE event_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT REFERENCES events(event_id),
        revision INTEGER, status TEXT, changed_at TEXT, signature TEXT, instruction_index INTEGER, error TEXT);
      INSERT INTO events VALUES ('old',1,'ptr','epoch','profile','fleet','Fleet','mining','2026-09-21','{}','sig',0);
      INSERT INTO event_changes VALUES (7,'old',1,'submitted','2026-09-21','sig',0,NULL);
    `);
    db.close();
    const store = new AepaEventStore(file);
    const row = store.listChanges(6)[0]!;
    assert.equal(row.sequence, 7);
    assert.deepEqual(row.instructions, []);
    assert.equal(row.evidence, undefined);
    assert.ok(store.recordStatus('old', { status: 'confirmed', changedAt: '2026-09-21' }).sequence > 7);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
