export const ACTION_STAGES = [
  'observation',
  'planning',
  'atlas-prepare',
  'simulation',
  'send',
  'confirmation',
  'post-state',
] as const;

export type ActionStage = typeof ACTION_STAGES[number];
export type ActionTimings = Partial<Record<ActionStage, number>> & { total: number };

/** Monotonic-by-contract stage timer. Negative wall-clock movement is clamped
 * so telemetry never corrupts a confirmed action record.
 */
export class ActionStageTimer {
  private readonly startedAt: number;
  private previousAt: number;
  private readonly durations = new Map<ActionStage, number>();

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = this.previousAt = now();
  }

  complete(stage: ActionStage): void {
    const current = this.now();
    const duration = Math.max(0, Math.round(current - this.previousAt));
    this.durations.set(stage, (this.durations.get(stage) ?? 0) + duration);
    this.previousAt = current;
  }

  snapshot(): ActionTimings {
    const result: Partial<Record<ActionStage, number>> = {};
    for (const stage of ACTION_STAGES) {
      const duration = this.durations.get(stage);
      if (duration !== undefined) result[stage] = duration;
    }
    return {
      ...result,
      total: Math.max(0, Math.round(this.previousAt - this.startedAt)),
    };
  }
}

export function formatActionTimings(timings: ActionTimings): string {
  const fields = ACTION_STAGES.flatMap((stage) =>
    timings[stage] === undefined ? [] : [`${stage}=${timings[stage]}ms`],
  );
  return `timings ${fields.join(' ')} total=${timings.total}ms`;
}
