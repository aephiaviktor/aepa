export interface CargoAmount { cargoId: number; amount: bigint }
interface Point { x: number; y: number }
/** Bound supply storage to half the hold and twenty detections. Leave the rest
 * for recovery. Exact per-row rounding matches SDK cargo capacity units. */
export function scanningServiceTargets(costs: readonly (CargoAmount & { storageCost: number; name: string })[], capacity: bigint): CargoAmount[] {
  if (capacity <= 0n) throw new Error('Scanning requires cargo capacity');
  for (let scans = 20n; scans >= 1n; scans--) {
    const storage = costs.reduce((sum, row) => sum + (row.amount * scans * BigInt(row.storageCost) + 255n) / 256n, 0n);
    if (storage <= capacity / 2n) return costs.map(row => ({cargoId: row.cargoId, amount: row.amount * scans}));
  }
  throw new Error('Scan costs exceed the supply capacity reserved in this Fleet');
}
export function scanningTransfers(held: readonly {id: number; amount: bigint}[], targets: readonly CargoAmount[]): {load: CargoAmount[]; unload: CargoAmount[]} {
  const expected = new Map(targets.map(row => [row.cargoId, row.amount]));
  const actual = new Map<number,bigint>();
  for (const row of held) actual.set(row.id, (actual.get(row.id) ?? 0n) + row.amount);
  return {
    unload: [...actual].flatMap(([cargoId, amount]) => amount > (expected.get(cargoId) ?? 0n) ? [{cargoId, amount: amount - (expected.get(cargoId) ?? 0n)}] : []),
    load: targets.flatMap(({cargoId, amount}) => amount > (actual.get(cargoId) ?? 0n) ? [{cargoId, amount: amount - (actual.get(cargoId) ?? 0n)}] : []),
  };
}
/** Current translated distance rate, rounded separately per leg, plus one raw
 * fuel unit per nonzero leg as a rounding margin. Planners/simulation remain
 * authoritative; arrival is checked against the recorded journey and position. */
export function travelFuelBudget(from: Point, to: Point, home: Point, rate: number): bigint {
  if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid Fleet fuel rate');
  const leg = (a: Point,b: Point) => {
    const d = Math.hypot(a.x-b.x,a.y-b.y);
    if (!Number.isFinite(d)) throw new Error('Invalid travel coordinates');
    return d === 0 ? 0n : BigInt(Math.ceil(d*rate)) + 1n;
  };
  return leg(from,to) + leg(to,home);
}
