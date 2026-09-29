import type { AutomationAssignmentRecord, AepaDatabase } from './database.js';
import { PLAN_STAGE_MARKER, PlannerStageError } from './c4.js';
import { isPostSubmissionFailure } from './automatic-c4.js';

const FAST_FOLLOW_AFTER_CONFIRM_MS = 2_500;
const DEADLINE_RECHECK_DELAY_MS = 2_500;
const MIN_REFRESH_INTERVAL_MS = 15_000;
const MAX_CONTINUED_ACTIONS = 4;
const MAX_STALE_PLAN_REFRESHES = 2;
const STALE_PLAN_REFRESH_DELAY_MS = 1_000;

function isRefreshablePlanStateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === 'ACTION_PRECONDITION_FAILED'
    && !isPostSubmissionFailure(String(value.message ?? ''));
}

/** True when a paused assignment can be retried automatically: the pause is
 * plan-stage (nothing was submitted) and never a post-submission failure,
 * which must stay paused until chain state is reconciled out of band.
 */
export function shouldAutoRetryPaused(
  assignment: AutomationAssignmentRecord | undefined,
  hasPersistedTransportAttempt = false,
): boolean {
  if (!assignment || assignment.status !== 'paused') return false;
  if (assignment.assignment === 'transport' && hasPersistedTransportAttempt) return false;
  return !isPostSubmissionFailure(assignment.lastError ?? '');
}

/** After a confirmed action the runner should chain the next step almost
 * immediately (SLYA-style snappiness). A wait with a known deadline wakes at
 * that deadline; other outcomes keep the configured cadence with the same 15s
 * floor the scheduler already enforces.
 */
