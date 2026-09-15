import type { AutomationAssignmentRecord, AepaDatabase } from './database.js';

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
      const reason = `${detail}. Automation paused; chain state must be inspected before any retry.`;
      this.database.pauseAutomation(reason);
      this.database.recordAutomationActivity({ kind: 'paused', detail: reason });
      return { kind: 'paused', reason };
    } finally {
      this.running = false;
    }
  }
}
