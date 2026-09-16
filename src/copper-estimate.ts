/**
 * Pure linear estimates for the active mining pill.
 *
 * The stored plan already encodes a constant mining rate:
 *   rate = expectedCopperRaw / targetMiningSeconds
 * and the durable assignment stores the stop deadline:
 *   miningStart = targetStopAtUnixSeconds - targetMiningSeconds
 * so the current Copper Ore balance can be estimated locally with no RPC and no
 * IPC churn. The 60-second fleet snapshot remains the authoritative correction.
 */

export interface CopperEstimateInput {
  nowUnixSeconds: bigint;
  targetStopAtUnixSeconds: bigint;
  targetMiningSeconds: bigint;
  expectedCopperRaw: bigint;
}

/** Stop deadline minus planned mining duration. */
export function miningStartUnixSeconds(targetStopAtUnixSeconds: bigint, targetMiningSeconds: bigint): bigint {
  if (targetMiningSeconds <= 0n) throw new RangeError('targetMiningSeconds must be positive');
  return targetStopAtUnixSeconds - targetMiningSeconds;
}

/**
 * current = clamp((now - miningStart) * rate, 0, expectedCopper)
 * with exact integer (floor) arithmetic on BigInt.
 */
export function estimateCurrentCopper(input: CopperEstimateInput): bigint {
  if (input.targetMiningSeconds <= 0n) throw new RangeError('targetMiningSeconds must be positive');
  if (input.expectedCopperRaw < 0n) throw new RangeError('expectedCopperRaw must be non-negative');
  const start = miningStartUnixSeconds(input.targetStopAtUnixSeconds, input.targetMiningSeconds);
  const elapsed = input.nowUnixSeconds - start;
  if (elapsed <= 0n) return 0n;
  const current = (elapsed * input.expectedCopperRaw) / input.targetMiningSeconds;
  return current < 0n ? 0n : current > input.expectedCopperRaw ? input.expectedCopperRaw : current;
}

/** Local 24-hour HH:mm (zero-padded) for a Unix-seconds deadline. */
export function formatLocalHhmm(unixSeconds: bigint): string {
  const date = new Date(Number(unixSeconds) * 1_000);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}