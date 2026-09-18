import {
  SAGE_PROGRAM_ADDRESS,
  getStartMiningAsteroidInstructionDataEncoder,
  getStopMiningAsteroidInstructionDataEncoder,
} from '@staratlas/dev-sage';
import { AccountRole, address, type AccountMeta, type Address, type Instruction, type ReadonlyUint8Array } from '@solana/kit';
import { createPlan, type Plan } from '@aephia/atlas-kit/planning';

const PROFILE_VALIDATION_PROGRAM = address('C4PRoFNroxxzdgeCoM31LJjYRg7kT6ymogSTAT99iD1u');
const SAGE_ADDRESS = address(SAGE_PROGRAM_ADDRESS);

export interface MiningAuthorization {
  profile: Address;
  authority: Address;
  keyIndex: number;
  certificate?: Address;
}

export interface StartMiningPlanInput {
  authorization: MiningAuthorization;
  fleet: Address;
  character: Address;
  system: Address;
  regionTracker: Address;
  asteroid: Address;
  game: Address;
  resourceIds: readonly number[];
  fleetName: string;
  asteroidName: string;
  resourceName: string;
}

export interface StopMiningPlanInput {
  authorization: MiningAuthorization;
  fleet: Address;
  character: Address;
  asteroid: Address;
  game: Address;
  regionTracker?: Address;
  crewBinding?: Address;
  fleetName: string;
  /** Career-XP budget accounts the post-reset C4 StarFrame program requires on
   * the stop-mining instruction (xp_runtime). Resolved from the Game account's
   * points config + the points program + PDAs; without them the deployed
   * program rejects the stop with
   * "Career XP budget required - xp_budget_accounts_required".
   * Mirror of the trailing account group SLYA sends for the same instruction. */
  careerXp?: StopMiningCareerXpAccounts;
}

export interface StopMiningCareerXpAccounts {
  pilot: XpBudgetAccounts;
  mining: XpBudgetAccounts;
  councilRank: XpBudgetAccounts;
  progressionConfig: Address;
  pointsProgram: Address;
}

export interface XpBudgetAccounts {
  userPointsAccount: Address;
  pointsCategory: Address;
  pointsModifierAccount: Address;
}

const readonly = (value: Address) => ({ address: value, role: AccountRole.READONLY });
const writable = (value: Address) => ({ address: value, role: AccountRole.WRITABLE });
const readonlySigner = (value: Address) => ({ address: value, role: AccountRole.READONLY_SIGNER });

function validateAuthorization(value: MiningAuthorization): void {
  if (!Number.isSafeInteger(value.keyIndex) || value.keyIndex < 0 || value.keyIndex > 65_535) {
    throw new RangeError('Mining authorization key index must be an integer from 0 through 65535');
  }
}

function instruction(accounts: AccountMeta[], data: ReadonlyUint8Array): Instruction {
  return Object.freeze({ programAddress: SAGE_ADDRESS, accounts: Object.freeze(accounts), data });
}

export function planStartMiningCopper(input: StartMiningPlanInput): Plan {
  validateAuthorization(input.authorization);
  const resources = [...input.resourceIds];
  if (resources.length !== 1 || resources[0] !== 311) throw new RangeError('The first AEPA mining loop permits only Copper Ore cargo id 311');
  const ix = instruction([
    readonlySigner(input.authorization.authority),
    writable(input.authorization.profile),
    readonly(input.authorization.certificate ?? SAGE_ADDRESS),
    readonly(PROFILE_VALIDATION_PROGRAM),
    writable(input.fleet),
    writable(input.character),
    readonly(input.system),
    writable(input.regionTracker),
    writable(input.asteroid),
    readonly(input.game),
  ], getStartMiningAsteroidInstructionDataEncoder().encode({ keyIndex: input.authorization.keyIndex, resources }));
  const description = `Start fleet ${input.fleetName} mining ${input.resourceName} at asteroid ${input.asteroidName}.`;
  return createPlan({
    kind: 'fleet.mining.start',
    summary: description,
    steps: [{ instruction: ix, describes: description, signers: [input.authorization.authority] }],
    preconditions: [],
  });
}

export function planStopMiningCopper(input: StopMiningPlanInput): Plan {
  validateAuthorization(input.authorization);
  const ix = instruction([
    readonlySigner(input.authorization.authority),
    writable(input.authorization.profile),
    readonly(input.authorization.certificate ?? SAGE_ADDRESS),
    readonly(PROFILE_VALIDATION_PROGRAM),
    writable(input.character),
    writable(input.fleet),
    readonly(input.game),
    writable(input.asteroid),
    input.crewBinding ? writable(input.crewBinding) : readonly(SAGE_ADDRESS),
    input.regionTracker ? readonly(input.regionTracker) : readonly(SAGE_ADDRESS),
    ...(input.careerXp ? careerXpAccountMetas(input.careerXp) : []),
  ], getStopMiningAsteroidInstructionDataEncoder().encode({ keyIndex: input.authorization.keyIndex }));
  const description = `Stop fleet ${input.fleetName} mining and settle its Copper Ore output.`;
  return createPlan({
    kind: 'fleet.mining.stop',
    summary: description,
    steps: [{ instruction: ix, describes: description, signers: [input.authorization.authority] }],
    preconditions: [],
  });
}

/** Career-XP budget account metas the post-reset C4 StarFrame program requires
 * when settling a mining session. The failed stop reached the XP runtime with
 * every other account accepted and was rejected solely with
 * "Career XP budget required - xp_budget_accounts_required", so only these
 * trailing budget accounts are appended: the three XP budget groups (each
 * userPointsAccount, pointsCategory, pointsModifierAccount), then the
 * ProgressionConfig and the points program.
 */
function careerXpAccountMetas(xp: NonNullable<StopMiningPlanInput['careerXp']>): AccountMeta[] {
  return [
    // pilot budget
    writable(xp.pilot.userPointsAccount),
    readonly(xp.pilot.pointsCategory),
    readonly(xp.pilot.pointsModifierAccount),
    // mining budget
    writable(xp.mining.userPointsAccount),
    readonly(xp.mining.pointsCategory),
    readonly(xp.mining.pointsModifierAccount),
    // council-rank budget
    writable(xp.councilRank.userPointsAccount),
    readonly(xp.councilRank.pointsCategory),
    readonly(xp.councilRank.pointsModifierAccount),
    readonly(xp.progressionConfig),
    readonly(xp.pointsProgram),
  ];
}
