import { loadScanningRegions, scanSectorRegion } from './scanning-regions.js';
import { createSageClient, type FleetView } from '@aephia/atlas-kit';
import { sage as bindings } from '@aephia/atlas-kit/bindings';
import { maybeGetScanPattern, maybeGetScanPatternPolicy, maybeGetScanSignalForFleet, deriveScanSignalTiming, deriveScanRecoveryRange } from '@aephia/atlas-kit/scanning';
import { planOpenScanSignal, planDetectSignal, planResolveSignal, planRecoverSignal, planExpireSignal, planForfeitScanSignalEntropy, planAbandonSignal, planAcknowledgeScanResult } from '@aephia/atlas-kit/scanning/actions';
import { planFleetDock, planFleetUndock, planFleetSubwarp, planFleetSettleArrival } from '@aephia/atlas-kit/fleets/actions';
import { planFleetTransferCargoAtStarbase } from '@aephia/atlas-kit/cargo/actions';
import { planRegisterStarbasePlayer } from '@aephia/atlas-kit/starbases/actions';
import { getStarbasePlayerForCharacterAtSystem } from '@aephia/atlas-kit/starbases';
import { address, createSolanaRpc } from '@solana/kit';
import type { Plan } from '@aephia/atlas-kit/planning';
import type { AutomationAssignmentRecord, AepaDatabase } from './database.js';
import type { AppSettings } from './settings.js';
import type { AutomaticStepOutcome } from './automation-runner.js';
import { scanCargoCosts, validateScanSector, scanningPatternOption } from './scanning-model.js';
import { decideScanningStep, type ScanningAction } from './scanning-loop.js';
import { scanningServiceTargets, scanningTransfers, travelFuelBudget } from './scanning-logistics.js';
import { scanningPhase, setScanningPhase, captureScanReceipt } from './scanning-store.js';
import { executeGuardedPlan } from './guarded-plan.js';

const READ = {commitment: 'confirmed', policy: 'no-store'} as const;
const CLOCK = address('SysvarC1ock11111111111111111111111111111111');
export const SCANNING_WARP_UNAVAILABLE = 'Warp scanning is unavailable: AtlasKit does not support Warp arrival settlement. Select Subwarp.';
type Client = ReturnType<typeof createSageClient>;
type Rpc = ReturnType<typeof createSolanaRpc>;

async function scanClock(rpc: Rpc) {
  const result = await rpc.getAccountInfo(CLOCK, {commitment: 'confirmed', encoding: 'base64'}).send();
  if (!result.value || result.value.owner !== 'Sysvar1111111111111111111111111111111111111') throw new Error('Canonical chain Clock is unavailable');
  const bytes = Buffer.from(result.value.data[0], 'base64');
  if (bytes.length !== 40) throw new Error('Invalid chain Clock');
  return {slot: bytes.readBigUInt64LE(0), unixSeconds: bytes.readBigInt64LE(32)};
}
/** Public pinned bindings supply exact I8F56 bits. Do not reconstruct these
 * from Fleet display coordinates (scanning guide's recovery-range contract). */
async function exactFleetPosition(rpc: Rpc, fleet: FleetView) {
  const result = await rpc.getAccountInfo(fleet.address, {commitment: 'confirmed', encoding: 'base64'}).send();
  if (!result.value || result.value.owner !== bindings.SAGE_PROGRAM_ADDRESS || result.value.executable) throw new Error('Invalid Fleet coordinate account');
  const bytes = Buffer.from(result.value.data[0], 'base64');
  if (!Buffer.from(bytes.subarray(0,8)).equals(Buffer.from(bindings.FLEET_DISCRIMINATOR))) throw new Error('Invalid Fleet discriminator');
  const raw = bindings.getFleetDecoder().decode(bytes);
  if (raw.ownerProfile !== fleet.ownerProfile.address || raw.gameId !== fleet.game) throw new Error('Fleet coordinate identity changed');
  if (raw.state.__kind !== 'Idle') throw new Error('Fleet moved during scanning observation; refresh');
  return {x: {raw: raw.location[0].raw, value: fleet.location.x}, y: {raw: raw.location[1].raw, value: fleet.location.y}};
}
function equalPoint(a: {x:number;y:number}, b: {x:number;y:number}) { return a.x === b.x && a.y === b.y; }

