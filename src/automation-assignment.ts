import type { MiningAutomationCatalog } from './automation-catalog.js';
import { isRoundTripReachable, type TravelMode } from './automation-options.js';
import { assertMiningResourcesAvailable } from './mining-research.js';

export interface AutomationAssignmentInput {
  fleetAddress: string;
  assignment: string;
  homeSystemAddress: string;
  resourceId: number;
  resourceIds?: number[];
  destinationAddress: string;
  travelMode: string;
}

export interface SavedAutomationAssignment {
  profile: string;
  fleetAddress: string;
  fleetName: string;
  assignment: 'mining';
  homeSystemAddress: string;
  homeSystemId: number;
  homeSystemName: string;
  resourceId: number;
  resourceIds?: number[];
  resourceName: string;
  destinationAddress: string;
  destinationName: string;
  travelMode: 'auto' | 'same-system' | 'subwarp' | 'warp' | 'warp-lane';
}

interface AutomationRuntimeGate {
  enabled: boolean;
  status: 'disabled' | 'running' | 'paused';
  lastError?: string;
}

export function isCrossSystemTravelMode(mode: string): boolean {
  return mode === 'subwarp' || mode === 'warp' || mode === 'warp-lane';
}

export function assertAutomationCanEnable(assignment: AutomationRuntimeGate): void {
  if (assignment.enabled || assignment.status === 'running') throw new Error('Automation is already enabled');
  if (assignment.status === 'paused') {
    throw new Error('Automation was paused by the runner and requires out-of-band chain-state reconciliation before it can be enabled again');
  }
}

export function assertAutomationCanReplace(assignment?: AutomationRuntimeGate): void {
  if (assignment?.status === 'paused') {
    throw new Error('A runner-paused assignment requires out-of-band chain-state reconciliation before it can be replaced');
  }
}

export function validateSupportedAutomationAssignment(value: unknown, catalog: MiningAutomationCatalog, profile: string): SavedAutomationAssignment {
  if (!value || typeof value !== 'object') throw new Error('Automation assignment must be an object');
  const input = value as Partial<AutomationAssignmentInput>;
  const fleet = catalog.fleets.find((candidate) => candidate.address === input.fleetAddress);
  if (!fleet) throw new Error('Select a fleet from the current C4 catalog');
  if (input.assignment !== 'mining') throw new Error('Automatic execution currently supports only Mining');
  const home = catalog.homeStarbases.find((candidate) => candidate.systemAddress === input.homeSystemAddress);
  if (!home) throw new Error('Select a Home Starbase in the configured faction');
  const ids = input.resourceIds ?? [input.resourceId];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id))) throw new Error('Select one to eight unique resources');
  const resources = ids.map(id => {
    const resource = catalog.resources.find(candidate => candidate.id === id);
    if (!resource) throw new Error('Select resources from the current C4 catalog');
    return resource;
  }).sort((a, b) => a.id - b.id);
  const resource = resources[0];
  const destination = catalog.destinations.find((candidate) => candidate.address === input.destinationAddress);
  if (!destination || !resources.every(resource => destination.resourceIds.includes(resource.id))) throw new Error(`${resource.name} is not available at the selected mining destination`);
  assertMiningResourcesAvailable(resources.map(resource => resource.id), catalog.resources);
  const travelMode = input.travelMode;
  if (!['auto', 'same-system', 'subwarp', 'warp', 'warp-lane'].includes(travelMode ?? '')) throw new Error('Select a supported travel mode');
  const sameSystem = destination.systemAddress === home.systemAddress;
  if (!sameSystem && (travelMode === 'auto' || travelMode === 'same-system')) throw new Error('Select Subwarp, Warp, or Warp lane for a cross-system destination');
  if (sameSystem && travelMode !== 'auto' && travelMode !== 'same-system') throw new Error('Select Same system for a same-system mining destination');
  const distance = Math.hypot(destination.coordinates.x - home.coordinates.x, destination.coordinates.y - home.coordinates.y);
  if (!sameSystem && !isRoundTripReachable(travelMode as TravelMode, distance, fleet.travel)) {
    throw new Error(`${destination.name} is outside this Fleet's round-trip ${String(travelMode)} range from ${home.systemName}`);
  }
  return {
    profile,
    fleetAddress: fleet.address,
    fleetName: fleet.name,
    assignment: 'mining',
    homeSystemAddress: home.systemAddress,
    homeSystemId: home.systemId,
    homeSystemName: home.systemName,
    resourceId: resource.id,
    resourceIds: resources.map(resource => resource.id),
    resourceName: resources.map(resource => resource.name).join(', '),
    destinationAddress: destination.address,
    destinationName: destination.name,
    travelMode: travelMode as SavedAutomationAssignment['travelMode'],
  };
}
