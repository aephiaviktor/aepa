export type FactionAlignment = 'mud' | 'oni' | 'ustur';
export type RegionAlignment = FactionAlignment | 'unaligned';

export interface Coordinates {
  x: number;
  y: number;
}

export interface MiningDestinationCandidate {
  address: string;
  name: string;
  systemAddress: string;
  systemName: string;
  systemFaction: FactionAlignment;
  coordinates: Coordinates;
  regionId: number;
  regionOwner: RegionAlignment;
  resourceIds: readonly number[];
}

export interface RankedMiningDestination extends MiningDestinationCandidate {
  distance: number;
  label: string;
}

const REGION_PREFIX: Readonly<Record<RegionAlignment, string>> = {
  mud: 'MT',
  oni: 'OR',
  unaligned: 'UN',
  ustur: 'US',
};

export function formatRegionCode(owner: RegionAlignment, regionId: number, systemFaction: FactionAlignment = 'ustur'): string {
  if (!Number.isSafeInteger(regionId) || regionId < 1) throw new RangeError('Region id must be a positive integer');
  const prefix = owner === 'unaligned' ? ({ mud: 'MN', oni: 'ON', ustur: 'UN' } as const)[systemFaction] : REGION_PREFIX[owner];
  return `${regionId}-${prefix}`;
}

export function rankHomeStarbases<T extends { regionId: number; systemName: string; systemId: number }>(homes: readonly T[]): T[] {
  return [...homes].sort((left, right) => left.regionId - right.regionId
    || left.systemName.localeCompare(right.systemName)
    || left.systemId - right.systemId);
}

export function rankMiningDestinations(input: {
  faction: FactionAlignment;
  resourceId?: number;
  home: Coordinates;
  destinations: readonly MiningDestinationCandidate[];
}): RankedMiningDestination[] {
  return input.destinations
    .filter((destination) => destination.systemFaction === input.faction && (input.resourceId === undefined || destination.resourceIds.includes(input.resourceId)))
    .map((destination) => {
      const distance = Math.hypot(destination.coordinates.x - input.home.x, destination.coordinates.y - input.home.y);
      const displayDistance = Number(distance.toFixed(2));
      return {
        ...destination,
        distance,
        label: `${formatRegionCode(destination.regionOwner, destination.regionId, destination.systemFaction)} | ${destination.systemName} | ${destination.name} | ${displayDistance}`,
      };
    })
    .sort((left, right) => left.distance - right.distance
      || left.regionId - right.regionId
      || left.systemName.localeCompare(right.systemName)
      || left.name.localeCompare(right.name));
}
