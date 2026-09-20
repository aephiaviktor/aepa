import { createSageClient, resolveCargo, type FleetView } from '@aephia/atlas-kit';
import { getStarbasePlayerForCharacterAtSystem } from '@aephia/atlas-kit/starbases';
import { planFleetTransferCargoAtStarbase } from '@aephia/atlas-kit/cargo/actions';
import { planFleetDock, planFleetUndock } from '@aephia/atlas-kit/fleets/actions';
import { getResearchCatalog } from '@aephia/atlas-kit/identity';
import { planFleetStopMining } from '@aephia/atlas-kit/mining/actions';
import { assemblePlan, createPlan, simulatePlan, type Plan } from '@aephia/atlas-kit/planning';
import { planRegisterStarbasePlayer } from '@aephia/atlas-kit/starbases/actions';
import { SAGE_PROGRAM_ADDRESS, getTransferCargoToFleetInstructionDataEncoder } from '@staratlas/dev-sage';
import { AccountRole, address, createSolanaRpc, type AccountMeta, type Instruction, type ReadonlyUint8Array, type Signature } from '@solana/kit';
import { decideCopperLoopNextStep, requireStarbaseRegistration, type CopperLoopNextStep } from './copper-loop.js';
import type { FleetRecord } from './database.js';
import { calculateMultiResourceFoodPlan, type Rational } from './mining-food.js';
import { assertMiningResourcesAvailable, resolveMiningResourceEligibility } from './mining-research.js';
import { appendStopMiningCareerXp, planStartMiningResource, type StopMiningCareerXpAccounts } from './mining-plans.js';
import { resolveStopMiningCareerXp } from './stop-mining-xp.js';
import type { AppSettings } from './settings.js';

import { signAndSimulateTransaction, signAndSendTransactionOnce } from './signed-simulation.js';

const CARGO_STORAGE_SCALE = 256n;
const ETERNITY_SYSTEM_ID = 10;
const DEFAULT_MINING_SCOPE: MiningLoopScope = {
  homeSystemId: 10,
  homeSystemName: 'Eternity',
  resourceId: 311,
  resourceName: 'Copper Ore',
  destinationAddress: 'BwkkW5fgeot3xjkttvSMXHXHjx3MR8B8ysJ4jB2eDRsU',
  destinationName: 'Ioki',
};
const FLEET_RATE_SCALE = 16_384n;
const RICHNESS_SCALE = 281_474_976_710_656n;
const REGION_TRACKER = address('CbwrSoauo4D6HAJY1xuvjgCxHh3999Be68otnbThBQsi');

/** Decoration for runner pauses that happened before anything was submitted.
 * Only plan-stage pauses may be cleared in-app; post-submission pauses must be
 * reconciled out of band.
 */
export const PLAN_STAGE_MARKER = '[plan-stage]';

/** A failure raised while planning an action, before any transaction was
 * signed or submitted. Distinguishes safe-to-clear pauses from ambiguous
 * post-submission outcomes.
 */
export class PlannerStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerStageError';
  }
}

/** Storage occupied by `foodRaw` raw units of a cargo whose per-unit
 * storageCost is expressed at the same scale as `CARGO_STORAGE_SCALE`.
 * Regression: atlas-kit 0.5.0 bills toFleet cargo-hold loads as
 * `amount x storageCost` without the /256 normalization, so a 13-Food refill
 * was reported as 3328 raw units against a 249-unit hold.
 */
export function calculateCopperLoadStorageRaw(input: { foodRaw: bigint; foodStorageCost: bigint }): bigint {
  return (input.foodRaw * input.foodStorageCost + CARGO_STORAGE_SCALE - 1n) / CARGO_STORAGE_SCALE;
}

/** Fails closed unless a cargo-hold Food load fits the Fleet's free storage,
 * using the same /256 normalization as the service-bundle capacity math.
 */
export function assertCopperLoadFitsCargoStorage(input: {
  cargoCapacityRaw: bigint;
  cargoUsedRaw: bigint;
  foodRaw: bigint;
  foodStorageCost: bigint;
}): void {
  const required = calculateCopperLoadStorageRaw({ foodRaw: input.foodRaw, foodStorageCost: input.foodStorageCost });
  if (input.cargoUsedRaw + required > input.cargoCapacityRaw) {
    throw new PlannerStageError(`Fleet cargo storage requires ${required.toString()} raw units but only ${(input.cargoCapacityRaw - input.cargoUsedRaw).toString()} are free; reduce the Food load and retry.`);
  }
}

export interface MiningLoopScope {
  homeSystemId: number;
  homeSystemName: string;
  resourceId: number;
  resourceIds?: readonly number[];
  resourceName: string;
  destinationAddress: string;
  destinationName: string;
}

export interface CopperLoopPreview {
  fleet: string;
  fleetAddress: string;
  homeSystem: string;
  asteroid: string;
  sameSystem: boolean;
  resource: string;
  limitingEvent: 'cargo' | 'ammo' | 'simultaneous';
  foodForCargoRaw: string;
  foodForAmmoRaw: string;
  foodToLoadRaw: string;
  expectedCopperRaw: string;
  expectedResources: readonly { id: number; name: string; expectedRaw: string }[];
  targetMiningSeconds: string;
  ammoBankTargetRaw: string;
  fuelTankTargetRaw: string;
  unavoidableFoodRoundingRaw: string;
  mode: 'preview-only';
}

export interface CopperStepSimulation {
  nextStep: string;
  summary: string;
  authority: string;
  keyIndex: number;
  unitsConsumed: string;
  logs: readonly string[];
  plan: unknown;
  submitted: false;
}

export interface SignedCopperStepSimulation extends CopperStepSimulation {
  transactionSignature: string;
  signatureVerified: true;
  simulationSlot: string;
}

export interface ServiceBundleAmounts {
  copperToStarbaseRaw: bigint;
  foodToFleetRaw: bigint;
  ammoToFleetRaw: bigint;
  fuelToFleetRaw: bigint;
}

export interface ServiceBundleSimulation {
  fleet: 'MF-01';
  action: 'service-bundle';
  summary: string;
  authority: string;
  keyIndex: number;
  amounts: Record<keyof ServiceBundleAmounts, string>;
  unitsConsumed: string;
  logs: readonly string[];
  plan: unknown;
  submitted: false;
}

