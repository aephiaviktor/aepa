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