async function observeScanning(client: Client, rpc: Rpc, settings: AppSettings, assignment: AutomationAssignmentRecord, phase: ReturnType<typeof scanningPhase>) {
  if (assignment.assignment !== 'scanning' || assignment.profile !== settings.playerProfile) throw new Error('Scanning assignment does not match Settings');
  const sector = validateScanSector(assignment.scanSectorX, assignment.scanSectorY);
  if (!Number.isInteger(assignment.scanPatternId)) throw new Error('Missing saved Scan Pattern');
  const profileAddress = address(settings.playerProfile);
  const [fleet, profile, character, home, signal, clock, pattern, policy] = await Promise.all([
    client.fleets.get(address(assignment.fleetAddress), READ), client.profiles.get(profileAddress, READ),
    client.characters.forProfile(profileAddress, READ), client.systems.byId(assignment.homeSystemId, READ),
    maybeGetScanSignalForFleet(client.context, address(assignment.fleetAddress), READ), scanClock(rpc),
    maybeGetScanPattern(client.context, assignment.scanPatternId!, READ),
    maybeGetScanPatternPolicy(client.context, assignment.scanPatternId!, READ),
  ]);
  if (fleet.name !== assignment.fleetName || fleet.ownerProfile.address !== profileAddress || String(home.address) !== assignment.homeSystemAddress) throw new Error('Scanning Fleet/Profile/Home identity mismatch');
  const keyIndex = profile.keys.findIndex(key => key.expiresAt === undefined || key.expiresAt > clock.unixSeconds);
  if (keyIndex < 0) throw new Error('No active Profile authority');
  const authorization = {profile: profileAddress, authority: profile.keys[keyIndex]!.address, keyIndex};
  const region = scanSectorRegion(await loadScanningRegions(client.context,rpc,character.modifiers.values.researchTags),sector.x,sector.y);
  const patternOption = pattern ? scanningPatternOption(pattern,policy,character.modifiers.values.researchTags) : undefined;
  let eligibility = !!patternOption?.available && !!region?.available;
  let unavailableReason = patternOption?.requirement ?? region?.requirement ?? 'Scan pattern or sector is not available';
  const costs = scanCargoCosts(fleet.stats.misc.scanCost, (pattern?.costs ?? [])).map(row => ({...row, storageCost: pattern!.costs.find(cost => cost.cargo.id === row.cargoId)!.cargo.storageCost}));
  let targets: ReturnType<typeof scanningServiceTargets> = [];
  if (!assignment.pendingAssignment && eligibility) {
    try { targets = scanningServiceTargets(costs, fleet.capacities.cargo.total); }
    catch(error) { eligibility = false; unavailableReason = String((error as Error).message); }
  }
  const transfers = scanningTransfers(fleet.cargoHold.items, targets);
  const tankLoad = fleet.capacities.fuel.remaining;
  const atHome = fleet.state.kind === 'docked' ? fleet.state.system.address === home.address : equalPoint(fleet.location, home.coordinates);
  const atSector = equalPoint(fleet.location, sector);
  const timing = deriveScanSignalTiming(signal, clock);
  let contactInRange = false;
  if (signal?.status === 'contact' && fleet.state.kind === 'idle') {
    const range = deriveScanRecoveryRange(signal, await exactFleetPosition(rpc, fleet));
    contactInRange = range.kind === 'contact' && range.withinRange;
  }
  const contactPoint = signal?.contact ? {x:signal.contact.target.x.value,y:signal.contact.target.y.value} : undefined;
  const rate = fleet.stats.movement.subwarpFuelConsumptionRate.value;
  const budget = (point: {x:number;y:number}) => travelFuelBudget(fleet.location, point, home.coordinates, rate);
  const contactReachable = contactPoint !== undefined && fleet.fuel.amount >= budget(contactInRange ? fleet.location : contactPoint)
    && (fleet.state.kind === 'docked' || contactInRange || !equalPoint(fleet.location, contactPoint));
  const suppliesReady = !!eligibility && costs.every(cost => (fleet.cargoHold.items.find(row => row.id === cost.cargoId)?.amount ?? 0n) >= cost.amount)
    && fleet.capacities.cargo.remaining > fleet.capacities.cargo.total / 4n
    && fleet.fuel.amount >= budget(sector);
  let registered = true;
  if (atHome && fleet.state.kind === 'idle') {
    try { await getStarbasePlayerForCharacterAtSystem(client.context, character.address, home.address, READ); }
    catch (error) { if ((error as {code?: string}).code !== 'ACCOUNT_NOT_FOUND') throw error; registered = false; }
  }
  const decision = decideScanningStep({
    fleetState: fleet.state.kind, atHome, atSector, registered, now: clock.unixSeconds,
    cooldown: fleet.scanCooldownExpiresAt > (signal?.cooldownEndsAtUnixSeconds ?? 0n) ? fleet.scanCooldownExpiresAt : signal?.cooldownEndsAtUnixSeconds ?? 0n,
    arrivesAt: fleet.state.kind === 'subwarp' || fleet.state.kind === 'warp' ? fleet.state.arrivesAtUnixSeconds : undefined,
    signal: signal?.status ?? 'absent', entropy: timing.entropy?.phase, contactExpired: timing.contactExpiry?.expired,
    contactInRange, contactReachable, suppliesReady,
    serviceUnload: transfers.unload.length > 0, serviceLoad: transfers.load.length > 0 || tankLoad > 0n,
    phase, stop: assignment.stopMode ?? (assignment.pendingAssignment ? 'end-of-cycle' : undefined),
  });
  return {fleet, character, home, signal, clock, authorization, decision, transfers, tankLoad, sector, contactPoint, budget, atHome, suppliesReady, eligibility, unavailableReason};
}
type Observation = Awaited<ReturnType<typeof observeScanning>>;

