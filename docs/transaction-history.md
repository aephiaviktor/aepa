# AEPA transaction history contract

Scope: every transaction AEPA initiates for the selected player profile, regardless
of automation category. Not a profile-wide chain scanner: manual actions and other
software are outside this initial source. Mining is the first MSA C4 projection,
not a capture filter.

## Structured event foundation (independent of raw runtime capture)

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

## Submission integration requirements

All AEPA sends must pass a shared recorder, with durable intent and a known signed
signature recorded before network submission. No mining/cargo allowlist. Confirmed
execution evidence is collected asynchronously; synchronization, decoding and MSA
projections never run on the send path. Unknown outcomes are reconciled by signature,
never blindly resubmitted. Simulations alone are not submitted transactions.

The database API alone does not prove complete capture. The raw runtime integration
is described below; live coverage still requires production validation.

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

## Runtime integration (local branch, not deployed)

Electron instantiates `aepa-raw-transactions.sqlite` beside its app database and
configures the required recorder at both current C4 send sites. Direct callers of
those C4 send functions must initialize capture too; they fail before sending if
capture is unavailable. Simulation-only paths do not archive submissions.

A single-flight background collector runs at startup and every five seconds, with
at most twenty requests per batch and a ten-second request timeout. Durable retry
claims back off from thirty seconds to one hour and put other due records first.
HTTP 429/503 honors Retry-After (at least thirty seconds). Restart resumes pending
records by fetching evidence, never by signing or resending. Null/missing results
remain pending; finalized on-chain failures with matching bytes are retained as
complete execution evidence, not mistaken for missing transactions.

Endpoint URLs/credentials stay in memory. Transport failures and RPC error bodies
are not archived, since providers may echo sensitive endpoint information. Public
transaction result bodies are retained verbatim. Shutdown aborts the collector and
prevents new recorded sends; the process closes the raw SQLite handle so an
in-flight send can still append its outcome while unwinding.

### Reset provenance limitation

There is no verified authoritative chain-reset identifier available in the current
app settings. `resetEpoch` therefore holds an explicitly labeled, durable
`local-generation:<uuid>`, not a claimed chain epoch. The generation rotates on
Clear Game Cache without deleting history. Imports must retain this provenance;
they must not assume separate installations' local generations identify different
chain resets. Collection can revisit old local generations on the same configured
network, but only byte-identical transaction evidence completes a record. Automatic
chain-reset detection and cross-source epoch mapping remain future work.

### Validation boundary

Unit/integration tests cover durable restart collection, exact response retention,
pre-send persistence, ambiguous sends, network scoping, rate limits and single-flight
shutdown. No live transaction was signed or submitted for these tests. Windows
Electron smoke testing and production capture validation still require a separately
authorized deployment. The original event store remains an independent structured
foundation; raw runtime capture does not yet populate decoded business projections
or supply the MSA synchronization interface.