export function nextAutomationTickDelayMs(
  kind: AutomaticTickResult['kind'],
  refreshIntervalSeconds: number,
  untilUnixSeconds?: bigint,
  nowUnixMilliseconds = Date.now(),
): number {
  const refresh = Math.max(Math.trunc(refreshIntervalSeconds || 0), 15) * 1_000;
  if (kind === 'confirmed') return FAST_FOLLOW_AFTER_CONFIRM_MS;
  if (kind === 'waiting' && untilUnixSeconds !== undefined) {
    const remaining = untilUnixSeconds * 1_000n - BigInt(Math.trunc(nowUnixMilliseconds));
    if (remaining < BigInt(refresh)) return Math.max(DEADLINE_RECHECK_DELAY_MS, Number(remaining));
  }
  return Math.max(refresh, MIN_REFRESH_INTERVAL_MS);
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
  resultingFleetState?: string;
  resultingNextStep?: string;
  targetStopAtUnixSeconds?: bigint;
  /** Explicit opt-in: the confirmed post-state is safe to reobserve and use
   * for another distinct transaction in this same serialized runner tick. */
  continueImmediately?: boolean;
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
  private waitingUntil = new Map<string, bigint>();
  private prioritizedWaits = new Map<string, bigint>();

  constructor(
    private readonly database: AepaDatabase,
    private readonly executeStep: (assignment: AutomationAssignmentRecord) => Promise<AutomaticStepOutcome>,
    private readonly nowUnixSeconds: () => bigint = () => BigInt(Math.floor(Date.now() / 1_000)),
    private readonly wait: (delayMs: number) => Promise<void> = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
  ) {}

  async tick(): Promise<AutomaticTickResult> {
    if (this.running) return { kind: 'busy' };
    const runnable = this.database.listAutomationAssignments().filter((assignment) => assignment.enabled && assignment.status === 'running');
    if (runnable.length === 0) return { kind: 'idle' };
    for (const address of this.prioritizedStops.keys()) {
      if (!runnable.some(candidate => candidate.fleetAddress === address && candidate.stopMode)) this.prioritizedStops.delete(address);
    }
    for (const address of this.waitingUntil.keys()) {
      if (!runnable.some(candidate => candidate.fleetAddress === address)) {
        this.waitingUntil.delete(address);
        this.prioritizedWaits.delete(address);
      }
    }
    const urgent = runnable.find(candidate => candidate.stopMode && this.prioritizedStops.get(candidate.fleetAddress) !== candidate.stopRequestedAt);
    const now = this.nowUnixSeconds();
    const due = runnable
      .filter(candidate => {
        const until = this.waitingUntil.get(candidate.fleetAddress);
        return until !== undefined && until <= now && this.prioritizedWaits.get(candidate.fleetAddress) !== until;
      })
      .sort((left, right) => {
        const leftUntil = this.waitingUntil.get(left.fleetAddress)!;
        const rightUntil = this.waitingUntil.get(right.fleetAddress)!;
        return leftUntil < rightUntil ? -1 : leftUntil > rightUntil ? 1 : 0;
      })[0];
    let assignment = urgent ?? due ?? runnable[this.nextFleetIndex % runnable.length]!;
    if (urgent) this.prioritizedStops.set(urgent.fleetAddress, urgent.stopRequestedAt!);
    else if (!due) this.nextFleetIndex = (this.nextFleetIndex + 1) % runnable.length;
    this.running = true;
    try {
      let lastConfirmed: Extract<AutomaticTickResult, { kind: 'confirmed' }> | undefined;
      for (let continued = 0; continued < MAX_CONTINUED_ACTIONS; continued++) {
        let outcome: AutomaticStepOutcome;
        for (let refresh = 0; ; refresh++) {
          try {
            outcome = await this.executeStep(assignment);
            break;
          } catch (error) {
            if (!isRefreshablePlanStateError(error) || refresh >= MAX_STALE_PLAN_REFRESHES) throw error;
            await this.wait(STALE_PLAN_REFRESH_DELAY_MS);
          }
        }
        if (outcome.kind === 'waiting') {
          this.waitingUntil.set(assignment.fleetAddress, outcome.untilUnixSeconds);
          if (outcome.untilUnixSeconds <= this.nowUnixSeconds()) {
            this.prioritizedWaits.set(assignment.fleetAddress, outcome.untilUnixSeconds);
          }
          const marker = `waiting:${outcome.untilUnixSeconds.toString()}`;
          if (assignment.lastAction !== marker) {
            this.database.setAutomationLastAction(marker, assignment.fleetAddress);
            const action = assignment.assignment === 'mining' ? 'stop-mining' : assignment.assignment;
            this.database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'waiting', action, detail: outcome.detail });
          }
          return { kind: 'waiting', untilUnixSeconds: outcome.untilUnixSeconds };
        }
        this.waitingUntil.delete(assignment.fleetAddress);
        this.prioritizedWaits.delete(assignment.fleetAddress);
        if (outcome.kind === 'stopped') {
          this.database.completeAutomationStop(assignment.fleetAddress);
          this.database.recordAutomationActivity({ fleetAddress: assignment.fleetAddress, fleetName: assignment.fleetName, kind: 'disabled', action: 'stop-automation', detail: outcome.detail });
          return { kind: 'disabled' };
        }
        if (outcome.action === 'start-mining' && outcome.targetStopAtUnixSeconds === undefined) {
          throw new Error('Confirmed start-mining did not produce a durable target stop time');
        }
        const stopped = this.database.confirmAutomationAction({
          fleetAddress: assignment.fleetAddress,
          fleetName: assignment.fleetName,
          action: outcome.action,
          signature: outcome.signature,
          detail: outcome.detail,
          ...(assignment.stopMode && outcome.resultingFleetState === 'docked' && outcome.resultingNextStep === 'undock'
            ? { completeStop: { mode: assignment.stopMode, requestedAt: assignment.stopRequestedAt, updatedAt: assignment.updatedAt } }
            : {}),
          ...(outcome.targetStopAtUnixSeconds === undefined ? {} : { targetStopAtUnixSeconds: outcome.targetStopAtUnixSeconds }),
        });
        if (stopped) return { kind: 'disabled' };
        lastConfirmed = { kind: 'confirmed', action: outcome.action, signature: outcome.signature };
        if (!outcome.continueImmediately) return lastConfirmed;
        const refreshed = this.database.getAutomationAssignment(assignment.fleetAddress);
        if (!refreshed?.enabled || refreshed.status !== 'running') return lastConfirmed;
        assignment = refreshed;
      }
      return lastConfirmed!;
    } catch (error) {
      this.waitingUntil.delete(assignment.fleetAddress);
      this.prioritizedWaits.delete(assignment.fleetAddress);
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
