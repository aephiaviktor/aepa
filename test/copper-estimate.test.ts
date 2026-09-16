import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCurrentCopper, miningStartUnixSeconds, formatLocalHhmm } from '../src/copper-estimate.js';

// Live-anchored numbers: MF-01 Copper at Ioki, stop 15:25 (1789555500),
// targetMiningSeconds 18975s, expectedCopperRaw 249.
const STOP = 1_789_555_500n;
const TARGET_SECONDS = 18_975n;
const EXPECTED = 249n;
const START = STOP - TARGET_SECONDS;

test('estimate is 0 before or exactly at mining start', () => {
  assert.equal(miningStartUnixSeconds(STOP, TARGET_SECONDS), START);
  assert.equal(estimateCurrentCopper({ nowUnixSeconds: START - 3_600n, targetStopAtUnixSeconds: STOP, targetMiningSeconds: TARGET_SECONDS, expectedCopperRaw: EXPECTED }), 0n);
  assert.equal(estimateCurrentCopper({ nowUnixSeconds: START, targetStopAtUnixSeconds: STOP, targetMiningSeconds: TARGET_SECONDS, expectedCopperRaw: EXPECTED }), 0n);
});

test('estimate is a clamped integer floor of elapsed * expected / target', () => {
  // Half-way: 9487s of 18975s -> floor(9487 * 249 / 18975) = 124
  assert.equal(estimateCurrentCopper({ nowUnixSeconds: START + 9_487n, targetStopAtUnixSeconds: STOP, targetMiningSeconds: TARGET_SECONDS, expectedCopperRaw: EXPECTED }), 124n);
  // Exactly at stop: full expected amount
  assert.equal(estimateCurrentCopper({ nowUnixSeconds: STOP, targetStopAtUnixSeconds: STOP, targetMiningSeconds: TARGET_SECONDS, expectedCopperRaw: EXPECTED }), EXPECTED);
  // After stop: clamped to expected
  assert.equal(estimateCurrentCopper({ nowUnixSeconds: STOP + 7_200n, targetStopAtUnixSeconds: STOP, targetMiningSeconds: TARGET_SECONDS, expectedCopperRaw: EXPECTED }), EXPECTED);
});

test('estimate matches the user-observed live value shape (135-136 at 13:02)', () => {
  // 10:09 -> 15:25 is 18960s in wall clock; the stored plan uses 18975s.
  // Using the plan's own window midpoint should stay within a few raw units of
  // the observed ~135.8. Exact floor depends on the real start time.
  const observedAt = START + 10_380n;
  const current = estimateCurrentCopper({ nowUnixSeconds: observedAt, targetStopAtUnixSeconds: STOP, targetMiningSeconds: TARGET_SECONDS, expectedCopperRaw: EXPECTED });
  assert.ok(current >= 133n && current <= 139n, `expected ~136, got ${current}`);
});

test('estimate rejects degenerate plans', () => {
  assert.throws(() => miningStartUnixSeconds(STOP, 0n), RangeError);
  assert.throws(() => estimateCurrentCopper({ nowUnixSeconds: 1n, targetStopAtUnixSeconds: 1n, targetMiningSeconds: 0n, expectedCopperRaw: 1n }), RangeError);
  assert.throws(() => estimateCurrentCopper({ nowUnixSeconds: 1n, targetStopAtUnixSeconds: 1n, targetMiningSeconds: 1n, expectedCopperRaw: -1n }), RangeError);
});

test('formatLocalHhmm renders zero-padded local 24h time', () => {
  const date = new Date(Number(STOP) * 1_000);
  const expected = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  assert.equal(formatLocalHhmm(STOP), expected);
  assert.match(formatLocalHhmm(STOP), /^\d{2}:\d{2}$/);
});