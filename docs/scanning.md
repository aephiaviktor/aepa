# Scanning automation

Source-only implementation against `@aephia/atlas-kit` **0.6.0-next.64**.
No live transaction qualification is claimed.

## Assignment

Fleet names are plain names for both Mining and Scanning. Scanning fields are
Fleet, Assignment, Home Starbase, Scan Sector X, Scan Sector Y, Scan Pattern,
Travel Mode. Sectors are signed integral I8F56 whole coordinates (-128..127).
Patterns come from the Game catalog; Broad Spectrum is presented first, not a
synthetic movement pattern. Policy and exact sector-region research requirements
are checked in the UI/save boundary and refreshed before a new sortie/detection.
Consumption is the sum of independently rounded `ceil(scanCost × multiplierRaw /
65536)` rows for each cargo. Scan costs consume cargo-hold resources, not tanks.

## Runtime

The separate scanning driver uses public SDK Plans and `executePlan` fresh
precondition validation. AEPA's scoped transport then simulates the signed wire
with `sigVerify`, writes the existing durable operation barrier, and sends once
with zero retries. Unknown send, confirmation, post-state, and final persistence
failures retain the barrier. Operator recovery requires finalized evidence and
fresh scanning inspection; it does not replay a transaction.

Open, detect, resolve, recover, expire, forfeit, abandon, and acknowledge are
separate confirmed steps. Exact Fleet I8F56 coordinates come from the SDK's
public pinned bindings for recovery-range checks. Terminal results, including
accepted/clipped cargo and awarded XP, are persisted before acknowledgement.
Scanning continues at the sector while consumables, space and return fuel allow.
A durable returning/servicing phase survives restart. Subwarp arrival is settled
separately and the actual destination is checked before proceeding.

Resupply reserves at most half the cargo hold for up to twenty detections,
unloads surplus/other cargo, refills required consumables and the fuel tank,
and returns to scanning. Fuel reserve uses distance times the SDK-translated
U26F6 consumption rate, rounded up per leg plus one raw unit per nonzero leg;
it does not divide by a legacy display scale or normalize by speed/time.
Actual Subwarp fuel is program-recorded and charged on settlement.
Pending assignment changes unload old scan supplies
before activating the new assignment at Home Starbase. Stop-now abandons a live
contact; end-of-cycle completes it. Both return home and service before disabling.
Mining's existing cross-system execution restriction is unchanged.

## Hard SDK limitation: Warp

The requested choices are shown as Subwarp and Warp, but Warp is explicitly
unavailable: next.64's `planFleetSettleArrival` rejects stored Warp journeys.
The app does not fabricate Idle state or fall back to Subwarp. Full Warp scanning
requires a supported, verified settlement route in AtlasKit before enabling it.

## Verification

- `npm run typecheck`
- `npm test`
- Optional isolated browser check (requires an installed `playwright-core` and
  Chromium): `node tools/verify-scanning-ui.cjs`. Override
  `AEPA_PLAYWRIGHT_MODULE`, `AEPA_CHROMIUM_PATH`, and `AEPA_SCREENSHOT_PATH` as
  needed. It serves source on loopback with fake IPC and blocks external requests.
  It never starts Electron or opens a signer.

Sources:
- https://develop.atlas-kit-docs.pages.dev/guides/scanning/
- https://develop.atlas-kit-docs.pages.dev/reference/scanning/actions/
- https://develop.atlas-kit-docs.pages.dev/reference/fleets/actions/
- https://solana.com/docs/rpc/http/simulatetransaction
- https://solana.com/docs/rpc/http/sendtransaction
