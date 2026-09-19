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
  homeSystemId: 10;
  homeSystemName: 'Eternity';
  resourceId: 311;
  resourceName: 'Copper Ore';
  destinationAddress: string;
  destinationName: 'Ioki';
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
  if (assignment?.enabled || assignment?.status === 'running') throw new Error('Pause Automation before changing its assignment');
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
  if (!home || home.systemId !== 10 || home.systemName !== 'Eternity') throw new Error('Automatic execution currently supports only the Eternity Home Starbase');
  if (input.resourceId !== 311 || catalog.resources.find((resource) => resource.id === input.resourceId)?.name !== 'Copper Ore') {
    throw new Error('Automatic execution currently supports only Copper Ore');
  }
  const destination = catalog.destinations.find((candidate) => candidate.address === input.destinationAddress);
  if (!destination || destination.name !== 'Ioki' || destination.systemAddress !== home.systemAddress || !destination.resourceIds.includes(311)) {
    throw new Error('Automatic execution currently supports only the Ioki asteroid belt in Eternity');
  }
  if (input.travelMode !== 'auto') throw new Error('The current Ioki assignment is same-system and does not support a travel mode');
  return {
    profile,
    fleetAddress: fleet.address,
    fleetName: fleet.name,
    assignment: 'mining',
    homeSystemAddress: home.systemAddress,
    homeSystemId: 10,
    homeSystemName: 'Eternity',
    resourceId: 311,
    resourceName: 'Copper Ore',
    destinationAddress: destination.address,
    destinationName: 'Ioki',
    travelMode: 'auto',
  };
}
