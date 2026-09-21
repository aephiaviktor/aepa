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
