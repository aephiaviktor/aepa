import { createSolanaRpc, getAddressCodec, getAddressEncoder, getProgramDerivedAddress, type Address, type ReadonlyUint8Array } from '@solana/kit';
import { SAGE_PROGRAM_ADDRESS } from '@staratlas/dev-sage';
import type { StopMiningCareerXpAccounts, XpBudgetAccounts } from './mining-plans.js';

/** Career-XP category accounts the deployed StarFrame program reads from the
 * Game account's points config (pilot, mining, council-rank) and the points
 * program that owns them. Same addresses SLYA uses for this chain family. */
export const PILOT_XP_CATEGORY = 'PiLotBQoUBUvKxMrrQbuR3qDhqgwLJctWsXj3uR7fGs' as Address;
export const MINING_XP_CATEGORY = 'MineMBxARiRdMh7s1wdStSK4Ns3YfnLjBfvF5ZCnzuw' as Address;
export const COUNCIL_RANK_XP_CATEGORY = 'XPneyd1Wvoay3aAa24QiKyPjs8SUbZnGg5xvpKvTgN9' as Address;
export const POINTS_PROGRAM = 'Point2iBvz7j5TMVef8nEgpmz4pDr7tU7v3RjAfkQbM' as Address;

const SAGE_ADDRESS = SAGE_PROGRAM_ADDRESS as Address;
const encoder = getAddressEncoder();
const addressCodec = getAddressCodec();

/** Sidesteps ReadonlyUint8Array vs Uint8Array friction for PDA seeds. */
const seed = (bytes: Uint8Array | ReadonlyUint8Array | string): Uint8Array =>
  typeof bytes === 'string' ? new TextEncoder().encode(bytes) : Uint8Array.from(bytes);

async function findProgramAddress(seeds: readonly (Uint8Array | string)[], program: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: seeds.map(seed),
  });
  return pda as Address;
}

/** Derives the per-category UserPointsAccount PDA:
 * seeds ["UserPointsAccount", xpCategory, userProfile] under the points program. */
export function deriveUserPointsAccount(xpCategory: Address, userProfile: Address): Promise<Address> {
  return findProgramAddress(
    [seed('UserPointsAccount'), seed(encoder.encode(xpCategory)), seed(encoder.encode(userProfile))],
    POINTS_PROGRAM,
  );
}

/** Derives the game ProgressionConfig PDA:
 * seeds ["ProgressionConfig", gameId] under the SAGE program. */
export function deriveProgressionConfig(gameId: Address): Promise<Address> {
  return findProgramAddress([seed('ProgressionConfig'), seed(encoder.encode(gameId))], SAGE_ADDRESS);
}

function xpBudget(category: Address, userProfile: Address, modifier: Address): Promise<XpBudgetAccounts> {
  return deriveUserPointsAccount(category, userProfile).then((userPointsAccount) => ({
    userPointsAccount,
    pointsCategory: category,
    pointsModifierAccount: modifier,
  }));
}

export interface StopMiningXpModifiers {
  pilot: Address;
  mining: Address;
  councilRank: Address;
}

/** Parses the six fixed-size SagePointsCategory records embedded in Game. */
export function parseStopMiningXpModifiers(raw: Uint8Array): StopMiningXpModifiers {
  // Layout after version(1) + updateId(8) + profile(32) + gameState(32):
  // lp(0), councilRankXp(1), pilotXp(2), dataRunningXp(3), miningXp(4), craftingXp(5).
  // Each category stores category pubkey(32), modifier pubkey(32), modifierBump(1).
  const base = 73;
  const recordSize = 65;
  if (raw.length < base + 6 * recordSize) throw new Error('Game account points config is unreadable');
  const readModifier = (record: number): Address =>
    addressCodec.decode(raw.subarray(base + record * recordSize + 32, base + record * recordSize + 64)) as Address;
  return {
    pilot: readModifier(2),
    mining: readModifier(4),
    councilRank: readModifier(1),
  };
}

/**
 * Resolves the Career-XP budget accounts the post-reset C4 StarFrame program
 * requires on the stop-mining instruction. The Game account's points config
 * supplies the modifier per category; without these accounts the deployed
 * program rejects the stop with "Career XP budget required -
 * xp_budget_accounts_required". Reads live account data.
 */
export async function resolveStopMiningCareerXp(
  rpcUrl: string,
  gameId: Address,
  userProfile: Address,
): Promise<StopMiningCareerXpAccounts> {
  const rpc = createSolanaRpc(rpcUrl);
  const account = await rpc.getAccountInfo(gameId, { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!account.value) throw new Error(`Game account ${gameId} was not found`);
  const dataValue = account.value.data;
  if (!dataValue || typeof dataValue !== 'object' || !('data' in dataValue) || !Array.isArray(dataValue.data) || typeof dataValue.data[0] !== 'string') {
    throw new Error(`Game account ${gameId} data is not base64-readable`);
  }
  const raw = Buffer.from(dataValue.data[0], 'base64');
  let modifiers: StopMiningXpModifiers;
  try {
    modifiers = parseStopMiningXpModifiers(raw);
  } catch (error) {
    throw new Error(`Game account ${gameId} points config is unreadable: ${(error as Error).message}`);
  }

  const [pilot, mining, councilRank, progressionConfig] = await Promise.all([
    xpBudget(PILOT_XP_CATEGORY, userProfile, modifiers.pilot),
    xpBudget(MINING_XP_CATEGORY, userProfile, modifiers.mining),
    xpBudget(COUNCIL_RANK_XP_CATEGORY, userProfile, modifiers.councilRank),
    deriveProgressionConfig(gameId),
  ]);

  return { pilot, mining, councilRank, progressionConfig, pointsProgram: POINTS_PROGRAM };
}