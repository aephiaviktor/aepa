import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatAssignmentSelection,
  formatTransportCargoTooltip,
} from '../src/assignment-summary.js';

test('assignment summaries show selected names and preserve the complete hover list', () => {
  assert.deepEqual(formatAssignmentSelection([
    { name: 'Copper Ore' },
    { name: 'Iron Ore' },
  ], 'Resources'), {
    summary: 'Copper Ore, Iron Ore',
    title: 'Copper Ore\nIron Ore',
  });
  assert.deepEqual(formatAssignmentSelection([], 'Resources'), {
    summary: 'Resources',
    title: '',
  });
});

test('transport assignment summaries include configured cargo names and amounts', () => {
  assert.deepEqual(formatAssignmentSelection([
    { name: 'Ammunition', amount: '100' },
    { name: 'Fuel', amount: '20' },
  ], 'Cargo'), {
    summary: 'Ammunition 100 · Fuel 20',
    title: 'Ammunition: 100\nFuel: 20',
  });
});

test('transport status tooltip reports actual onboard cargo instead of assignment intent', () => {
  assert.equal(formatTransportCargoTooltip({
    cargoHold: { items: [
      { name: 'Ammunition', amount: '100' },
      { name: 'Fuel', amount: '0' },
      { name: 'Food', amount: 7 },
    ] },
  }), 'Onboard cargo\nAmmunition: 100\nFood: 7');
  assert.equal(formatTransportCargoTooltip({ cargoHold: { items: [] } }), 'Onboard cargo\nNone');
});
