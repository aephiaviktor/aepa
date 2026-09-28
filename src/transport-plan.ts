import { sage } from '@aephia/atlas-kit/bindings';
import type { RawAccount } from '@aephia/atlas-kit/client';
import { createPlan, type Plan } from '@aephia/atlas-kit/planning';
import {
  createSolanaRpc,
  getAddressEncoder,
  getBytesEncoder,
  getProgramDerivedAddress,
  type Address,
} from '@solana/kit';

const CURRENCY_CACHE_DESCRIPTION =
  'The canonical CurrencyCache remains assigned to the configured Game.';

export type WarpLaneCurrencyCacheIdentity = {
  address: Address;
  game: Address;
  bump: number;
};

export async function deriveWarpLaneCurrencyCache(
  game: Address,
): Promise<readonly [Address, number]> {
  const [cache, bump] = await getProgramDerivedAddress({
    programAddress: sage.SAGE_PROGRAM_ADDRESS,
    seeds: [
      getBytesEncoder().encode(new TextEncoder().encode('CurrencyConfig')),
      getAddressEncoder().encode(game),
    ],
  });
  return [cache, bump];
}

/**
 * Atlas Kit next.66 emits a whole-account freshness hash for lane-warp's
 * CurrencyCache even though epoch, withdrawal, and vault balances are shared
 * mutable state. Replace only that exact guard; all other Plan guards remain.
 */
export async function adaptWarpLaneCurrencyCachePlan(
  plan: Plan,
  game: Address,
): Promise<{ plan: Plan; currencyCache: WarpLaneCurrencyCacheIdentity }> {
  if (plan.kind !== 'fleet.warp-lane')
    throw new Error('CurrencyCache guard adaptation is only valid for Warp-lane Plans');

  const matches = plan.preconditions.filter(
    (guard) =>
      guard.kind === 'account-state' &&
      guard.describes === CURRENCY_CACHE_DESCRIPTION,
  );
  if (matches.length !== 1)
    throw new Error(
      `Warp-lane Plan must contain exactly one CurrencyCache account-state guard; found ${matches.length}`,
    );

  const [canonicalAddress, canonicalBump] =
    await deriveWarpLaneCurrencyCache(game);
  const [guard] = matches;
  if (guard.address !== canonicalAddress)
    throw new Error('Warp-lane CurrencyCache guard is not the canonical PDA for the configured Game');

  return {
    plan: createPlan({
      kind: plan.kind,
      summary: plan.summary,
      steps: plan.steps,
      preconditions: plan.preconditions.filter((candidate) => candidate !== guard),
    }),
    currencyCache: {
      address: canonicalAddress,
      game,
      bump: canonicalBump,
    },
  };
}

/** Validate stable CurrencyCache identity while intentionally ignoring shared
 * mutable balance, epoch, withdrawal, and vault fields. */
export function assertWarpLaneCurrencyCacheAccount(
  raw: RawAccount,
  expected: WarpLaneCurrencyCacheIdentity,
): void {
  const decoder = sage.getCurrencyConfigCacheDecoder();
  const discriminator = sage.CURRENCY_CONFIG_CACHE_DISCRIMINATOR;
  if (
    raw.address !== expected.address ||
    raw.owner !== sage.SAGE_PROGRAM_ADDRESS ||
    raw.executable ||
    raw.data.length !== decoder.fixedSize ||
    !discriminator.every((byte, index) => raw.data[index] === byte)
  ) {
    throw new Error(
      'Warp-lane CurrencyCache no longer has the canonical address, owner, discriminator, or pinned layout',
    );
  }
  let decoded: ReturnType<typeof decoder.decode>;
  try {
    decoded = decoder.decode(raw.data);
  } catch {
    throw new Error('Warp-lane CurrencyCache cannot be decoded with the pinned account layout');
  }
  if (decoded.gameId !== expected.game || decoded.bump !== expected.bump) {
    throw new Error(
      'Warp-lane CurrencyCache no longer belongs to the configured Game and canonical PDA bump',
    );
  }
}

export async function assertFreshWarpLaneCurrencyCache(
  rpc: ReturnType<typeof createSolanaRpc>,
  expected: WarpLaneCurrencyCacheIdentity,
): Promise<void> {
  const response = await rpc
    .getAccountInfo(expected.address, {
      commitment: 'confirmed',
      encoding: 'base64',
    })
    .send();
  if (!response.value)
    throw new Error('Canonical Warp-lane CurrencyCache is unavailable before submission');
  assertWarpLaneCurrencyCacheAccount(
    {
      address: expected.address,
      owner: response.value.owner,
      lamports: response.value.lamports,
      data: new Uint8Array(Buffer.from(response.value.data[0], 'base64')),
      executable: response.value.executable,
      slot: response.context.slot,
      commitment: 'confirmed',
    },
    expected,
  );
}
