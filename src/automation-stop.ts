export type AutomationStopMode = 'now' | 'end-of-cycle';

export type StoppingDirective = 'continue' | 'stop-mining' | 'dock' | 'complete';

/** Converts the normal mining-loop decision into a safe operator-requested
 * shutdown. A fleet is complete only at the point where the normal loop would
 * undock after unloading and refilling at Home Starbase.
 */
export function stoppingDirective(
  mode: AutomationStopMode,
  fleetState: string,
  nextStep: string,
): StoppingDirective {
  if (fleetState === 'mining' && mode === 'now') return 'stop-mining';
  if (nextStep === 'start-mining') return 'dock';
  if (nextStep === 'undock') return 'complete';
  return 'continue';
}

/** An unchanged stopped row must stay disabled when another row is saved.
 * Editing its assignment resets lastAction in the database and explicitly
 * makes it eligible for the existing save-to-enable workflow again. */
export function shouldEnableSavedAssignment(assignment: { enabled: boolean; status: string; lastAction?: string }): boolean {
  return !assignment.enabled && assignment.status !== 'paused' && assignment.lastAction !== 'stopped';
}
