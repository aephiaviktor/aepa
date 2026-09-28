import assert from 'node:assert/strict';
import test from 'node:test';
import { sage } from '@aephia/atlas-kit/bindings';
import type { RawAccount } from '@aephia/atlas-kit/client';
import type { Plan } from '@aephia/atlas-kit/planning';
import { address } from '@solana/kit';
import {
  adaptWarpLaneCurrencyCachePlan,
  assertWarpLaneCurrencyCacheAccount,
  deriveWarpLaneCurrencyCache,
} from '../src/transport-plan.js';

const GAME = address('11111111111111111111111111111111');
const OTHER = address('SysvarC1ock11111111111111111111111111111111');

async function fixture(overrides: Partial<RawAccount> = {}) {
  const [cacheAddress, bump] = await deriveWarpLaneCurrencyCache(GAME);
  const data = new Uint8Array(sage.getCurrencyConfigCacheEncoder().encode({
    version: 1,
    gameId: GAME,
    bump,
    atlas: { currentEpoch: 10n, totalWithdrawn: 20n },
    polis: { currentEpoch: 30n, totalWithdrawn: 40n },
    atlasVault: 50n,
    daoAtlasVault: 60n,
  }));
  return {
    expected: { address: cacheAddress, game: GAME, bump },
    raw: {
      address: cacheAddress,
      owner: sage.SAGE_PROGRAM_ADDRESS,
      lamports: 1n,
      data,
      executable: false,
      slot: 1n,
      commitment: 'confirmed' as const,
      ...overrides,
    } satisfies RawAccount,
  };
}

test('CurrencyCache semantic guard allows mutable balances, epochs, and vaults', async () => {
  const { raw, expected } = await fixture();
  assert.doesNotThrow(() => assertWarpLaneCurrencyCacheAccount(raw, expected));

  const decoded = sage.getCurrencyConfigCacheDecoder().decode(raw.data);
  const changed = new Uint8Array(sage.getCurrencyConfigCacheEncoder().encode({
    ...decoded,
    atlas: { currentEpoch: 999n, totalWithdrawn: 888n },
    polis: { currentEpoch: 777n, totalWithdrawn: 666n },
    atlasVault: 555n,
    daoAtlasVault: 444n,
  }));
  assert.doesNotThrow(() =>
    assertWarpLaneCurrencyCacheAccount({ ...raw, data: changed, slot: 2n }, expected),
  );
});

test('CurrencyCache semantic guard rejects identity, owner, execution, layout, Game, and bump drift', async () => {
  const { raw, expected } = await fixture();
  const decoded = sage.getCurrencyConfigCacheDecoder().decode(raw.data);
  const cases: readonly RawAccount[] = [
    { ...raw, address: OTHER },
    { ...raw, owner: OTHER },
    { ...raw, executable: true },
    { ...raw, data: raw.data.subarray(0, raw.data.length - 1) },
    { ...raw, data: new Uint8Array(sage.getCurrencyConfigCacheEncoder().encode({ ...decoded, gameId: OTHER })) },
    { ...raw, data: new Uint8Array(sage.getCurrencyConfigCacheEncoder().encode({ ...decoded, bump: (expected.bump + 1) & 0xff })) },
  ];
  for (const candidate of cases) {
    assert.throws(() => assertWarpLaneCurrencyCacheAccount(candidate, expected));
  }
});

test('only the exact Warp-lane CurrencyCache account-state guard is replaced', async () => {
  const { expected } = await fixture();
  const currencyGuard = {
    kind: 'account-state' as const,
    address: expected.address,
    dataHash: '11'.repeat(32),
    describes: 'The canonical CurrencyCache remains assigned to the configured Game.',
  };
  const otherGuard = {
    kind: 'account-state' as const,
    address: OTHER,
    dataHash: '22'.repeat(32),
    describes: 'Fleet state remains unchanged.',
  };
  const plan = {
    kind: 'fleet.warp-lane',
    summary: 'Warp through lane',
    steps: [],
    preconditions: [otherGuard, currencyGuard],
  } as unknown as Plan;

  const adapted = await adaptWarpLaneCurrencyCachePlan(plan, GAME);
  assert.deepEqual(adapted.plan.preconditions, [otherGuard]);
  assert.equal(adapted.currencyCache.address, expected.address);
  assert.equal(adapted.currencyCache.bump, expected.bump);
  await assert.rejects(
    adaptWarpLaneCurrencyCachePlan({ ...plan, preconditions: [otherGuard] } as Plan, GAME),
    /exactly one CurrencyCache/,
  );
  await assert.rejects(
    adaptWarpLaneCurrencyCachePlan({ ...plan, preconditions: [currencyGuard, currencyGuard] } as Plan, GAME),
    /exactly one CurrencyCache/,
  );
});
