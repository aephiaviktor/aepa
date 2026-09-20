import { createSageClient, resolveCargo } from '@aephia/atlas-kit';
import { profileFaction } from '@aephia/atlas-kit/bindings';
import { getTerritoryRegions } from '@aephia/atlas-kit/factions';
import { getResearchCatalog } from '@aephia/atlas-kit/identity';
import { getAsteroids } from '@aephia/atlas-kit/world';
import { address, createSolanaRpc, getAddressEncoder, getBytesEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { AppSettings } from './settings.js';
import { rankHomeStarbases, type FactionAlignment, type MiningDestinationCandidate, type RegionAlignment } from './automation-options.js';
import { resolveMiningResourceEligibility } from './mining-research.js';

const READ_OPTIONS = { commitment: 'confirmed', policy: 'no-store' } as const;

export interface MiningAutomationCatalog {
  faction: FactionAlignment;
  fleets: readonly { address: string; name: string; state: string }[];
  homeStarbases: readonly {
    systemAddress: string;
    systemId: number;
    systemName: string;
    regionId: number;
    regionOwner: RegionAlignment;
    systemFaction?: FactionAlignment;
    coordinates: { x: number; y: number };
    registered: boolean;
  }[];
  resources: readonly { id: number; name: string; available: boolean; requirement?: string }[];
  destinations: readonly MiningDestinationCandidate[];
  mode: 'configuration-preview';
}

function factionAlignment(value: number): FactionAlignment {
  if (value === profileFaction.Faction.Mud) return 'mud';
  if (value === profileFaction.Faction.Oni) return 'oni';
  if (value === profileFaction.Faction.Ustur) return 'ustur';
  throw new Error('The configured Player Profile is not enlisted with MUD, ONI, or Ustur');
}

async function loadProfileFaction(rpc: ReturnType<typeof createSolanaRpc>, profile: ReturnType<typeof address>): Promise<FactionAlignment> {
  const [factionAddress] = await getProgramDerivedAddress({
    programAddress: profileFaction.PROFILE_FACTION_PROGRAM_ADDRESS,
    seeds: [
      getBytesEncoder().encode(new TextEncoder().encode('player_faction')),
      getAddressEncoder().encode(profile),
    ],
  });
  const response = await rpc.getAccountInfo(factionAddress, { commitment: 'confirmed', encoding: 'base64' }).send();
  if (!response.value) throw new Error('The configured Player Profile has no ProfileFaction account');
  const encoded = response.value.data;
  const bytes = Buffer.from(encoded[0], 'base64');
  const decoded = profileFaction.getProfileFactionAccountDecoder().decode(bytes);
  if (decoded.profile !== profile) throw new Error('ProfileFaction account does not belong to the configured Player Profile');
  return factionAlignment(decoded.faction);
}

async function mapWithConcurrency<T, R>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      output[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

export async function loadMiningAutomationCatalog(settings: AppSettings): Promise<MiningAutomationCatalog> {
  if (!settings.playerProfile) throw new Error('Configure a Player Profile before loading Automation');
  const rpc = createSolanaRpc(settings.rpcUrl);
  const sage = createSageClient({ cluster: 'zink-ptr', rpc });
  try {
    const profile = address(settings.playerProfile);
    const [faction, character, territory, systems, research] = await Promise.all([
      loadProfileFaction(rpc, profile),
      sage.characters.forProfile(profile, READ_OPTIONS),
      getTerritoryRegions(sage.context, READ_OPTIONS),
      sage.systems.all(READ_OPTIONS),
      getResearchCatalog(sage.context),
    ]);
    const [fleets, playerStarbases] = await Promise.all([
      character.fleets.all(READ_OPTIONS),
      character.starbases.all(READ_OPTIONS),
    ]);
    const regionBySystemId = new Map<number, { regionId: number; regionOwner: RegionAlignment; systemFaction: FactionAlignment }>();
    for (const region of territory.regions) {
      for (const system of region.systems) {
        if (system.faction === 'unaligned') continue;
        regionBySystemId.set(system.systemId, { regionId: region.id, regionOwner: region.owner, systemFaction: system.faction });
      }
    }
    const eligibleSystems = systems.filter((system) => regionBySystemId.get(system.systemId)?.systemFaction === faction);
    const asteroidGroups = await mapWithConcurrency(eligibleSystems, 4, async (system) => ({
      system,
      asteroids: await getAsteroids(sage.context, system.address, READ_OPTIONS),
    }));
    const destinations: MiningDestinationCandidate[] = asteroidGroups.flatMap(({ system, asteroids }) => {
      const territorySystem = regionBySystemId.get(system.systemId);
      if (!territorySystem) return [];
      return asteroids.map((asteroid) => ({
        address: asteroid.address,
        name: asteroid.name,
        systemAddress: system.address,
        systemName: system.name,
        systemFaction: territorySystem.systemFaction,
        coordinates: system.coordinates,
        regionId: territorySystem.regionId,
        regionOwner: territorySystem.regionOwner,
        resourceIds: asteroid.details.resources.map((resource) => resource.cargoId),
      }));
    });
    const resourceIds = [...new Set(destinations.flatMap((destination) => destination.resourceIds))].sort((left, right) => left - right);
    const resources = await mapWithConcurrency(resourceIds, 4, async (id) => {
      const cargo = await resolveCargo(sage.context, id);
      return {
        id,
        name: cargo.name,
        ...resolveMiningResourceEligibility(cargo.categoryId, character, research.nodes),
      };
    });
    const registeredSystems = new Set(playerStarbases.map(starbase => String(starbase.system.address)));
    const homeStarbases = rankHomeStarbases(eligibleSystems.flatMap((system) => {
      const territorySystem = regionBySystemId.get(system.systemId);
      return system.starbase && territorySystem ? [{
        systemAddress: system.address,
        systemId: system.systemId,
        systemName: system.name,
        regionId: territorySystem.regionId,
        regionOwner: territorySystem.regionOwner,
        systemFaction: territorySystem.systemFaction,
        coordinates: system.coordinates,
        registered: registeredSystems.has(String(system.address)),
      }] : [];
    }));
    return {
      faction,
      fleets: fleets.map((fleet) => ({ address: fleet.address, name: fleet.name, state: fleet.state.kind })),
      homeStarbases,
      resources: resources.sort((left, right) => left.name.localeCompare(right.name)),
      destinations,
      mode: 'configuration-preview',
    };
  } finally {
    await sage.dispose();
  }
}
