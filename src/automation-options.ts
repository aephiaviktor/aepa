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

export type TravelMode = 'auto' | 'same-system' | 'subwarp' | 'warp' | 'warp-lane';

export interface FleetTravelCapability {
  fuelCapacityRaw: string;
  maxWarpDistance: number;
  subwarpFuelConsumptionRate: number;
  warpFuelConsumptionRate: number;
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

export function formatHomeStarbaseOption(
  home: { regionId: number; regionOwner: RegionAlignment; systemFaction?: FactionAlignment; systemName: string; coordinates: Coordinates; registered: boolean },
  fleetLocation: Coordinates,
): { label: string; title: string } {
  const distance = Number(Math.hypot(home.coordinates.x - fleetLocation.x, home.coordinates.y - fleetLocation.y).toFixed(2));
  return {
    label: `${formatRegionCode(home.regionOwner, home.regionId, home.systemFaction)} | ${home.systemName} | ${distance}`,
    title: home.registered ? `Registered at ${home.systemName}.` : `Auto-registers on first service at ${home.systemName}.`,
  };
}

/** Conservative configuration-time reach check. Each leg is rounded up before
 * doubling so the Fleet always reserves enough tank capacity to return home.
 * Warp-lane routing/tolls are still validated by the action planner.
 */
export function isRoundTripReachable(mode: TravelMode, distance: number, fleet: FleetTravelCapability): boolean {
  if (!Number.isFinite(distance) || distance < 0) return false;
  if (mode === 'auto' || mode === 'same-system') return distance === 0;
  if (mode === 'warp' && distance > fleet.maxWarpDistance) return false;
  const rate = mode === 'subwarp' ? fleet.subwarpFuelConsumptionRate : fleet.warpFuelConsumptionRate;
  if (!Number.isFinite(rate) || rate < 0) return false;
  return BigInt(Math.ceil(distance * rate)) * 2n <= BigInt(fleet.fuelCapacityRaw);
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