export interface LiveServiceBundleResult {
  fleet: 'MF-01';
  action: 'service-bundle';
  summary: string;
  authority: string;
  keyIndex: number;
  amounts: Record<keyof ServiceBundleAmounts, string>;
  plan: unknown;
  transactionSignature: string;
  submitted: true;
  confirmationStatus: 'confirmed' | 'finalized';
  confirmationSlot: string;
  resultingFleetState: string;
}

export function calculateServiceBundleAmounts(input: {
  copperRaw: bigint;
  foodRaw: bigint;
  targetFoodRaw: bigint;
  ammoRaw: bigint;
  ammoTargetRaw: bigint;
  fuelRaw: bigint;
  fuelTargetRaw: bigint;
}): ServiceBundleAmounts {
  if (input.copperRaw <= 0n) throw new Error('The service bundle requires positive Copper Ore to unload');
  if (input.foodRaw > input.targetFoodRaw) throw new Error('The service bundle will not unload excess Food implicitly');
  if (input.ammoRaw > input.ammoTargetRaw || input.fuelRaw > input.fuelTargetRaw) throw new Error('Fleet resource balance exceeds its target');
  return {
    copperToStarbaseRaw: input.copperRaw,
    foodToFleetRaw: input.targetFoodRaw - input.foodRaw,
    ammoToFleetRaw: input.ammoTargetRaw - input.ammoRaw,
    fuelToFleetRaw: input.fuelTargetRaw - input.fuelRaw,
  };
}

export type AuthorizedLiveAction = 'register-starbase' | 'dock' | 'unload' | 'load' | 'undock' | 'start-mining' | 'stop-mining';

type AutomaticMiningDecision = CopperLoopNextStep | { kind: 'register-starbase' };

export interface LiveCopperStepResult {
  fleet: string;
  action: AuthorizedLiveAction;
  summary: string;
  authority: string;
  keyIndex: number;
  transactionSignature: string;
  submitted: true;
  confirmationStatus: 'confirmed' | 'finalized';
  confirmationSlot: string;
  resultingFleetState: string;
  resultingNextStep: string;
}

export function assertAuthorizedCopperStep(
  expectedAction: AuthorizedLiveAction,
  observed: { fleet: string; action: string; authority: string },
  expectedFleetName = 'MF-01',
): void {
  if (observed.fleet !== expectedFleetName) throw new Error(`Authorization gate failed: fleet is not ${expectedFleetName}`);
  if (observed.action !== expectedAction) throw new Error(`Authorization gate failed: fresh next action is ${observed.action}, not ${expectedAction}`);
  if (observed.authority !== '5sHs3Gjw43Csi9WN582iqoHUZrVZE8LhyJ7xqtcoQFCw') throw new Error('Authorization gate failed: active C4 authority changed');
}

function ceilRatio(value: Rational): bigint {
  return (value.numerator + value.denominator - 1n) / value.denominator;
}

async function buildMiningLoopPreview(sage: ReturnType<typeof createSageClient>, fleet: FleetView, scope: MiningLoopScope = DEFAULT_MINING_SCOPE): Promise<CopperLoopPreview> {
  const home = await sage.systems.byId(scope.homeSystemId, { commitment: 'confirmed', policy: 'no-store' });
  if (home.name !== scope.homeSystemName) throw new Error(`C4 system id ${scope.homeSystemId} is ${home.name}, not ${scope.homeSystemName}`);
  const asteroids = await home.asteroids.all({ commitment: 'confirmed', policy: 'no-store' });
  const asteroid = asteroids.find((candidate) => String(candidate.address) === scope.destinationAddress);
  if (!asteroid) throw new Error(`C4 asteroid ${scope.destinationName} was not found in ${scope.homeSystemName}`);
  const ids = scope.resourceIds ?? [scope.resourceId];
  const resourceCargo = await Promise.all(ids.map(id => resolveCargo(sage.context, id)));
  const food = await resolveCargo(sage.context, 1);
  const resources = resourceCargo.map(cargo => {
    const definition = asteroid.details.resources.find(resource => resource.cargoId === cargo.id);
    if (!definition) throw new Error(`${cargo.name} is not available at ${scope.destinationName}`);
    return { id: cargo.id, richness: { numerator: definition.richness.raw, denominator: RICHNESS_SCALE },
      storagePerUnit: { numerator: BigInt(cargo.storageCost), denominator: CARGO_STORAGE_SCALE } };
  });
  const preservedCargoStorageRaw = fleet.cargoHold.items
    .filter(item => item.id !== food.id && !ids.includes(item.id))
    .reduce((total, item) => total + (item.amount * BigInt(item.storageCost) + CARGO_STORAGE_SCALE - 1n) / CARGO_STORAGE_SCALE, 0n);
  const plan = calculateMultiResourceFoodPlan({
    cargoCapacityRaw: fleet.capacities.cargo.total, preservedCargoStorageRaw, resources,
    fleetUnitsPerSecond: { numerator: fleet.stats.cargo.miningRate.raw, denominator: FLEET_RATE_SCALE },
    foodStoragePerUnit: { numerator: BigInt(food.storageCost), denominator: CARGO_STORAGE_SCALE },
    foodUnitsPerSecond: { numerator: fleet.stats.cargo.foodConsumptionRate.raw, denominator: FLEET_RATE_SCALE },
    ammoAmountRaw: fleet.capacities.ammo.total,
    ammoUnitsPerSecond: { numerator: fleet.stats.cargo.ammoConsumptionRate.raw, denominator: FLEET_RATE_SCALE },
  });
  const sameSystem = home.coordinates.x === fleet.location.x && home.coordinates.y === fleet.location.y;
  return {
    fleet: fleet.name,
    fleetAddress: fleet.address,
    homeSystem: home.name,
    asteroid: asteroid.name,
    sameSystem,
    resource: resourceCargo.map(cargo => cargo.name).join(', '),
    limitingEvent: plan.limitingEvent,
    foodForCargoRaw: plan.foodForCargoRaw.toString(),
    foodForAmmoRaw: plan.foodForAmmoRaw.toString(),
    foodToLoadRaw: plan.foodToLoadRaw.toString(),
    expectedCopperRaw: plan.copperAtStopRaw.toString(),
    expectedResources: plan.outputs.map((output, index) => ({
      id: output.id,
      name: resourceCargo[index]!.name,
      expectedRaw: output.amountRaw.toString(),
    })),
    targetMiningSeconds: ceilRatio(plan.targetMiningSeconds).toString(),
    ammoBankTargetRaw: fleet.capacities.ammo.total.toString(),
    fuelTankTargetRaw: fleet.capacities.fuel.total.toString(),
    unavoidableFoodRoundingRaw: plan.unavoidableFoodRoundingRaw.toString(),
    mode: 'preview-only',
  };
}

