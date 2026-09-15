import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFleetShips, getFleetOwnership, normalizeVisibleColumns } from '../src/fleet-view.js';

test('describes the exact fleet combination from C4 ship quantities', () => {
  assert.equal(describeFleetShips({ ships: [
    { name: 'Fimbul Airbike Default Config', quantity: '2' },
    { name: 'Pearce X4', quantity: 1n },
    { name: 'Fimbul Airbike Default Config', quantity: '3' },
  ] }), '5x Fimbul Airbike Default Config, 1x Pearce X4');
  assert.equal(describeFleetShips({ ships: [] }), 'No ship composition');
});

test('derives ownership from the C4 owner profile', () => {
  const profile = 'B36ebn83M5MHknfJ6SAPVVjkw4TG9DKHB8r91f6Hnpv8';
  assert.equal(getFleetOwnership({ ownerProfile: { address: profile } }, profile), 'Owned');
  assert.equal(getFleetOwnership({ ownerProfile: { address: '11111111111111111111111111111111' } }, profile), 'Managed');
  assert.equal(getFleetOwnership({}, profile), 'Unknown');
});

test('keeps only known selectable fleet columns and restores defaults for invalid state', () => {
  assert.deepEqual(normalizeVisibleColumns(['fleet', 'ships', 'bogus']), ['fleet', 'ships']);
  assert.deepEqual(normalizeVisibleColumns(null), ['fleet', 'state', 'ships', 'ownership', 'address', 'updated']);
  assert.deepEqual(normalizeVisibleColumns([]), []);
});
