import {
  executeAuthorizedDockOnce,
  executeAuthorizedLoadOnce,
  executeAuthorizedStartMiningOnce,
  executeAuthorizedStopMiningOnce,
  executeAuthorizedUndockOnce,
  executeAuthorizedUnloadOnce,
  inspectNextCopperStep,
  PLAN_STAGE_MARKER,
  type AuthorizedLiveAction,
  type LiveCopperStepResult,
} from './c4.js';
import type { AppSettings } from './settings.js';

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
  kind: 'confirmed';
  action: AuthorizedLiveAction;
  signature: string;
  detail: string;
  targetStopAtUnixSeconds?: bigint;
};

type ProgressCallback = (stage: string, details?: Readonly<Record<string, string>>) => void;
type ActionExecutor = (settings: AppSettings, secretKey: Uint8Array, onProgress?: ProgressCallback) => Promise<LiveCopperStepResult>;

const ACTION_EXECUTORS: Readonly<Record<AuthorizedLiveAction, ActionExecutor>> = {
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
): Promise<AutomaticCopperStepResult> {
  const inspection = await inspectNextCopperStep(settings, targetStopAtUnixSeconds);
  if (inspection.decision.kind === 'wait') {
    return {
      kind: 'waiting',
      untilUnixSeconds: inspection.decision.untilUnixSeconds,
      detail: `Mining remains active until ${inspection.decision.untilUnixSeconds.toString()}`,
    };
  }
  if (inspection.decision.kind === 'blocked') throw new Error(inspection.decision.reason);
  const action = inspection.decision.kind;
  const targetStop = action === 'start-mining'
    ? BigInt(Math.floor(Date.now() / 1_000)) + inspection.targetMiningSeconds
    : undefined;
  onProgress?.('automatic-action-selected', {
    action,
    ...(targetStop === undefined ? {} : { targetStopAtUnixSeconds: targetStop.toString() }),
  });
  const result = await ACTION_EXECUTORS[action](settings, secretKey, onProgress);
  return {
    kind: 'confirmed',
    action,
    signature: result.transactionSignature,
    detail: `${result.summary}; ${result.confirmationStatus} at slot ${result.confirmationSlot}; resulting state ${result.resultingFleetState}`,
    ...(targetStop === undefined ? {} : { targetStopAtUnixSeconds: targetStop }),
  };
}
