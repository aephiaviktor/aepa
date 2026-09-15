# AEPA

Aephia's C4 automation desktop app. The visual direction follows My Star Atlas;
the operational direction follows SLYA, rebuilt against the C4 account model.

## Current testnet scope

- Locked to the C4 z.ink PTR/testnet deployment.
- Stores settings, last-good fleet snapshots and sync metadata, one Automation
  assignment, runtime checkpoints, and activity locally in SQLite.
- Renders the cached fleet snapshot immediately, refreshes it from C4 at startup
  and at the configured interval, and keeps a manual **Refresh now** fallback.
- Discovers live faction territories, systems, asteroid belts, and resources.
- Stores the C4 authority signer with Electron/Windows OS encryption; the key is
  never stored in SQLite and is revalidated against the active Profile authority.
- Supports signed simulation and a dormant-by-default automatic send path only
  for the proven `MF-01 / Eternity / Ioki / Copper Ore / same-system` cycle.

## Automatic-send safety model

Saving an assignment does not enable it. Enabling live automatic sends is a
separate explicit UI action. Before every transaction AEPA:

1. reads fresh C4 state and selects at most one next action;
2. re-reads and verifies the exact MF-01 action and active authority;
3. signs locally and runs signature-verified simulation;
4. sends exactly once, without retrying;
5. waits for confirmation and verifies resulting fleet state;
6. records the checkpoint and activity durably before advancing.

Only one runner tick may execute at a time. Any error pauses the assignment. A
runner-paused assignment cannot be re-enabled or replaced in the app until its
chain state has been reconciled out of band. Confirmed mining start deadlines
are durable, and enabled assignments resume when AEPA restarts. Pausing prevents
the next send but cannot cancel a transaction already submitted to C4.

Other resources, destinations, fleets, and inter-system travel may be explored
in the configuration UI, but the trusted main process rejects them for automatic
execution until their transaction paths are implemented and tested.

## SQLite and on-chain authority

SQLite is the fast, last-good display and recovery layer. It stores:

- local settings;
- complete per-profile fleet snapshots, including the original decoded C4 JSON;
- fleet sync status, attempt/success times, chain slot, error, and the derived
  Character/Copper-loop display payload;
- Automation configuration, durable runtime state/deadlines, and activity.

A fleet refresh is single-flight. A complete result atomically replaces the
profile's fleet rows and sync metadata; a failed refresh records its error but
never deletes or partially replaces the last-good snapshot. Profile changes
queue a distinct refresh rather than adopting an in-flight result for another
profile.

C4 remains authoritative for fleet state, balances, location, ownership,
Profile authority, faction/control, and every transaction decision. Cached data
may render the UI and seed configuration, but before simulation or submission
AEPA re-reads and validates the required C4 accounts. The encrypted signer is a
separate DPAPI-protected file and is never stored in SQLite.

The world/catalog cache (regions, systems, system control, asteroid belts, resources,
and Home Starbases) is persisted per profile with a one-hour freshness policy (cold
live load measured at ~67s; SQLite warm read ~5ms, so refreshing slowly pays off).
A single-flight background sync warms it at startup and revalidates it periodically;
fresh reads come from SQLite, stale or failing reads reload from C4 and keep the
last-good snapshot. Failed refreshes retry with exponential backoff (1m, 2m, 4m…
capped at the interval). Saving an assignment always revalidates against a fresh
live catalog, and sending a transaction always re-reads the required C4 accounts;
a cached value is never used to authorize a send.

## Development

```bash
npm install
npm test
npm run typecheck
npm run dev
```

The default RPC endpoint is `https://testnet-rpc.z.ink`. A custom HTTP(S)
endpoint can be selected in Settings. Player Profile addresses are public
on-chain identifiers; wallet secrets do not belong in AEPA's settings database.
