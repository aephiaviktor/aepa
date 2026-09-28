import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Transport executor uses guarded plans and persists only confirmed next phases', async () => {
  const source = await readFile(
    new URL('../src/transport-c4.ts', import.meta.url),
    'utf8',
  ).catch(() =>
    readFile(new URL('../../src/transport-c4.ts', import.meta.url), 'utf8'),
  );
  assert.match(source,/executeGuardedPlan/);
  assert.match(
    source,
    /database\.setTransportPhase[\s\S]*return\s*\{\s*kind:\s*["']confirmed["']/,
  );
  assert.match(source,/planFleetWarpLane/);
  assert.match(source,/planFleetSubwarp/);
  assert.match(source,/planLoadFleetCrew/);
  assert.match(source,/planUnloadFleetCrew/);
  assert.match(source,/validateTransportQuantities/);
  assert.match(source,/setTransportAttempt/);
  assert.match(source,/must not be retried automatically/);
  assert.doesNotMatch(source,/executePlan\(/);
});

test('crew and cargo transfers are separate confirmed actions', async () => {
  const source = await readFile(
    new URL('../src/transport-c4.ts', import.meta.url),
    'utf8',
  ).catch(() =>
    readFile(new URL('../../src/transport-c4.ts', import.meta.url), 'utf8'),
  );
  assert.match(source,/['"]load-outbound-cargo['"]\s*:\s*['"]load-outbound-crew['"]/);
  assert.match(source,/['"]unload-outbound-cargo['"]\s*:\s*['"]unload-outbound-crew['"]/);
  assert.match(source,/['"]load-return-cargo['"]\s*:\s*['"]load-return-crew['"]/);
  assert.match(source,/['"]unload-return-cargo['"]\s*:\s*['"]unload-return-crew['"]/);
});
