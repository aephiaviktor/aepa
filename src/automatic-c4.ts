import {
  executeNextMiningStepOnce,
  PLAN_STAGE_MARKER,
  type AuthorizedLiveAction,
  type MiningLoopScope,
} from './c4.js';
import type { AppSettings } from './settings.js';
import type { AutomationStopMode } from './automation-stop.js';
import { ActionStageTimer, formatActionTimings, type ActionStage } from './action-timing.js';

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
  resultingFleetState: string;
  resultingNextStep: string;
  targetStopAtUnixSeconds?: bigint;
  continueImmediately?: boolean;
};

type ProgressCallback = (stage: string, details?: Readonly<Record<string, string>>) => void;

/** Executes at most one action from one fresh observation/client session.
 * The selected Plan reuses that observation, then Atlas Kit revalidates its
 * preconditions before AEPA signs, simulates, sends once, and confirms.
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
  const timer = new ActionStageTimer();
  const completedByProgress: Readonly<Record<string, ActionStage>> = {
    'automatic-observation-complete': 'observation',
    'fresh-action-verified': 'planning',
    'transaction-assembled': 'atlas-prepare',
    'simulation-verified': 'simulation',
    'send-returned': 'send',
    'transaction-confirmed': 'confirmation',
    'post-state-observed': 'post-state',
  };
  const timedProgress: ProgressCallback = (stage, details) => {
    const completed = completedByProgress[stage];
    if (completed) timer.complete(completed);
    onProgress?.(stage, details);
  };
  const execution = await executeNextMiningStepOnce(
    settings,
    secretKey,
    targetStopAtUnixSeconds,
    timedProgress,
    fleetName,
    fleetAddress,
    scope,
    stopMode,
  );
  if (execution.kind !== 'confirmed') return execution;
  const { action, result, targetStopAtUnixSeconds: targetStop } = execution;
  return {
    kind: 'confirmed',
    action,
    signature: result.transactionSignature,
    resultingFleetState: result.resultingFleetState,
    resultingNextStep: result.resultingNextStep,
    detail: `${result.summary}; ${result.confirmationStatus} at slot ${result.confirmationSlot}; resulting state ${result.resultingFleetState}; ${formatActionTimings(timer.snapshot())}`,
    continueImmediately: result.resultingNextStep !== 'waiting',
    ...(targetStop === undefined ? {} : { targetStopAtUnixSeconds: targetStop }),
  };
}
