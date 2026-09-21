import test from 'node:test';
import assert from 'node:assert/strict';
import { readRawResponse } from '../src/raw-response.js';

test('bounded response preserves exact UTF-8 text', async () => {
  const text='{"value":"λ","slot":9007199254740993}';
  assert.equal(await readRawResponse(new Response(text),1024),text);
});
test('rejects oversized response rather than returning truncated evidence', async () => {
  await assert.rejects(readRawResponse(new Response('12345'),4), /size limit/);
});
test('rejects oversized declared body before consuming it', async () => {
  await assert.rejects(readRawResponse(new Response('x',{headers:{'content-length':'100'}}),10), /size limit/);
});
