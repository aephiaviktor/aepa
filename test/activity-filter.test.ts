import assert from 'node:assert/strict';
import test from 'node:test';
import { activityFleetNames, filterActivityEntries } from '../src/activity-filter.js';

const entries = [
  { fleetName: 'MF-01', action: 'start-mining', kind: 'confirmed', detail: 'Started Copper Ore extraction' },
  { fleetName: 'FF-01', action: 'travel-return', kind: 'confirmed', detail: 'Warp fleet home from Sastri' },
  { fleetName: undefined, action: undefined, kind: 'waiting', detail: 'No Automation activity recorded yet' },
];

test('activity filters combine fleet and case-insensitive text matching', () => {
  assert.deepEqual(filterActivityEntries(entries, 'MF-01', 'copper'), [entries[0]]);
  assert.deepEqual(filterActivityEntries(entries, '', 'WARP FLEET'), [entries[1]]);
  assert.deepEqual(filterActivityEntries(entries, 'System', 'waiting'), [entries[2]]);
  assert.deepEqual(filterActivityEntries(entries, 'MF-01', 'sastri'), []);
});

test('activity fleet options are unique, sorted, and include System events', () => {
  assert.deepEqual(activityFleetNames([...entries, entries[0]]), ['FF-01', 'MF-01', 'System']);
});
