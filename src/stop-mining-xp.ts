import { createSolanaRpc, getAddressCodec, getAddressEncoder, getProgramDerivedAddress, type Address, type ReadonlyUint8Array } from '@solana/kit';
import { SAGE_PROGRAM_ADDRESS } from '@staratlas/dev-sage';
import type { StopMiningCareerXpAccounts, XpBudgetAccounts } from './mining-plans.js';

/** Points runtime program used after the StarFrame XP-budget accounts. */
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

/** Derives the post-reset StarFrame CareerXpBudget account:
 * seeds ["CareerXpBudget", game, character] under the C4 SAGE program. */
export function deriveCareerXpBudget(gameId: Address, characterId: Address): Promise<Address> {
  return findProgramAddress(
    [seed('CareerXpBudget'), seed(encoder.encode(gameId)), seed(encoder.encode(characterId))],
    SAGE_ADDRESS,
  );
}

/** Derives the post-reset StarFrame XP budget configuration account:
 * seeds ["XpBudgetConfig", game] under the C4 SAGE program. */
export function deriveXpBudgetConfig(gameId: Address): Promise<Address> {
  return findProgramAddress([seed('XpBudgetConfig'), seed(encoder.encode(gameId))], SAGE_ADDRESS);
}

/** Derives the game ProgressionConfig PDA:
 * seeds ["ProgressionConfig", gameId] under the SAGE program. */
export function deriveProgressionConfig(gameId: Address): Promise<Address> {
  return findProgramAddress([seed('ProgressionConfig'), seed(encoder.encode(gameId))], SAGE_ADDRESS);
}

function xpBudget(careerXpBudget: Address, xpBudgetConfig: Address, modifier: Address): XpBudgetAccounts {
  return {
    careerXpBudget,
    xpBudgetConfig,
    pointsModifierAccount: modifier,
  };
}

export interface StopMiningXpModifiers {
  pilot: Address;
  mining: Address;
  councilRank: Address;
}

/** Normalizes the account-data shapes returned by current and older Kit RPC
 * transformers when `encoding: 'base64'` is requested. */
export function decodeBase64AccountData(dataValue: unknown): Uint8Array {
  if (dataValue instanceof Uint8Array) return dataValue;
  if (Array.isArray(dataValue) && typeof dataValue[0] === 'string') return Uint8Array.from(Buffer.from(dataValue[0], 'base64'));
  if (dataValue && typeof dataValue === 'object' && 'data' in dataValue) {
    const nested = (dataValue as { data?: unknown }).data;
    if (Array.isArray(nested) && typeof nested[0] === 'string') return Uint8Array.from(Buffer.from(nested[0], 'base64'));
  }
  throw new Error('account data is not base64-readable');
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
  characterId: Address,
): Promise<StopMiningCareerXpAccounts> {
  const rpc = createSolanaRpc(rpcUrl);
  const account = await rpc.getAccountInfo(gameId, { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!account.value) throw new Error(`Game account ${gameId} was not found`);
  let modifiers: StopMiningXpModifiers;
  try {
    modifiers = parseStopMiningXpModifiers(decodeBase64AccountData(account.value.data));
  } catch (error) {
    throw new Error(`Game account ${gameId} points config is unreadable: ${(error as Error).message}`);
  }

  const [careerXpBudget, xpBudgetConfig, progressionConfig] = await Promise.all([
    deriveCareerXpBudget(gameId, characterId),
    deriveXpBudgetConfig(gameId),
    deriveProgressionConfig(gameId),
  ]);
  const pilot = xpBudget(careerXpBudget, xpBudgetConfig, modifiers.pilot);
  const mining = xpBudget(careerXpBudget, xpBudgetConfig, modifiers.mining);
  const councilRank = xpBudget(careerXpBudget, xpBudgetConfig, modifiers.councilRank);

  return { pilot, mining, councilRank, progressionConfig, pointsProgram: POINTS_PROGRAM };
}