function cargoAmount(fleet: FleetView, cargoId: number): bigint {
  return fleet.cargoHold.items.find((item) => item.id === cargoId)?.amount ?? 0n;
}

function activeProfileKey(profile: Awaited<ReturnType<ReturnType<typeof createSageClient>['profiles']['get']>>): { authority: ReturnType<typeof address>; keyIndex: number } {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const keyIndex = profile.keys.findIndex((key) => key.expiresAt === undefined || key.expiresAt > now);
  if (keyIndex < 0) throw new Error('The Player Profile has no active authorization key');
  return { authority: profile.keys[keyIndex].address, keyIndex };
}

export async function getActiveC4ProfileAuthority(settings: AppSettings): Promise<string> {
  if (!settings.playerProfile) throw new Error('Configure a Player Profile before authorizing a signer');
  const rpc = createSolanaRpc(settings.rpcUrl);
  const sage = createSageClient({ cluster: 'zink-ptr', rpc, writeRpc: rpc });
  const profile = await sage.profiles.get(address(settings.playerProfile), { commitment: 'confirmed', policy: 'no-store' });
  return activeProfileKey(profile).authority;
}

/** Plans the docked refill (food/ammo/fuel toFleet) with AEPA's own storage
 * accounting. Regression fix: atlas-kit 0.5.0's toFleet cargo-hold capacity
 * check bills `amount x storageCost` without the /256 normalization, so a
 * 13-Food refill was rejected as 3328 raw units against the fleet's 249-unit
 * hold. This mirrors the service-bundle instruction assembly, which divides
 * by CARGO_STORAGE_SCALE and is the only capacity math that fits C4 raw units.
 */
async function planMiningCargoLoad(
  sage: ReturnType<typeof createSageClient>,
  fleet: FleetView,
  character: Awaited<ReturnType<ReturnType<typeof createSageClient>['characters']['forProfile']>>,
  authorization: { profile: ReturnType<typeof address>; authority: ReturnType<typeof address>; keyIndex: number },
  decision: { foodRaw: bigint; ammoRaw: bigint; fuelRaw: bigint },
  scope: MiningLoopScope,
): Promise<Plan> {
  if (fleet.state.kind !== 'docked') throw new PlannerStageError(`Cargo refill requires ${fleet.name} to be docked, not ${fleet.state.kind}`);
  const system = fleet.state.system.address;
  const starbasePlayer = await getStarbasePlayerForCharacterAtSystem(sage.context, character.address, system, { commitment: 'confirmed', policy: 'no-store' });
  const food = await resolveCargo(sage.context, 1);
  assertCopperLoadFitsCargoStorage({
    cargoCapacityRaw: fleet.capacities.cargo.total,
    cargoUsedRaw: fleet.cargoHold.storageCost,
    foodRaw: decision.foodRaw,
    foodStorageCost: BigInt(food.storageCost),
  });
  if (decision.ammoRaw > 0n && fleet.ammo.amount + decision.ammoRaw > fleet.capacities.ammo.total) {
    throw new PlannerStageError(`Refill ammo ${decision.ammoRaw.toString()} would exceed the ${fleet.capacities.ammo.total.toString()} Ammo bank capacity`);
  }
  if (decision.fuelRaw > 0n && fleet.fuel.amount + decision.fuelRaw > fleet.capacities.fuel.total) {
    throw new PlannerStageError(`Refill fuel ${decision.fuelRaw.toString()} would exceed the ${fleet.capacities.fuel.total.toString()} Fuel tank capacity`);
  }
  for (const [cargoId, required] of [[1, decision.foodRaw], [fleet.ammo.id, decision.ammoRaw], [fleet.fuel.id, decision.fuelRaw]] as const) {
    if (required <= 0n) continue;
    const available = starbasePlayer.cargo.items.find((item) => item.id === cargoId)?.quantityRaw ?? 0n;
    if (available < required) {
      throw new PlannerStageError(`Starbase cargo id ${String(cargoId)} has ${available.toString()} raw units, but the refill requires ${required.toString()}; refresh the Starbase and retry`);
    }
  }
  const accounts: AccountMeta[] = [
    { address: authorization.authority, role: AccountRole.READONLY_SIGNER },
    { address: authorization.profile, role: AccountRole.WRITABLE },
    { address: address(SAGE_PROGRAM_ADDRESS), role: AccountRole.READONLY },
    { address: address('C4PRoFNroxxzdgeCoM31LJjYRg7kT6ymogSTAT99iD1u'), role: AccountRole.READONLY },
    { address: fleet.address, role: AccountRole.WRITABLE },
    { address: fleet.game, role: AccountRole.READONLY },
    { address: character.address, role: AccountRole.WRITABLE },
    { address: system, role: AccountRole.READONLY },
    { address: starbasePlayer.address, role: AccountRole.WRITABLE },
  ];
  const data = getTransferCargoToFleetInstructionDataEncoder().encode({
    ammoBank: decision.ammoRaw > 0n ? decision.ammoRaw : null,
    fuelTank: decision.fuelRaw > 0n ? decision.fuelRaw : null,
    cargoHold: {
      toLoad: decision.foodRaw > 0n ? [[1, decision.foodRaw]] : [],
      toUnload: [],
    },
    keyIndex: authorization.keyIndex,
  });
  const instruction: Instruction = Object.freeze({
    programAddress: address(SAGE_PROGRAM_ADDRESS),
    accounts: Object.freeze(accounts),
    data: data as ReadonlyUint8Array,
  });
  const summary = `Refill fleet ${fleet.name} at Starbase ${scope.homeSystemName}: load ${decision.foodRaw.toString()} Food, ${decision.ammoRaw.toString()} Ammo, and ${decision.fuelRaw.toString()} Fuel.`;
  return createPlan({
    kind: 'fleet.refill',
    summary,
    preconditions: [],
    steps: [{ instruction, describes: summary, signers: [authorization.authority] }],
  });
}

