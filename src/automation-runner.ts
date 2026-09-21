import type { AutomationAssignmentRecord, AepaDatabase } from './database.js';
import { PLAN_STAGE_MARKER, PlannerStageError } from './c4.js';
import { isPostSubmissionFailure } from './automatic-c4.js';

const FAST_FOLLOW_AFTER_CONFIRM_MS = 2_500;
const MIN_REFRESH_INTERVAL_MS = 15_000;

/** True when a paused assignment can be retried automatically: the pause is
 * plan-stage (nothing was submitted) and never a post-submission failure,
 * which must stay paused until chain state is reconciled out of band.
 */
export function shouldAutoRetryPaused(assignment: AutomationAssignmentRecord | undefined): boolean {
  if (!assignment || assignment.status !== 'paused') return false;
  return !isPostSubmissionFailure(assignment.lastError ?? '');
}

/** After a confirmed action the runner should chain the next step almost
 * immediately (SLYA-style snappiness) instead of waiting for the full
 * configured refresh interval. Waiting/idle/paused/busy keep the configured
 * cadence with the same 15s floor the scheduler already enforces.
 */
export function nextAutomationTickDelayMs(kind: AutomaticTickResult['kind'], refreshIntervalSeconds: number): number {
  const refresh = Math.max(Math.trunc(refreshIntervalSeconds || 0), 15) * 1_000;
  return kind === 'confirmed' ? FAST_FOLLOW_AFTER_CONFIRM_MS : Math.max(refresh, MIN_REFRESH_INTERVAL_MS);
}

export type AutomaticStepOutcome = {
  kind: 'waiting';
  untilUnixSeconds: bigint;
  detail: string;
} | {
  kind: 'stopped';
  detail: string;
} | {
  kind: 'confirmed';
  action: string;
  signature: string;
  detail: string;
  targetStopAtUnixSeconds?: bigint;
};

export type AutomaticTickResult =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'waiting'; untilUnixSeconds: bigint }
  | { kind: 'confirmed'; action: string; signature: string }
  | { kind: 'disabled' }
  | { kind: 'paused'; reason: string };

export class AutomaticCopperRunner {
  private running = false;
  private nextFleetIndex = 0;
  private prioritizedStops = new Map<string, string>();

  constructor(
    private readonly database: AepaDatabase,
    private readonly executeStep: (assignment: AutomationAssignmentRecord) => Promise<AutomaticStepOutcome>,
  ) {}

  async tick(): Promise<AutomaticTickResult> {
    if (this.running) return { kind: 'busy' };
    const runnable = this.database.listAutomationAssignments().filter((assignment) => assignment.enabled && assignment.status === 'running');
    if (runnable.length === 0) return { kind: 'idle' };
    for (const address of this.prioritizedStops.keys()) {
      if (!runnable.some(candidate => candidate.fleetAddress === address && candidate.stopMode)) this.prioritizedStops.delete(address);
    }
    const urgent = runnable.find(candidate => candidate.stopMode && this.prioritizedStops.get(candidate.fleetAddress) !== candidate.stopRequestedAt);
    const assignment = urgent ?? runnable[this.nextFleetIndex % runnable.length]!;
    if (urgent) this.prioritizedStops.set(urgent.fleetAddress, urgent.stopRequestedAt!);
    else this.nextFleetIndex = (this.nextFleetIndex + 1) % runnable.length;
    this.running = true;
    try {
      const outcome = await this.executeStep(assignment);
      if (outcome.kind === 'waiting') {
        const marker = `waiting:${outcome.untilUnixSeconds.toString()}`;
        if (assignment.lastAction !== marker) {
          this.database.setAutomationLastAction(marker, assignment.fleetAddress);
          this.database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'waiting', action: 'stop-mining', detail: outcome.detail });
        }
        return { kind: 'waiting', untilUnixSeconds: outcome.untilUnixSeconds };
      }
      if (outcome.kind === 'stopped') {
        this.database.completeAutomationStop(assignment.fleetAddress);
        this.database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'disabled', action: 'stop-automation', detail: outcome.detail });
        return { kind: 'disabled' };
      }
      if (outcome.action === 'start-mining' && outcome.targetStopAtUnixSeconds === undefined) {
        throw new Error('Confirmed start-mining did not produce a durable target stop time');
      }
      this.database.confirmAutomationAction({
        fleetAddress: assignment.fleetAddress,
        fleetName: assignment.fleetName,
        action: outcome.action,
        signature: outcome.signature,
        detail: outcome.detail,
        ...(outcome.targetStopAtUnixSeconds === undefined ? {} : { targetStopAtUnixSeconds: outcome.targetStopAtUnixSeconds }),
      });
      return { kind: 'confirmed', action: outcome.action, signature: outcome.signature };
    } catch (error) {
      const detail = String((error as Error)?.message ?? error);
      const planStage = error instanceof PlannerStageError ? `${PLAN_STAGE_MARKER} ` : '';
      const reason = `${planStage}${detail}. Automation paused; chain state must be inspected before any retry.`;
      this.database.pauseAutomation(reason, assignment.fleetAddress);
      this.database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'paused', detail: reason });
      return { kind: 'paused', reason };
    } finally {
      this.running = false;
    }
  }
}
