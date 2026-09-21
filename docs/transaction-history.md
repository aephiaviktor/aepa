# AEPA transaction history contract

Scope: every transaction AEPA initiates for the selected player profile, regardless
of automation category. Not a profile-wide chain scanner: manual actions and other
software are outside this initial source. Mining is the first MSA C4 projection,
not a capture filter.

## Storage foundation (implemented, not yet wired to submission)

- One event ID represents one transaction attempt, not a fleet action or instruction.
- Network/reset epoch/signature is unique across the store, regardless of profile,
  fleet label or instruction index. A bundle has one fee, not one fee per action.
- Profile is required; fleet address/name are optional descriptive context. Empty
  strings in the legacy SQL columns mean absent context and decode to undefined.
- `instructions` retains ordered public program addresses, account addresses/roles,
  and base64 instruction data. Unknown action names are accepted. Empty instructions
  on legacy rows mean unavailable evidence, not proof of an empty transaction.
- `payload` carries intent metadata; it is not evidence of execution.
- `evidence` on lifecycle revisions carries public execution facts supplied by a
  future asynchronous collector: slot/block time, exact fees (decimal strings), logs,
  transaction errors, inner instructions and observed balances. No private keys,
  signer objects, RPC URLs, credentials or arbitrary application configuration.
- Late evidence can append a revision at the same status, including finalized or
  failed. Identical repeated evidence is idempotent. Omitting evidence preserves
  existing evidence; supplying it replaces the evidence snapshot for that revision.
- Cursor consumers upsert by event ID/revision. They must not count revisions as
  separate transactions or charge a fee again when new evidence arrives.
- Legacy `instructionIndex` is retained as metadata for compatibility, never as the
  transaction identity. New callers should omit it.

SQLite layout migration 2 adds instruction/evidence storage and transaction-wide
uniqueness. Existing envelope version 1 remains additive-compatible. Migration
fails rather than discarding colliding legacy transaction rows. Historical cursors
and facts are preserved. The existing local-only foundation has not been deployed.

## Integration boundary (not implemented in this patch)

All AEPA sends must pass a shared recorder, with durable intent and a known signed
signature recorded before network submission. No mining/cargo allowlist. Confirmed
execution evidence is collected asynchronously; synchronization, decoding and MSA
projections never run on the send path. Unknown outcomes are reconciled by signature,
never blindly resubmitted. Simulations alone are not submitted transactions.

The database API alone does not prove complete capture; submission integration,
restart reconciliation, evidence collection and performance tests at that boundary
remain required before claiming live coverage.

## Raw-first increment

`RawTransactionStore` separately retains signed wire bytes before send and original
getTransaction response text. Unlike decoded JSON, original text preserves integers
above JavaScript's safe range and unknown future fields. Network/reset/signature
identify the raw submission; identical evidence bodies are deduplicated by hash.
The archive uses WAL with synchronous=FULL for the durable pre-send write.

`signAndSendTransactionOnce` accepts a recorder hook. It awaits the pre-send durable
write and makes no network call if that write fails. Any exception after entering
the send boundary is classified as ambiguous and includes a do-not-resubmit marker.
A pending signed record remains available even if outcome recording fails.

`collectRawTransactions` is a bounded collection primitive, not yet a running
service. It requests base64 transaction data at finalized commitment and stores the
original response body; a non-null transaction/meta response must match the saved
wire bytes before collection is considered complete. Null responses remain pending.
No business decoding or token/native balance arithmetic is done here.

Remaining runtime work: instantiate and scope the archive, supply the recorder at
both production send call sites, select a durable reset identifier, implement a
single-flight collector with endpoint/network scoping, timeout/backoff and fair
retry scheduling, and reconcile pending signatures without resending. The collector
currently receives an injected reader; it does not select an RPC endpoint or start
network requests by itself. Until that runtime wiring is complete, the application
still does not capture live history. No deployment or signing was performed during
these tests.