async function planForDecision(
  sage: ReturnType<typeof createSageClient>,
  fleet: FleetView,
  character: Awaited<ReturnType<ReturnType<typeof createSageClient>['characters']['forProfile']>>,
  home: Awaited<ReturnType<ReturnType<typeof createSageClient>['systems']['byId']>>,
  asteroid: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof createSageClient>['systems']['byId']>>['asteroids']['all']>>[number],
  authorization: { profile: ReturnType<typeof address>; authority: ReturnType<typeof address>; keyIndex: number },
  decision: AutomaticMiningDecision,
  rpcUrl: string,
  scope: MiningLoopScope,
): Promise<Plan> {
  if (decision.kind === 'register-starbase') return planRegisterStarbasePlayer(sage.context, character, home, { funder: authorization.authority });
  if (decision.kind === 'dock') return planFleetDock(sage.context, fleet, { authorization });
  if (decision.kind === 'undock') return planFleetUndock(sage.context, fleet, { authorization });
  if (decision.kind === 'unload') {
    const cargoHold = [
      ...(scope.resourceIds ?? [scope.resourceId]).map(cargoId => ({ cargoId, amount: cargoAmount(fleet, cargoId) })).filter(item => item.amount > 0n),
      ...(decision.foodRaw > 0n ? [{ cargoId: 1, amount: decision.foodRaw }] : []),
    ];
    return planFleetTransferCargoAtStarbase(sage.context, fleet, { authorization, direction: 'toStarbase', amounts: { cargoHold } });
  }
  if (decision.kind === 'load') {
    return planMiningCargoLoad(sage, fleet, character, authorization, decision, scope);
  }
  if (decision.kind === 'start-mining') {
    const ids = scope.resourceIds ?? [scope.resourceId];
    const research = await getResearchCatalog(sage.context);
    const resources = await Promise.all(ids.map(async id => {
      const cargo = await resolveCargo(sage.context, id);
      return {
        id,
        name: cargo.name,
        ...resolveMiningResourceEligibility(cargo.categoryId, character, research.nodes),
      };
    }));
    assertMiningResourcesAvailable(ids, resources);
    return planStartMiningResource({ authorization, fleet: fleet.address, character: character.address, system: home.address, regionTracker: REGION_TRACKER, asteroid: asteroid.address, game: fleet.game, resourceIds: ids, fleetName: fleet.name, asteroidName: asteroid.name, resourceName: scope.resourceName });
  }
  if (decision.kind === 'stop-mining') {
    const [careerXp, guardedStopPlan]: [StopMiningCareerXpAccounts, Plan] = await Promise.all([
      resolveStopMiningCareerXp(rpcUrl, fleet.game, character.address).catch((error: unknown) => {
        throw new Error(`Career-XP budget accounts for stop-mining could not be resolved: ${(error as Error)?.message ?? String(error)}`);
      }),
      planFleetStopMining(sage.context, fleet, { authorization }),
    ]);
    return appendStopMiningCareerXp(guardedStopPlan, careerXp);
  }
  throw new Error(decision.kind === 'blocked' ? decision.reason : `The next action is waiting until ${decision.untilUnixSeconds.toString()}`);
}

async function prepareNextCopperStep(
  sage: ReturnType<typeof createSageClient>,
  settings: AppSettings,
  forcedAction?: AuthorizedLiveAction,
  targetStopAtUnixSeconds?: bigint,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope: MiningLoopScope = DEFAULT_MINING_SCOPE,
) {
  const observed = await observeMiningLoop(sage, settings, targetStopAtUnixSeconds, fleetName, fleetAddress, scope);
  const decision = forcedAction === 'stop-mining' && observed.fleet.state.kind === 'mining'
    ? { kind: 'stop-mining' as const }
    : observed.decision;
  const plan = await planForDecision(sage, observed.fleet, observed.character, observed.home, observed.asteroid, observed.authorization, decision, settings.rpcUrl, scope);
  return { ...observed, decision, plan };
}

async function observeMiningLoop(
  sage: ReturnType<typeof createSageClient>,
  settings: AppSettings,
  targetStopAtUnixSeconds?: bigint,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope: MiningLoopScope = DEFAULT_MINING_SCOPE,
) {
  const profileAddress = address(settings.playerProfile);
  const [profile, character, home] = await Promise.all([
    sage.profiles.get(profileAddress, { commitment: 'confirmed', policy: 'no-store' }),
    sage.characters.forProfile(profileAddress, { commitment: 'confirmed', policy: 'no-store' }),
    sage.systems.byId(scope.homeSystemId, { commitment: 'confirmed', policy: 'no-store' }),
  ]);
  if (home.name !== scope.homeSystemName) throw new Error(`Configured Home Starbase system is ${home.name}, not ${scope.homeSystemName}`);
  const fleets = await character.fleets.all({ commitment: 'confirmed', policy: 'no-store' });
  const fleet = fleets.find((candidate) => fleetAddress ? String(candidate.address) === fleetAddress : candidate.name === fleetName);
  if (!fleet) throw new Error(`Fleet ${fleetName} was not found`);
  if (fleet.name !== fleetName) throw new Error(`Fleet identity mismatch: ${fleetAddress} is ${fleet.name}, not ${fleetName}`);
  const asteroids = await home.asteroids.all({ commitment: 'confirmed', policy: 'no-store' });
  const asteroid = asteroids.find((candidate) => String(candidate.address) === scope.destinationAddress);
  if (!asteroid) throw new Error(`C4 asteroid ${scope.destinationName} was not found in ${scope.homeSystemName}`);
  const preview = await buildMiningLoopPreview(sage, fleet, scope);
  const key = activeProfileKey(profile);
  const authorization = { profile: profileAddress, authority: key.authority, keyIndex: key.keyIndex };
  const baseDecision = decideCopperLoopNextStep({
    state: fleet.state,
    atEternity: home.coordinates.x === fleet.location.x && home.coordinates.y === fleet.location.y,
    fleetName: fleet.name,
    homeSystemName: scope.homeSystemName,
    foodRaw: cargoAmount(fleet, 1),
    targetFoodRaw: BigInt(preview.foodToLoadRaw),
    copperRaw: (scope.resourceIds ?? [scope.resourceId]).reduce((sum, id) => sum + cargoAmount(fleet, id), 0n),
    ammoRaw: fleet.ammo.amount,
    ammoTargetRaw: fleet.capacities.ammo.total,
    fuelRaw: fleet.fuel.amount,
    fuelTargetRaw: fleet.capacities.fuel.total,
    targetStopAtUnixSeconds,
  });
  let automaticDecision: AutomaticMiningDecision = baseDecision;
  if (baseDecision.kind === 'unload' || baseDecision.kind === 'load') {
    const starbases = await character.starbases.all({ commitment: 'confirmed', policy: 'no-store' });
    const registered = starbases.some(starbase => starbase.system.address === home.address);
    if (requireStarbaseRegistration(baseDecision, registered)) automaticDecision = { kind: 'register-starbase' };
  }
  return { decision: automaticDecision, fleet, key, character, home, asteroid, authorization, preview };
}