async function planScanningAction(client: Client, observed: Observation, action: ScanningAction, assignment: AutomationAssignmentRecord): Promise<Plan> {
  const {fleet, authorization, home, character, transfers, tankLoad} = observed;
  const options = {authorization};
  switch(action) {
    case 'scan-open': return planOpenScanSignal(client.context, fleet.address, options);
    case 'scan-detect': return planDetectSignal(client.context, fleet.address, {...options, patternId: assignment.scanPatternId!, focus:'any'});
    case 'scan-resolve': return planResolveSignal(client.context, fleet.address);
    case 'scan-recover': return planRecoverSignal(client.context, fleet.address, options);
    case 'scan-expire': return planExpireSignal(client.context, fleet.address);
    case 'scan-forfeit': return planForfeitScanSignalEntropy(client.context, fleet.address);
    case 'scan-abandon': return planAbandonSignal(client.context, fleet.address, options);
    case 'scan-acknowledge': return planAcknowledgeScanResult(client.context, fleet.address, options);
    case 'register-starbase': return planRegisterStarbasePlayer(client.context, character, home, {funder: authorization.authority});
    case 'dock': return planFleetDock(client.context, fleet, options);
    case 'undock': return planFleetUndock(client.context, fleet, options);
    case 'settle-arrival': return planFleetSettleArrival(client.context, fleet, options);
    case 'unload': return planFleetTransferCargoAtStarbase(client.context, fleet, {...options, direction:'toStarbase', amounts:{cargoHold:transfers.unload}});
    case 'load': return planFleetTransferCargoAtStarbase(client.context, fleet, {...options, direction:'toFleet', amounts:{
      ...(tankLoad > 0n ? {fuel:tankLoad}:{}), ...(transfers.load.length ? {cargoHold:transfers.load}:{}),
    }});
    case 'travel-home': case 'travel-sector': case 'travel-contact': {
      if (assignment.travelMode !== 'subwarp') throw new Error(SCANNING_WARP_UNAVAILABLE);
      const destination = action === 'travel-home' ? home.coordinates : action === 'travel-sector' ? observed.sector : observed.contactPoint;
      if (!destination) throw new Error('Missing contact destination');
      if (fleet.fuel.amount < observed.budget(destination)) throw new Error('Insufficient fuel for the selected leg plus return home reserve');
      return planFleetSubwarp(client.context, fleet, {...options, destination});
    }
  }
}

