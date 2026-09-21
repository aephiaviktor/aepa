import type { RawTransactionStore } from './raw-transaction-store.js';

export type RawTransactionReader = (signature: string, options: {
  encoding: 'base64'; commitment: 'finalized'; maxSupportedTransactionVersion: 0;
}) => Promise<string>;

/** One bounded background batch. The runtime owns endpoint selection, timeout,
 * retry scheduling and network/reset scoping. No network work on the send path.
 * Source: https://solana.com/docs/rpc/http/gettransaction
 * The reader returns the original HTTP response text, not JSON.stringify(parsed).
 */
export async function collectRawTransactions(store: RawTransactionStore, read: RawTransactionReader, limit = 20) {
  let received = 0;
  let unavailable = 0;
  for (const row of store.pending(limit)) {
    let text: string;
    try {
      text = await read(row.signature, {
        encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0,
      });
    } catch { unavailable++; continue; }
    // Persistence errors must reach the supervisor, not masquerade as RPC misses.
    store.recordResponse(row.id, text);
    received++;
  }
  return { received, unavailable };
}
