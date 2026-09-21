export class RawResponseTooLarge extends Error {
  constructor() { super('Raw transaction response exceeds size limit'); }
}
/** Never archive a truncated body. Oversize evidence remains pending for recovery. */
export async function readRawResponse(response: Response, limit = 8 * 1024 * 1024): Promise<string> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid response limit');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new RawResponseTooLarge();
  }
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new RawResponseTooLarge(); }
      parts.push(decoder.decode(value,{stream:true}));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally { reader.releaseLock(); }
}