async function scanPostcondition(client: Client, before: Observation, action: ScanningAction): Promise<boolean> {
  const fleet = await client.fleets.get(before.fleet.address, READ);
  if (action.startsWith('scan-')) {
    const signal = await maybeGetScanSignalForFleet(client.context, fleet.address, READ);
    if (action === 'scan-open') return signal?.status === 'empty';
    if (!signal || !before.signal || signal.sequence <= before.signal.sequence) return false;
    const expected: Partial<Record<ScanningAction, readonly string[]>> = {
      'scan-detect':['pending-entropy'], 'scan-resolve':['contact','no-contact'], 'scan-recover':['recovered'],
      'scan-expire':['expired'], 'scan-forfeit':['no-contact'], 'scan-abandon':['abandoned'], 'scan-acknowledge':['empty'],
    };
    return expected[action]?.includes(signal.status) ?? false;
  }
  if (action === 'register-starbase') {
    await getStarbasePlayerForCharacterAtSystem(client.context, before.character.address, before.home.address, READ);
    return true;
  }
  if (action === 'dock') return fleet.state.kind === 'docked' && fleet.state.system.address === before.home.address;
  if (action === 'undock') return fleet.state.kind === 'idle';
  if (action.startsWith('travel-')) {
    const destination = action === 'travel-home' ? before.home.coordinates : action === 'travel-sector' ? before.sector : before.contactPoint!;
    return fleet.state.kind === 'subwarp' && equalPoint(fleet.state.to,destination);
  }
  if (action === 'settle-arrival') return fleet.state.kind === 'idle' && before.fleet.state.kind === 'subwarp' && equalPoint(fleet.location, before.fleet.state.to);
  const changes = action === 'unload' ? before.transfers.unload : before.transfers.load;
  return changes.every(row => {
    const previous = before.fleet.cargoHold.items.find(item => item.id === row.cargoId)?.amount ?? 0n;
    const current = fleet.cargoHold.items.find(item => item.id === row.cargoId)?.amount ?? 0n;
    return current === previous + (action === 'unload' ? -row.amount : row.amount);
  }) && (action !== 'load' || fleet.fuel.amount === before.fleet.fuel.amount + before.tankLoad);
}

export async function inspectScanningStep(settings: AppSettings, assignment: AutomationAssignmentRecord, phase: ReturnType<typeof scanningPhase>) {
  const rpc = createSolanaRpc(settings.rpcUrl);
  const client = createSageClient({cluster:'zink-ptr', rpc});
  try { return (await observeScanning(client,rpc,settings,assignment,phase)).decision; }
  finally { await client.dispose(); }
}

export async function executeNextScanningStepOnce(settings: AppSettings, secretKey: Uint8Array, assignment: AutomationAssignmentRecord, database: AepaDatabase): Promise<AutomaticStepOutcome> {
  if (assignment.travelMode !== 'subwarp') throw new Error(SCANNING_WARP_UNAVAILABLE);
  const rpc = createSolanaRpc(settings.rpcUrl);
  const client = createSageClient({cluster:'zink-ptr', rpc, writeRpc:rpc});
  try {
    let phase = scanningPhase(database.db, assignment.profile, assignment.fleetAddress);
    const initialPhase = phase;
    let observed = await observeScanning(client,rpc,settings,assignment,phase);
    const persist = (value: typeof phase) => { setScanningPhase(database.db,assignment.profile,assignment.fleetAddress,value); phase = value; };
    if (phase === 'scanning' && (!observed.suppliesReady || assignment.stopMode || assignment.pendingAssignment)) persist('returning');
    if (phase === 'returning' && observed.atHome && observed.fleet.state.kind === 'docked') persist('servicing');
    // Reobserve only when the persisted phase changes the decision. Action
    // planners and executePlan independently refresh their own prerequisites.
    if (phase !== initialPhase) observed = await observeScanning(client,rpc,settings,assignment,phase);
    const decision = observed.decision;
    if (decision.kind === 'blocked') throw new Error(decision.reason);
    if (decision.kind === 'wait') return {kind:'waiting',untilUnixSeconds:decision.until,detail:decision.detail};
    if (decision.kind === 'stopped') return {kind:'stopped',detail:'Scanning Fleet is serviced at Home Starbase'};
    if ((decision.kind === 'scan-open' || decision.kind === 'scan-detect') && !observed.eligibility) throw new Error(observed.unavailableReason);
    if (decision.kind === 'scan-acknowledge') captureScanReceipt(database.db,assignment.profile,assignment.fleetAddress,observed.signal!);
    if (decision.kind === 'undock' && observed.atHome && observed.signal?.status !== 'contact') {
      if (!observed.eligibility) throw new Error(observed.unavailableReason);
      if (!observed.suppliesReady) throw new Error('Fleet cannot carry the scan supplies, recovery space and round-trip fuel reserve; adjust the assignment');
      persist('scanning');
    }
    const plan = await planScanningAction(client,observed,decision.kind,assignment);
    const result = await executeGuardedPlan({settings, context:client.context, rpc, plan, authority:observed.authorization.authority,
      secretKey, fleetAddress:assignment.fleetAddress, observeConfirmed:() => scanPostcondition(client,observed,decision.kind)});
    return {kind:'confirmed',action:decision.kind,signature:result.signature,detail:`${plan.summary}; confirmed at slot ${result.slot}`};
  } finally { await client.dispose(); }
}
