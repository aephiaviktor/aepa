# Raw capture review — 2026-09-21

Scope: local feature/msa-c4-event-store through ff925e1. Ordinary development
review, not a deployment audit or authorization. Verdict: REQUEST CHANGES.
No source changes or live transactions were required to establish these findings.

## Required: distinguish evidence recovery from automation crash recovery

The background collector only calls getTransaction; it never resends. However,
that does not prove the whole application cannot repeat an action after a crash.
RawSubmission contains no fleet/action/assignment correlation. Electron starts
collection and automation independently, and the runner selects persisted running
assignments without consulting unresolved raw submissions. A process crash after
send but before durable automation confirmation can therefore bypass the ordinary
catch/pause path. Fresh chain inspection helps but is not a signature-based crash
barrier, especially while an earlier transaction is still pending.

Remedy: persist automation operation/assignment correlation before send and require
resolution of an interrupted operation before re-executing that operation. Do not
block unrelated fleets merely because finalized metadata is slow. Separate known
submission/confirmation outcome from completeness of archived metadata. Test the
real orchestration crash window, not just reopening the raw SQLite store.

Evidence: src/raw-transaction-store.ts RawSubmission; electron/main.ts runner
callback and startup; src/automation-runner.ts tick selects enabled/running rows.

## Required: raw archive I/O still blocks Electron's main thread

All raw storage uses DatabaseSync in the main process with synchronous=FULL and a
5-second busy timeout. Calling this from an async collector does not make database
work asynchronous. Claims, response writes and checkpoints can stall rendering/IPC
and automation. Prior pre-send benchmark p99 was 23 ms, maximum 42 ms on WSL, not
Windows proof. A collector may perform many additional durable writes per batch.

Remedy: move raw archive ownership to a worker/serialized I/O queue. Await only the
necessary durable pre-send acknowledgement; keep collection writes and checkpoints
outside the UI/main event loop. Benchmark worker-boundary latency on Windows.

## Required: collection gaps are largely invisible

HTTP failures, timeouts and JSON-RPC errors return/continue silently. Only escaping
exceptions call a console reporter. There is no UI-visible pending count, oldest
pending age, last successful fetch, or safe failure category. An unsupported RPC
method can therefore leave all records incomplete without an operator warning.

Remedy: persist/expose sanitized collector health; never store credential-bearing
transport errors. Test missing metadata, unsupported method, rate limits and disk
failure as observable states. Do not falsely label a null response a failed tx.

## Required before scale claim: response size and archival growth

response.text() has no byte limit, then JSON.parse is run in runtime and store.
Large/malicious responses can exhaust memory or stall the main thread. Raw history
has no storage budget/space indicator or archive workflow. Never silently truncate
or delete evidence to solve this: expose oversize/incomplete state, support a
bounded streaming/spooling policy and establish operator-visible capacity handling.
The synthetic growth result is in artifacts/raw-capture-review-benchmark.json;
it is not an estimate of actual C4 response sizes.

## Remaining validation

- Windows Electron smoke and capture latency: not performed.
- Actual z.ink getTransaction metadata availability: not demonstrated by mocks.
- Local generation is not a chain reset ID; documented limitation remains valid.
- MSA synchronization/decoded projections remain outside this increment.
- Existing 126 passing tests prove covered cases, not the crash barrier above.

Positive findings: exact RPC response text preserves unknown fields/integer lexemes;
wire identity check prevents unrelated metadata completing a record; pre-send write
failure prevents sending; retry claims are durable and fair; explicit 429 handling;
no private keys or endpoint strings are deliberately persisted.

## First correction: durable per-fleet send barrier

The raw recorder now atomically writes a submission and a barrier keyed by
network/profile/fleet address. A second send for that fleet is refused while the
barrier exists, including after runtime restart and after raw metadata is complete.
A normal operation removes its barrier only after the existing confirmation and
resulting-state checks succeed. Other fleets remain independent. Reset-generation
rotation does not silently clear unresolved operations.

This is deliberately not automatic recovery: a crashed/failed operation remains
blocked until explicit reconciliation is implemented. There is no UI unlock yet,
and metadata collection alone must not unlock an operation. A crash before the
actual network send can also conservatively leave a barrier. Legacy raw records
created before this correction cannot be reliably assigned to fleets. No deployed
archive is being migrated, because this feature branch has not been deployed.

Remaining before release: a safe reconciliation workflow, worker-based storage,
health/capacity reporting, response-size controls and Windows validation. Do not
represent this correction as completing all review findings.

## Second correction: worker-owned raw SQLite

Electron now uses RawStoreWorker. A dedicated Node worker exclusively constructs
and owns RawTransactionStore; SQLite FULL writes, lock waits and checkpoints no
longer execute on Electron's main thread. The runtime awaits acknowledgements of
committed writes before sending and awaits outcome/barrier changes as well.

The worker protocol is internal and allowlisted. Errors reject waiting callers;
worker startup/death cannot silently leave a send waiting indefinitely. Explicit
close drains already accepted messages, rejects new calls and terminates the
worker. Electron shutdown intentionally stops capture without prematurely closing
storage while an existing send may still unwind; process exit ends the worker.
A stop race after durable pre-send recording leaves a conservative barrier and
prevents the network send.

Tests include an actual SQLite write lock released by a main-thread timer while
the worker waits, plus startup failure, FIFO drain and raw barrier behavior.
Windows Electron worker packaging/runtime remains unverified. Fetch response
buffering and the runtime's initial JSON validation still run on the main thread;
response-size controls remain required. Worker isolation is not a claim that all
main-thread processing has been eliminated.