function stringifyServiceAmounts(amounts: ServiceBundleAmounts): Record<keyof ServiceBundleAmounts, string> {
  return {
    copperToStarbaseRaw: amounts.copperToStarbaseRaw.toString(),
    foodToFleetRaw: amounts.foodToFleetRaw.toString(),
    ammoToFleetRaw: amounts.ammoToFleetRaw.toString(),
    fuelToFleetRaw: amounts.fuelToFleetRaw.toString(),
  };
}

async function prepareServiceBundle(sage: ReturnType<typeof createSageClient>, settings: AppSettings) {
  const profileAddress = address(settings.playerProfile);
  const [profile, character] = await Promise.all([
    sage.profiles.get(profileAddress, { commitment: 'confirmed', policy: 'no-store' }),
    sage.characters.forProfile(profileAddress, { commitment: 'confirmed', policy: 'no-store' }),
  ]);
  const fleets = await character.fleets.all({ commitment: 'confirmed', policy: 'no-store' });
  const fleet = fleets.find((candidate) => candidate.name === 'MF-01');
  if (!fleet) throw new Error('Fleet MF-01 was not found');
  if (fleet.state.kind !== 'docked') throw new Error(`Service bundle requires MF-01 to be docked, not ${fleet.state.kind}`);
  const preview = await buildMiningLoopPreview(sage, fleet);
  const key = activeProfileKey(profile);
  const authorization = { profile: profileAddress, authority: key.authority, keyIndex: key.keyIndex };
  const amounts = calculateServiceBundleAmounts({
    copperRaw: cargoAmount(fleet, 311),
    foodRaw: cargoAmount(fleet, 1),
    targetFoodRaw: BigInt(preview.foodToLoadRaw),
    ammoRaw: fleet.ammo.amount,
    ammoTargetRaw: fleet.capacities.ammo.total,
    fuelRaw: fleet.fuel.amount,
    fuelTargetRaw: fleet.capacities.fuel.total,
  });
  const system = fleet.state.system.address;
  const starbasePlayer = await getStarbasePlayerForCharacterAtSystem(sage.context, character.address, system, { commitment: 'confirmed', policy: 'no-store' });
  for (const [cargoId, required] of [[1, amounts.foodToFleetRaw], [fleet.ammo.id, amounts.ammoToFleetRaw], [fleet.fuel.id, amounts.fuelToFleetRaw]] as const) {
    const available = starbasePlayer.cargo.items.find((item) => item.id === cargoId)?.quantityRaw ?? 0n;
    if (available < required) throw new Error(`Starbase cargo id ${cargoId} has ${available.toString()}, but the service bundle requires ${required.toString()}`);
  }
  const food = await resolveCargo(sage.context, 1);
  const copper = await resolveCargo(sage.context, 311);
  const unloadStorageRaw = (amounts.copperToStarbaseRaw * BigInt(copper.storageCost) + CARGO_STORAGE_SCALE - 1n) / CARGO_STORAGE_SCALE;
  const loadStorageRaw = (amounts.foodToFleetRaw * BigInt(food.storageCost) + CARGO_STORAGE_SCALE - 1n) / CARGO_STORAGE_SCALE;
  const resultingStorageRaw = fleet.cargoHold.storageCost - unloadStorageRaw + loadStorageRaw;
  if (resultingStorageRaw < 0n || resultingStorageRaw > fleet.capacities.cargo.total) throw new Error('The service bundle would violate Fleet cargo capacity');
  const accounts: AccountMeta[] = [
    { address: key.authority, role: AccountRole.READONLY_SIGNER },
    { address: profileAddress, role: AccountRole.WRITABLE },
    { address: address(SAGE_PROGRAM_ADDRESS), role: AccountRole.READONLY },
    { address: address('C4PRoFNroxxzdgeCoM31LJjYRg7kT6ymogSTAT99iD1u'), role: AccountRole.READONLY },
    { address: fleet.address, role: AccountRole.WRITABLE },
    { address: fleet.game, role: AccountRole.READONLY },
    { address: character.address, role: AccountRole.WRITABLE },
    { address: system, role: AccountRole.READONLY },
    { address: starbasePlayer.address, role: AccountRole.WRITABLE },
  ];
  const data = getTransferCargoToFleetInstructionDataEncoder().encode({
    ammoBank: amounts.ammoToFleetRaw > 0n ? amounts.ammoToFleetRaw : null,
    fuelTank: amounts.fuelToFleetRaw > 0n ? amounts.fuelToFleetRaw : null,
    cargoHold: {
      toLoad: amounts.foodToFleetRaw > 0n ? [[1, amounts.foodToFleetRaw]] : [],
      toUnload: [[311, amounts.copperToStarbaseRaw]],
    },
    keyIndex: key.keyIndex,
  });
  const instruction: Instruction = Object.freeze({ programAddress: address(SAGE_PROGRAM_ADDRESS), accounts: Object.freeze(accounts), data: data as ReadonlyUint8Array });
  const summary = `Service fleet MF-01 atomically: unload ${amounts.copperToStarbaseRaw.toString()} Copper Ore; load ${amounts.foodToFleetRaw.toString()} Food, ${amounts.ammoToFleetRaw.toString()} Ammo, and ${amounts.fuelToFleetRaw.toString()} Fuel.`;
  const plan = createPlan({ kind: 'fleet.service-bundle', summary, preconditions: [], steps: [{ instruction, describes: summary, signers: [key.authority] }] });
  return { fleet, key, amounts, plan };
}

