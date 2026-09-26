/** Source: https://develop.atlas-kit-docs.pages.dev/guides/scanning/#plan-signal-detection
 * The next.64 detection planner rounds each U16F16 cost row up independently.
 * Costs are cargo-hold resources, even when their IDs also identify fuel/ammo. */
export interface ScanCostRow {
  cargo: { id: number; name: string };
  multiplier: { raw: bigint };
}
export function scanCargoCosts(scanCost: number, costs: readonly ScanCostRow[]): { cargoId: number; name: string; amount: bigint }[] {
  if (!Number.isSafeInteger(scanCost) || scanCost < 0) throw new Error('Invalid Fleet scan cost');
  const result = new Map<number, { cargoId: number; name: string; amount: bigint }>();
  for (const cost of costs) {
    if (cost.multiplier.raw < 0n) throw new Error('Invalid Scan Pattern cost');
    const amount = (BigInt(scanCost) * cost.multiplier.raw + 65535n) / 65536n;
    const previous = result.get(cost.cargo.id);
    result.set(cost.cargo.id, { cargoId: cost.cargo.id, name: cost.cargo.name, amount: (previous?.amount ?? 0n) + amount });
  }
  return [...result.values()].filter(row => row.amount > 0n);
}
export interface ScanningPatternOption {
  id: number;
  name: string;
  available: boolean;
  requirement?: string;
  costs: { cargoId: number; name: string; multiplierRaw: string }[];
}
export function scanningPatternOption(
  pattern: { id: number; name: string; status: string; costs: readonly ScanCostRow[] },
  policy: { status: string; requiredResearchTagIds: readonly number[] } | undefined,
  unlockedTags: readonly number[],
): ScanningPatternOption {
  const missing = policy?.requiredResearchTagIds.filter(tag => !unlockedTags.includes(tag)) ?? [];
  const active = pattern.status === 'active' && policy?.status === 'active';
  return { id: pattern.id, name: pattern.name, available: active && missing.length === 0,
    ...(!active ? { requirement: 'Scan pattern or policy is inactive/unavailable' } : missing.length ? { requirement: `Requires research tags: ${missing.join(', ')}` } : {}),
    costs: pattern.costs.map(row => ({ cargoId: row.cargo.id, name: row.cargo.name, multiplierRaw: row.multiplier.raw.toString() })),
  };
}
export function validateScanSector(x: unknown, y: unknown): { x: number; y: number } {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y) || x < -128 || x > 127 || y < -128 || y > 127) {
    throw new Error('Scan Sector X/Y must be signed integers from -128 to 127');
  }
  return { x, y };
}

export interface ScanningRegion {
  id: number;
  border: {xRaw: string; yRaw: string}[];
  available: boolean;
  requirement?: string;
}
/** Integer ray casting, boundary inclusive, matching the pinned SDK region
 * geometry. Serialised raw I8F56 avoids rounding polygon edges in the UI. */
export function scanSectorRegion(regions: readonly ScanningRegion[], x: number, y: number): ScanningRegion | undefined {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;
  const px=BigInt(x)*(1n<<56n), py=BigInt(y)*(1n<<56n);
  return regions.find(region => {
    if (region.border.length < 3) return false;
    let inside=false;
    for (let i=0;i<region.border.length;i++) {
      const a=region.border[i]!, b=region.border[(i+1)%region.border.length]!;
      const ax=BigInt(a.xRaw), ay=BigInt(a.yRaw), bx=BigInt(b.xRaw), by=BigInt(b.yRaw);
      const cross=(py-ay)*(bx-ax)-(px-ax)*(by-ay);
      if (cross===0n && px >= (ax<bx?ax:bx) && px <= (ax>bx?ax:bx) && py >= (ay<by?ay:by) && py <= (ay>by?ay:by)) return true;
      if ((ay>py)!==(by>py)) {
        const dy=by-ay, pointSide=(px-ax)*dy, edgeSide=(py-ay)*(bx-ax);
        if ((dy>0n && pointSide<edgeSide)||(dy<0n && pointSide>edgeSide)) inside=!inside;
      }
    }
    return inside;
  });
}
