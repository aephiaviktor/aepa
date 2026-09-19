import type { MiningAutomationCatalog } from './automation-catalog.js';

export interface AutomationAssignmentInput {
  fleetAddress: string;
  assignment: string;
  homeSystemAddress: string;
  resourceId: number;
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
  resourceName: string;
  destinationAddress: string;
  destinationName: string;
  travelMode: 'auto';
}

interface AutomationRuntimeGate {
  enabled: boolean;
  status: 'disabled' | 'running' | 'paused';
  lastError?: string;
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
  if (!home) throw new Error('Select a Home Starbase owned by the configured Character');
  const resource = catalog.resources.find((candidate) => candidate.id === input.resourceId);
  if (!resource) throw new Error('Select a resource from the current C4 catalog');
  const destination = catalog.destinations.find((candidate) => candidate.address === input.destinationAddress);
  if (!destination || !destination.resourceIds.includes(resource.id)) throw new Error(`${resource.name} is not available at the selected mining destination`);
  if (destination.systemAddress !== home.systemAddress) {
    throw new Error('Automatic cross-system travel is not available yet; select a mining destination in the Home Starbase system');
  }
  if (input.travelMode !== 'auto') throw new Error('Same-system mining does not use a travel mode');
  return {
    profile,
    fleetAddress: fleet.address,
    fleetName: fleet.name,
    assignment: 'mining',
    homeSystemAddress: home.systemAddress,
    homeSystemId: home.systemId,
    homeSystemName: home.systemName,
    resourceId: resource.id,
    resourceName: resource.name,
    destinationAddress: destination.address,
    destinationName: destination.name,
    travelMode: 'auto',
  };
}