export async function simulateServiceBundle(settings: AppSettings): Promise<ServiceBundleSimulation> {
  if (!settings.playerProfile) throw new Error('Configure a Player Profile before simulating the service bundle');
  const rpc = createSolanaRpc(settings.rpcUrl);
  const sage = createSageClient({ cluster: 'zink-ptr', rpc, writeRpc: rpc });
  try {
    const prepared = await prepareServiceBundle(sage, settings);
    assertAuthorizedCopperStep('load', { fleet: prepared.fleet.name, action: 'load', authority: prepared.key.authority });
    const simulation = await simulatePlan(sage.context, prepared.plan, { feePayer: prepared.key.authority });
    return {
      fleet: 'MF-01',
      action: 'service-bundle',
      summary: prepared.plan.summary,
      authority: prepared.key.authority,
      keyIndex: prepared.key.keyIndex,
      amounts: stringifyServiceAmounts(prepared.amounts),
      unitsConsumed: (simulation.unitsConsumed ?? 0n).toString(),
      logs: simulation.logs,
      plan: prepared.plan.toJSON(),
      submitted: false,
    };
  } finally {
    await sage.dispose();
  }
}

export async function executeAuthorizedServiceBundleOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  onProgress?: (stage: string, details?: Readonly<Record<string, string>>) => void,
): Promise<LiveServiceBundleResult> {
  if (!settings.playerProfile) throw new Error('Configure a Player Profile before executing the service bundle');
  const rpc = createSolanaRpc(settings.rpcUrl);
  const sage = createSageClient({ cluster: 'zink-ptr', rpc, writeRpc: rpc });
  try {
    const prepared = await prepareServiceBundle(sage, settings);
    assertAuthorizedCopperStep('load', { fleet: prepared.fleet.name, action: 'load', authority: prepared.key.authority });
    onProgress?.('fresh-service-verified', { fleet: prepared.fleet.name, authority: prepared.key.authority, ...stringifyServiceAmounts(prepared.amounts) });
    const transaction = await assemblePlan(sage.context, prepared.plan, { feePayer: prepared.key.authority, commitment: 'confirmed' });
    onProgress?.('transaction-assembled');
    const submission = await signAndSendTransactionOnce(rpc, transaction, secretKey, prepared.key.authority, onProgress);
    const confirmationDeadline = Date.now() + 90_000;
    let confirmed: { confirmationStatus: 'confirmed' | 'finalized'; slot: bigint } | undefined;
    while (Date.now() < confirmationDeadline) {
      try {
        const statuses = await rpc.getSignatureStatuses([submission.signature as Signature], { searchTransactionHistory: true }).send();
        const status = statuses.value[0];
        if (status?.err != null) throw new Error(`Submitted service bundle failed: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
          confirmed = { confirmationStatus: status.confirmationStatus, slot: status.slot };
          break;
        }
      } catch (error) {
        if (String((error as Error)?.message ?? error).startsWith('Submitted service bundle failed:')) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!confirmed) throw new Error(`Service bundle ${submission.signature} was submitted once but confirmation was not observed within 90 seconds; it must not be resubmitted`);
    const targetFoodRaw = cargoAmount(prepared.fleet, 1) + prepared.amounts.foodToFleetRaw;
    const stateDeadline = Date.now() + 45_000;
    let resultingFleetState = '';
    let serviceObserved = false;
    while (Date.now() < stateDeadline) {
      const snapshot = await loadC4Fleets(settings);
      const fleet = snapshot.fleets.find((candidate) => candidate.name === 'MF-01');
      const json = fleet?.snapshot as {
        cargoHold?: { items?: Array<{ id: number; amount: unknown }> };
        ammo?: { amount: unknown };
        fuel?: { amount: unknown };
      } | undefined;
      const foodRaw = BigInt(String(json?.cargoHold?.items?.find((item) => item.id === 1)?.amount ?? 0));
      const copperRaw = BigInt(String(json?.cargoHold?.items?.find((item) => item.id === 311)?.amount ?? 0));
      const ammoRaw = BigInt(String(json?.ammo?.amount ?? 0));
      const fuelRaw = BigInt(String(json?.fuel?.amount ?? 0));
      resultingFleetState = fleet?.state ?? '';
      if (fleet?.state === 'docked' && copperRaw === 0n && foodRaw === targetFoodRaw && ammoRaw === prepared.fleet.capacities.ammo.total && fuelRaw === prepared.fleet.capacities.fuel.total) {
        serviceObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!serviceObserved) throw new Error(`Service bundle ${submission.signature} confirmed, but the exact docked serviced balances were not observed within 45 seconds`);
    return {
      fleet: 'MF-01', action: 'service-bundle', summary: prepared.plan.summary,
      authority: prepared.key.authority, keyIndex: prepared.key.keyIndex,
      amounts: stringifyServiceAmounts(prepared.amounts), transactionSignature: submission.signature,
      plan: prepared.plan.toJSON(),
      submitted: true, confirmationStatus: confirmed.confirmationStatus,
      confirmationSlot: confirmed.slot.toString(), resultingFleetState,
    };
  } finally {
    await sage.dispose();
  }
}

export async function simulateNextCopperStep(settings: AppSettings): Promise<CopperStepSimulation> {
  if (!settings.playerProfile) throw new Error('Configure a Player Profile before simulating automation');
  const rpc = createSolanaRpc(settings.rpcUrl);
  const sage = createSageClient({ cluster: 'zink-ptr', rpc, writeRpc: rpc });
  try {
    const { decision, key, plan } = await prepareNextCopperStep(sage, settings);
    const simulation = await simulatePlan(sage.context, plan, { feePayer: key.authority });
    return {
      nextStep: decision.kind,
      summary: plan.summary,
      authority: key.authority,
      keyIndex: key.keyIndex,
      unitsConsumed: (simulation.unitsConsumed ?? 0n).toString(),
      logs: simulation.logs,
      plan: plan.toJSON(),
      submitted: false,
    };
  } finally {
    await sage.dispose();
  }
}

export async function simulateAuthorizedStopMiningNow(settings: AppSettings): Promise<CopperStepSimulation> {
  if (!settings.playerProfile) throw new Error('Configure a Player Profile before simulating an early mining stop');
  const rpc = createSolanaRpc(settings.rpcUrl);
  const sage = createSageClient({ cluster: 'zink-ptr', rpc, writeRpc: rpc });
  try {
    const { decision, fleet, key, plan } = await prepareNextCopperStep(sage, settings, 'stop-mining');
    assertAuthorizedCopperStep('stop-mining', { fleet: fleet.name, action: decision.kind, authority: key.authority });
    const simulation = await simulatePlan(sage.context, plan, { feePayer: key.authority });
    return {
      nextStep: decision.kind,
      summary: plan.summary,
      authority: key.authority,
      keyIndex: key.keyIndex,
      unitsConsumed: (simulation.unitsConsumed ?? 0n).toString(),
      logs: simulation.logs,
      plan: plan.toJSON(),
      submitted: false,
    };
  } finally {
    await sage.dispose();
  }
}

export async function simulateNextCopperStepSigned(settings: AppSettings, secretKey: Uint8Array): Promise<SignedCopperStepSimulation> {
  if (!settings.playerProfile) throw new Error('Configure a Player Profile before simulating automation');
  const rpc = createSolanaRpc(settings.rpcUrl);
  const sage = createSageClient({ cluster: 'zink-ptr', rpc, writeRpc: rpc });
  try {
    const { decision, key, plan } = await prepareNextCopperStep(sage, settings);
    const transaction = await assemblePlan(sage.context, plan, { feePayer: key.authority, commitment: 'confirmed' });
    const simulation = await signAndSimulateTransaction(rpc, transaction, secretKey, key.authority);
    return {
      nextStep: decision.kind,
      summary: plan.summary,
      authority: key.authority,
      keyIndex: key.keyIndex,
      unitsConsumed: (simulation.unitsConsumed ?? 0n).toString(),
      logs: simulation.logs,
      plan: plan.toJSON(),
      transactionSignature: simulation.signature,
      signatureVerified: true,
      simulationSlot: simulation.slot.toString(),
      submitted: false,
    };
  } finally {
    await sage.dispose();
  }
}

/** Reads fresh chain state without signing or sending. */
export async function inspectNextCopperStep(settings: AppSettings, targetStopAtUnixSeconds?: bigint, fleetName = 'MF-01', fleetAddress?: string, scope: MiningLoopScope = DEFAULT_MINING_SCOPE): Promise<{
  decision: AutomaticMiningDecision;
  targetMiningSeconds: bigint;
}> {
  if (!settings.playerProfile) throw new Error('Configure a Player Profile before inspecting automation');
  const rpc = createSolanaRpc(settings.rpcUrl);
  const sage = createSageClient({ cluster: 'zink-ptr', rpc, writeRpc: rpc });
  try {
    const observed = await observeMiningLoop(sage, settings, targetStopAtUnixSeconds, fleetName, fleetAddress, scope);
    return { decision: observed.decision, targetMiningSeconds: BigInt(observed.preview.targetMiningSeconds) };
  } finally {
    await sage.dispose();
  }
}

/** Executes only one explicitly authorized MF-01 action. It performs one
 * signature-verified simulation, one send call, then read-only confirmation and
 * state checks. It never retries or advances to the following action.
 */
async function executeAuthorizedCopperStepOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  expectedAction: AuthorizedLiveAction,
  onProgress?: (stage: string, details?: Readonly<Record<string, string>>) => void,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope: MiningLoopScope = DEFAULT_MINING_SCOPE,
): Promise<LiveCopperStepResult> {
  if (!settings.playerProfile) throw new Error(`Configure a Player Profile before executing the authorized ${expectedAction}`);
  const rpc = createSolanaRpc(settings.rpcUrl);
  const sage = createSageClient({ cluster: 'zink-ptr', rpc, writeRpc: rpc });
  try {
    const prepared = await prepareNextCopperStep(sage, settings, expectedAction, undefined, fleetName, fleetAddress, scope);
    assertAuthorizedCopperStep(expectedAction, {
      fleet: prepared.fleet.name,
      action: prepared.decision.kind,
      authority: prepared.key.authority,
    }, fleetName);
    onProgress?.('fresh-action-verified', { action: prepared.decision.kind, authority: prepared.key.authority, fleet: prepared.fleet.name });

    const transaction = await assemblePlan(sage.context, prepared.plan, { feePayer: prepared.key.authority, commitment: 'confirmed' });
    onProgress?.('transaction-assembled');
    // Pre-send simulation gate: verify the signed transaction read-only before
    // broadcasting. Any program rejection (e.g. the deployed StarFrame
    // "Career XP budget required" check) surfaces here, nothing is submitted,
    // and the runner pauses with the real reason instead of a doomed broadcast.
    const simulation = await signAndSimulateTransaction(rpc, transaction, secretKey, prepared.key.authority);
    onProgress?.('simulation-verified', { slot: simulation.slot.toString() });
    const submission = await signAndSendTransactionOnce(rpc, transaction, secretKey, prepared.key.authority, onProgress);

    const confirmationDeadline = Date.now() + 90_000;
    let confirmed: { confirmationStatus: 'confirmed' | 'finalized'; slot: bigint } | undefined;
    while (Date.now() < confirmationDeadline) {
      try {
        const statuses = await rpc.getSignatureStatuses([submission.signature as Signature], { searchTransactionHistory: true }).send();
        const status = statuses.value[0];
        if (status?.err != null) throw new Error(`Submitted ${expectedAction} transaction failed: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
          confirmed = { confirmationStatus: status.confirmationStatus, slot: status.slot };
          break;
        }
      } catch (error) {
        if (String((error as Error)?.message ?? error).startsWith(`Submitted ${expectedAction} transaction failed:`)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!confirmed) throw new Error(`${expectedAction} transaction ${submission.signature} was submitted once but confirmation was not observed within 90 seconds; it must not be resubmitted`);

    const stateDeadline = Date.now() + 45_000;
    let resultingFleetState: string;
    let resultingNextStep: string;
    if (expectedAction === 'start-mining') {
      let miningFleet: Awaited<ReturnType<typeof loadC4Fleets>>['fleets'][number] | undefined;
      while (Date.now() < stateDeadline) {
        const snapshot = await loadC4Fleets(settings);
        miningFleet = snapshot.fleets.find((fleet) => fleetAddress ? fleet.address === fleetAddress : fleet.name === fleetName);
        if (miningFleet?.state === 'mining') break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (miningFleet?.state !== 'mining') throw new Error(`start-mining transaction ${submission.signature} confirmed, but mining state was not observed within 45 seconds`);
      resultingFleetState = miningFleet.state;
      resultingNextStep = 'waiting';
    } else {
      let resulting = await prepareNextCopperStep(sage, settings, undefined, undefined, fleetName, fleetAddress, scope);
      while (resulting.decision.kind === expectedAction && Date.now() < stateDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        resulting = await prepareNextCopperStep(sage, settings, undefined, undefined, fleetName, fleetAddress, scope);
      }
      if (resulting.decision.kind === expectedAction) throw new Error(`${expectedAction} transaction ${submission.signature} confirmed, but the resulting fleet state was not observed within 45 seconds`);
      resultingFleetState = resulting.fleet.state.kind;
      resultingNextStep = resulting.decision.kind;
    }

    return {
      fleet: fleetName,
      action: expectedAction,
      summary: prepared.plan.summary,
      authority: prepared.key.authority,
      keyIndex: prepared.key.keyIndex,
      transactionSignature: submission.signature,
      submitted: true,
      confirmationStatus: confirmed.confirmationStatus,
      confirmationSlot: confirmed.slot.toString(),
      resultingFleetState,
      resultingNextStep,
    };
  } finally {
    await sage.dispose();
  }
}

export function executeAuthorizedRegisterStarbaseOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  onProgress?: (stage: string, details?: Readonly<Record<string, string>>) => void,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope: MiningLoopScope = DEFAULT_MINING_SCOPE,
): Promise<LiveCopperStepResult> {
  return executeAuthorizedCopperStepOnce(settings, secretKey, 'register-starbase', onProgress, fleetName, fleetAddress, scope);
}

export function executeAuthorizedDockOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  onProgress?: (stage: string, details?: Readonly<Record<string, string>>) => void,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope: MiningLoopScope = DEFAULT_MINING_SCOPE,
): Promise<LiveCopperStepResult> {
  return executeAuthorizedCopperStepOnce(settings, secretKey, 'dock', onProgress, fleetName, fleetAddress, scope);
}

export function executeAuthorizedUnloadOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  onProgress?: (stage: string, details?: Readonly<Record<string, string>>) => void,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope: MiningLoopScope = DEFAULT_MINING_SCOPE,
): Promise<LiveCopperStepResult> {
  return executeAuthorizedCopperStepOnce(settings, secretKey, 'unload', onProgress, fleetName, fleetAddress, scope);
}

