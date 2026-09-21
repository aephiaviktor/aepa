import {
  executeAuthorizedDockOnce,
  executeAuthorizedLoadOnce,
  executeAuthorizedRegisterStarbaseOnce,
  executeAuthorizedStartMiningOnce,
  executeAuthorizedStopMiningOnce,
  executeAuthorizedUndockOnce,
  executeAuthorizedUnloadOnce,
  inspectNextCopperStep,
  PLAN_STAGE_MARKER,
  type AuthorizedLiveAction,
  type LiveCopperStepResult,
  type MiningLoopScope,
} from './c4.js';
import type { AppSettings } from './settings.js';
import { stoppingDirective, type AutomationStopMode } from './automation-stop.js';

export { PLAN_STAGE_MARKER };

const POST_SUBMISSION_PATTERNS = [
  /submitted once but confirmation was not observed/i,
  /must not be resubmitted/i,
  /confirmed, but .* was not observed within/i,
];

/** True when a runner error message proves a transaction left this process.
 * Such pauses must be reconciled out of band and are never auto-cleared.
 */
export function isPostSubmissionFailure(message: string): boolean {
  return POST_SUBMISSION_PATTERNS.some((pattern) => pattern.test(message));
}

/** Marks a pause reason as plan-stage (nothing submitted) unless the message
 * already proves a submission happened.
 */
export function planStageReason(message: string): string {
  return isPostSubmissionFailure(message) ? message : `${PLAN_STAGE_MARKER} ${message}`;
}

export type AutomaticCopperStepResult = {
  kind: 'waiting';
  untilUnixSeconds: bigint;
  detail: string;
} | {
  kind: 'stopped';
  detail: string;
} | {
  kind: 'confirmed';
  action: AuthorizedLiveAction;
  signature: string;
  detail: string;
  targetStopAtUnixSeconds?: bigint;
};

type ProgressCallback = (stage: string, details?: Readonly<Record<string, string>>) => void;
type ActionExecutor = (settings: AppSettings, secretKey: Uint8Array, onProgress?: ProgressCallback, fleetName?: string, fleetAddress?: string, scope?: MiningLoopScope) => Promise<LiveCopperStepResult>;

const ACTION_EXECUTORS: Readonly<Record<AuthorizedLiveAction, ActionExecutor>> = {
  'register-starbase': executeAuthorizedRegisterStarbaseOnce,
  dock: executeAuthorizedDockOnce,
  unload: executeAuthorizedUnloadOnce,
  load: executeAuthorizedLoadOnce,
  undock: executeAuthorizedUndockOnce,
  'start-mining': executeAuthorizedStartMiningOnce,
  'stop-mining': executeAuthorizedStopMiningOnce,
};

/** Executes at most one action selected from a read-only fresh-state inspection.
 * The action-specific executor re-reads state, verifies the exact action and
 * authority, signs, simulates, sends once, and confirms before returning.
 */
export async function executeNextCopperStepOnce(
  settings: AppSettings,
  secretKey: Uint8Array,
  targetStopAtUnixSeconds?: bigint,
  onProgress?: ProgressCallback,
  fleetName = 'MF-01',
  fleetAddress?: string,
  scope?: MiningLoopScope,
  stopMode?: AutomationStopMode,
): Promise<AutomaticCopperStepResult> {
  const inspection = await inspectNextCopperStep(settings, targetStopAtUnixSeconds, fleetName, fleetAddress, scope);
  const directive = stopMode
    ? stoppingDirective(stopMode, inspection.fleetState, inspection.decision.kind)
    : 'continue';
  if (directive === 'complete') {
    return { kind: 'stopped', detail: `Fleet ${fleetName} is docked at ${scope?.homeSystemName ?? 'Home Starbase'}, unloaded, refilled, and Automation is disabled` };
  }
  if (directive === 'continue' && inspection.decision.kind === 'wait') {
    return {
      kind: 'waiting',
      untilUnixSeconds: inspection.decision.untilUnixSeconds,
      detail: `Mining remains active until ${inspection.decision.untilUnixSeconds.toString()}`,
    };
  }
  if (directive === 'continue' && inspection.decision.kind === 'blocked') throw new Error(inspection.decision.reason);
  const action = directive === 'stop-mining' || directive === 'dock'
    ? directive
    : inspection.decision.kind as AuthorizedLiveAction;
  const targetStop = action === 'start-mining'
    ? BigInt(Math.floor(Date.now() / 1_000)) + inspection.targetMiningSeconds
    : undefined;
  onProgress?.('automatic-action-selected', {
    action,
    ...(targetStop === undefined ? {} : { targetStopAtUnixSeconds: targetStop.toString() }),
  });
  const result = await ACTION_EXECUTORS[action](settings, secretKey, onProgress, fleetName, fleetAddress, scope);
  return {
    kind: 'confirmed',
    action,
    signature: result.transactionSignature,
    detail: `${result.summary}; ${result.confirmationStatus} at slot ${result.confirmationSlot}; resulting state ${result.resultingFleetState}`,
    ...(targetStop === undefined ? {} : { targetStopAtUnixSeconds: targetStop }),
  };
}
