import type { AutomationAssignmentRecord, AepaDatabase } from './database.js';
import { PLAN_STAGE_MARKER, PlannerStageError } from './c4.js';

const FAST_FOLLOW_AFTER_CONFIRM_MS = 2_500;
const MIN_REFRESH_INTERVAL_MS = 15_000;

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
  | { kind: 'paused'; reason: string };

export class AutomaticCopperRunner {
  private running = false;

  constructor(
    private readonly database: AepaDatabase,
    private readonly executeStep: (assignment: AutomationAssignmentRecord) => Promise<AutomaticStepOutcome>,
  ) {}

  async tick(): Promise<AutomaticTickResult> {
    if (this.running) return { kind: 'busy' };
    const assignment = this.database.getAutomationAssignment();
    if (!assignment?.enabled || assignment.status !== 'running') return { kind: 'idle' };
    this.running = true;
    try {
      const outcome = await this.executeStep(assignment);
      if (outcome.kind === 'waiting') {
        const marker = `waiting:${outcome.untilUnixSeconds.toString()}`;
        if (assignment.lastAction !== marker) {
          this.database.setAutomationLastAction(marker);
          this.database.recordAutomationActivity({ kind: 'waiting', action: 'stop-mining', detail: outcome.detail });
        }
        return { kind: 'waiting', untilUnixSeconds: outcome.untilUnixSeconds };
      }
      if (outcome.action === 'start-mining' && outcome.targetStopAtUnixSeconds === undefined) {
        throw new Error('Confirmed start-mining did not produce a durable target stop time');
      }
      this.database.confirmAutomationAction({
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
      this.database.pauseAutomation(reason);
      this.database.recordAutomationActivity({ kind: 'paused', detail: reason });
      return { kind: 'paused', reason };
    } finally {
      this.running = false;
    }
  }
}