export function executeAuthorizedLoadOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  onProgress?: (stage: string, details?: Readonly<Record<string, string>>) => void,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope: MiningLoopScope = DEFAULT_MINING_SCOPE,
): Promise<LiveCopperStepResult> {
  return executeAuthorizedCopperStepOnce(settings, secretKey, 'load', onProgress, fleetName, fleetAddress, scope);
}

export function executeAuthorizedUndockOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  onProgress?: (stage: string, details?: Readonly<Record<string, string>>) => void,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope: MiningLoopScope = DEFAULT_MINING_SCOPE,
): Promise<LiveCopperStepResult> {
  return executeAuthorizedCopperStepOnce(settings, secretKey, 'undock', onProgress, fleetName, fleetAddress, scope);
}

export function executeAuthorizedStartMiningOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  onProgress?: (stage: string, details?: Readonly<Record<string, string>>) => void,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope: MiningLoopScope = DEFAULT_MINING_SCOPE,
): Promise<LiveCopperStepResult> {
  return executeAuthorizedCopperStepOnce(settings, secretKey, 'start-mining', onProgress, fleetName, fleetAddress, scope);
}

export function executeAuthorizedStopMiningOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  onProgress?: (stage: string, details?: Readonly<Record<string, string>>) => void,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope: MiningLoopScope = DEFAULT_MINING_SCOPE,
): Promise<LiveCopperStepResult> {
  return executeAuthorizedCopperStepOnce(settings, secretKey, 'stop-mining', onProgress, fleetName, fleetAddress, scope);
}

