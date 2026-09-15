import {
  executeAuthorizedDockOnce,
  executeAuthorizedLoadOnce,
  executeAuthorizedStartMiningOnce,
  executeAuthorizedStopMiningOnce,
  executeAuthorizedUndockOnce,
  executeAuthorizedUnloadOnce,
  inspectNextCopperStep,
  type AuthorizedLiveAction,
  type LiveCopperStepResult,
} from './c4.js';
import type { AppSettings } from './settings.js';

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
