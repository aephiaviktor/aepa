import {
  SAGE_PROGRAM_ADDRESS,
  getStartMiningAsteroidInstructionDataEncoder,
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

export interface StopMiningCareerXpAccounts {
  pilot: XpBudgetAccounts;
  mining: XpBudgetAccounts;
  councilRank: XpBudgetAccounts;
  progressionConfig: Address;
  pointsProgram: Address;
}

export interface XpBudgetAccounts {
  careerXpBudget: Address;
  xpBudgetConfig: Address;
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

export function planStartMiningResource(input: StartMiningPlanInput): Plan {
  validateAuthorization(input.authorization);
  const resources = [...input.resourceIds];
  if (resources.length !== 1 || !Number.isSafeInteger(resources[0]) || resources[0] < 0 || resources[0] > 65_535) {
    throw new RangeError('AEPA mining requires exactly one valid cargo resource id');
  }
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

/** Career-XP budget account metas the post-reset C4 StarFrame program requires
 * when settling a mining session. The failed stop reached the XP runtime with
 * every other account accepted and was rejected solely with
 * "Career XP budget required - xp_budget_accounts_required", so only these
 * trailing budget accounts are appended: the three XP budget groups (each
 * CareerXpBudget, XpBudgetConfig, pointsModifierAccount), then the
 * ProgressionConfig and the points program.
 */
function careerXpAccountMetas(xp: StopMiningCareerXpAccounts): AccountMeta[] {
  return [
    // pilot budget
    writable(xp.pilot.careerXpBudget),
    readonly(xp.pilot.xpBudgetConfig),
    readonly(xp.pilot.pointsModifierAccount),
    // mining budget
    writable(xp.mining.careerXpBudget),
    readonly(xp.mining.xpBudgetConfig),
    readonly(xp.mining.pointsModifierAccount),
    // council-rank budget
    writable(xp.councilRank.careerXpBudget),
    readonly(xp.councilRank.xpBudgetConfig),
    readonly(xp.councilRank.pointsModifierAccount),
    readonly(xp.progressionConfig),
    readonly(xp.pointsProgram),
  ];
}

/** Extends Atlas Kit next's freshly guarded stop-mining Plan with the trailing
 * Career-XP accounts required by the post-reset StarFrame runtime. The native
 * planner remains responsible for canonical account selection and the
 * persisted fleet-mining safeguard; this function refuses any other layout. */
export function appendStopMiningCareerXp(plan: Plan, xp: StopMiningCareerXpAccounts): Plan {
  const step = plan.steps[0];
  const accounts = step?.instruction.accounts;
  const safeguard = plan.preconditions.find((value) => value.kind === 'fleet-mining');
  if (
    plan.steps.length !== 1 ||
    plan.kind !== 'fleet.stop-mining' ||
    step?.instruction.programAddress !== SAGE_ADDRESS ||
    step.instruction.data === undefined ||
    accounts?.length !== 10 ||
    safeguard === undefined ||
    accounts[5]?.address !== safeguard.address ||
    accounts[6]?.address !== safeguard.game ||
    accounts[1]?.address !== safeguard.profile ||
    accounts[7]?.address !== safeguard.asteroid
  ) {
    throw new Error('Atlas Kit returned an unsupported or unguarded stop-mining Plan');
  }
  return createPlan({
    kind: plan.kind,
    summary: plan.summary,
    steps: [{
      ...step,
      instruction: instruction([...accounts, ...careerXpAccountMetas(xp)], step.instruction.data),
    }],
    preconditions: plan.preconditions,
  });
}