function countShips(snapshot: unknown): number {
  const ships = (snapshot as { ships?: Array<{ quantity?: unknown }> })?.ships;
  if (!Array.isArray(ships)) return 0;
  return ships.reduce((total, ship) => {
    const quantity = typeof ship.quantity === 'bigint' ? ship.quantity : BigInt(String(ship.quantity ?? 0));
    return total + Number(quantity);
  }, 0);
}

export interface MiningLoopRequest {
  fleetName: string;
  fleetAddress?: string;
  scope: MiningLoopScope;
}

export async function loadC4Fleets(settings: AppSettings, requestedLoops?: readonly MiningLoopRequest[]): Promise<{
  characterAddress: string;
  fleets: FleetRecord[];
  copperLoop: CopperLoopPreview;
  copperLoops: CopperLoopPreview[];
  chainSlot: string;
}> {
  if (!settings.playerProfile) throw new Error('Configure a Player Profile before loading fleets');
  const rpc = createSolanaRpc(settings.rpcUrl);
  const sage = createSageClient({ cluster: 'zink-ptr', rpc });
  try {
    const character = await sage.characters.forProfile(address(settings.playerProfile));
    const fleets = await character.fleets.all({ commitment: 'confirmed', policy: 'no-store' });
    const requests = requestedLoops?.length
      ? requestedLoops
      : [{ fleetName: 'MF-01', scope: DEFAULT_MINING_SCOPE }];
    const copperLoops = await Promise.all(requests.map(async (request) => {
      const miningFleet = fleets.find((fleet) => request.fleetAddress ? fleet.address === request.fleetAddress : fleet.name === request.fleetName);
      if (!miningFleet) throw new Error(`Fleet ${request.fleetName} was not found`);
      return buildMiningLoopPreview(sage, miningFleet, request.scope);
    }));
    const copperLoop = copperLoops[0]!;
    const chainSlot = await rpc.getSlot({ commitment: 'confirmed' }).send();
    const updatedAt = new Date().toISOString();
    return {
      characterAddress: character.address,
      copperLoop,
      copperLoops,
      chainSlot: chainSlot.toString(),
      fleets: fleets.map((fleet) => {
        const snapshot = fleet.toJSON();
        return {
          address: fleet.address,
          profile: settings.playerProfile,
          name: fleet.name,
          state: fleet.state.kind,
          shipCount: countShips(snapshot),
          snapshot,
          updatedAt,
        };
      }),
    };
  } finally {
    await sage.dispose();
  }
}
