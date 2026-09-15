export const FLEET_COLUMNS = Object.freeze([
  Object.freeze({ id: 'fleet', label: 'Fleet' }),
  Object.freeze({ id: 'state', label: 'State' }),
  Object.freeze({ id: 'ships', label: 'Ships' }),
  Object.freeze({ id: 'ownership', label: 'Ownership' }),
  Object.freeze({ id: 'address', label: 'Fleet address' }),
  Object.freeze({ id: 'updated', label: 'Updated' }),
] as const);

export type FleetColumnId = typeof FLEET_COLUMNS[number]['id'];

interface FleetShip {
  name?: unknown;
  quantity?: unknown;
}

interface FleetSnapshot {
  ships?: FleetShip[];
  ownerProfile?: { address?: unknown };
}

export function describeFleetShips(snapshot: FleetSnapshot): string {
  if (!Array.isArray(snapshot?.ships) || snapshot.ships.length === 0) return 'No ship composition';
  const quantities = new Map<string, bigint>();
  for (const ship of snapshot.ships) {
    const name = typeof ship.name === 'string' && ship.name.trim() ? ship.name.trim() : 'Unknown ship';
    let quantity: bigint;
    try { quantity = BigInt(String(ship.quantity ?? 0)); } catch { quantity = 0n; }
    if (quantity > 0n) quantities.set(name, (quantities.get(name) ?? 0n) + quantity);
  }
  if (quantities.size === 0) return 'No ship composition';
  return [...quantities].map(([name, quantity]) => `${quantity}x ${name}`).join(', ');
}

export function getFleetOwnership(snapshot: FleetSnapshot, playerProfile: string): 'Owned' | 'Managed' | 'Unknown' {
  const owner = snapshot?.ownerProfile?.address;
  if (typeof owner !== 'string' || !owner) return 'Unknown';
  return owner === playerProfile ? 'Owned' : 'Managed';
}

export function normalizeVisibleColumns(value: unknown): FleetColumnId[] {
  const defaults = FLEET_COLUMNS.map(({ id }) => id);
  if (!Array.isArray(value)) return defaults;
  const selected = new Set(value.filter((id): id is string => typeof id === 'string'));
  return defaults.filter((id) => selected.has(id));
}
