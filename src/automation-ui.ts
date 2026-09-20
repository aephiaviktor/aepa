export interface AutomationDraftShape {
  fleetAddress: string;
  assignment: string;
  homeSystemAddress: string;
  destinationAddress: string;
  resourceIds: readonly number[];
  travelMode: string;
}

function canonicalDrafts(values: readonly AutomationDraftShape[]): string {
  return JSON.stringify(values.map((value) => ({
    fleetAddress: value.fleetAddress,
    assignment: value.assignment,
    homeSystemAddress: value.homeSystemAddress,
    destinationAddress: value.destinationAddress,
    resourceIds: [...value.resourceIds].sort((a, b) => a - b),
    travelMode: value.travelMode,
  })).sort((a, b) => a.fleetAddress.localeCompare(b.fleetAddress)));
}

export function automationDraftsEqual(left: readonly AutomationDraftShape[], right: readonly AutomationDraftShape[]): boolean {
  return canonicalDrafts(left) === canonicalDrafts(right);
}

export interface MiningProgressInput {
  targetStopAtUnixSeconds: bigint;
  targetMiningSeconds: bigint;
  expectedResources: readonly { name: string; expectedRaw: bigint }[];
}

export function formatMiningProgress(input: MiningProgressInput, nowUnixSeconds: bigint): string {
  if (input.targetMiningSeconds <= 0n) throw new RangeError('targetMiningSeconds must be positive');
  const start = input.targetStopAtUnixSeconds - input.targetMiningSeconds;
  const elapsed = nowUnixSeconds <= start ? 0n : nowUnixSeconds >= input.targetStopAtUnixSeconds
    ? input.targetMiningSeconds
    : nowUnixSeconds - start;
  const lines = input.expectedResources.map(({ name, expectedRaw }) => {
    if (expectedRaw < 0n) throw new RangeError('expectedRaw must be non-negative');
    const current = (elapsed * expectedRaw) / input.targetMiningSeconds;
    return `${name}: ${current.toString()} / ${expectedRaw.toString()}`;
  });
  return ['Mining progress', ...lines].join('\n');
}
