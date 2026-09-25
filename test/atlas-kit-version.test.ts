import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAtlasKitVersion } from '../src/atlas-kit-version.js';

test('Atlas Kit freshness reports a matching next version as current', () => {
  assert.deepEqual(classifyAtlasKitVersion('0.6.0-next.64', '0.6.0-next.64'), {
    bundled: '0.6.0-next.64',
    latest: '0.6.0-next.64',
    current: true,
  });
});

test('Atlas Kit freshness reports a stale bundled version', () => {
  assert.deepEqual(classifyAtlasKitVersion('0.6.0-next.56', '0.6.0-next.64'), {
    bundled: '0.6.0-next.56',
    latest: '0.6.0-next.64',
    current: false,
  });
});

test('Atlas Kit freshness remains diagnostic-only when npm is unavailable', () => {
  assert.deepEqual(classifyAtlasKitVersion('0.6.0-next.64', null, 'registry unavailable'), {
    bundled: '0.6.0-next.64',
    latest: null,
    current: null,
    error: 'registry unavailable',
  });
});
