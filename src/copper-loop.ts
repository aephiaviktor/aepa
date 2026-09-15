export type CopperLoopState =
  | { kind: 'docked' }
  | { kind: 'idle' }
  | { kind: 'mining' }
  | { kind: string };

export interface CopperLoopDecisionInput {
  state: CopperLoopState;
  atEternity: boolean;
  foodRaw: bigint;
  targetFoodRaw: bigint;
  copperRaw: bigint;
  ammoRaw: bigint;
  ammoTargetRaw: bigint;
  fuelRaw: bigint;
  fuelTargetRaw: bigint;
  nowUnixSeconds?: bigint;
  targetStopAtUnixSeconds?: bigint;
}

export type CopperLoopNextStep =
  | { kind: 'dock' }
  | { kind: 'unload'; copperRaw: bigint; foodRaw: bigint }
  | { kind: 'load'; foodRaw: bigint; ammoRaw: bigint; fuelRaw: bigint }
  | { kind: 'undock' }
  | { kind: 'start-mining' }
  | { kind: 'stop-mining' }
  | { kind: 'wait'; untilUnixSeconds: bigint }
  | { kind: 'blocked'; reason: string };

function deficit(target: bigint, current: bigint): bigint {
  return target > current ? target - current : 0n;
}

export function decideCopperLoopNextStep(input: CopperLoopDecisionInput): CopperLoopNextStep {
  const quantities = [input.foodRaw, input.targetFoodRaw, input.copperRaw, input.ammoRaw, input.ammoTargetRaw, input.fuelRaw, input.fuelTargetRaw];
  if (quantities.some((value) => value < 0n)) return { kind: 'blocked', reason: 'Inventory values must not be negative.' };
  if (!input.atEternity && input.state.kind !== 'mining') {
    return { kind: 'blocked', reason: 'MF-01 is not at the configured Eternity system.' };
  }

  if (input.state.kind === 'docked') {
    const excessFood = input.foodRaw > input.targetFoodRaw ? input.foodRaw - input.targetFoodRaw : 0n;
    if (input.copperRaw > 0n || excessFood > 0n) {
      return { kind: 'unload', copperRaw: input.copperRaw, foodRaw: excessFood };
    }
    const foodRaw = deficit(input.targetFoodRaw, input.foodRaw);
    const ammoRaw = deficit(input.ammoTargetRaw, input.ammoRaw);
    const fuelRaw = deficit(input.fuelTargetRaw, input.fuelRaw);
    if (foodRaw > 0n || ammoRaw > 0n || fuelRaw > 0n) return { kind: 'load', foodRaw, ammoRaw, fuelRaw };
    return { kind: 'undock' };
  }

  if (input.state.kind === 'idle') {
    const balanced = input.foodRaw === input.targetFoodRaw && input.copperRaw === 0n && input.ammoRaw === input.ammoTargetRaw && input.fuelRaw === input.fuelTargetRaw;
    return balanced ? { kind: 'start-mining' } : { kind: 'dock' };
  }

  if (input.state.kind === 'mining') {
    if (input.targetStopAtUnixSeconds === undefined) {
      return { kind: 'blocked', reason: 'Mining is active but the durable target stop time is missing.' };
    }
    const now = input.nowUnixSeconds ?? BigInt(Math.floor(Date.now() / 1000));
    return now >= input.targetStopAtUnixSeconds
      ? { kind: 'stop-mining' }
      : { kind: 'wait', untilUnixSeconds: input.targetStopAtUnixSeconds };
  }

  return { kind: 'blocked', reason: `Unsupported Fleet state: ${input.state.kind}` };
}
