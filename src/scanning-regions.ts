import { getTerritoryRegions } from '@aephia/atlas-kit/factions';
import { sage as bindings } from '@aephia/atlas-kit/bindings';
import type { SageContext } from '@aephia/atlas-kit/client';
import type { createSolanaRpc } from '@solana/kit';
import type { ScanningRegion } from './scanning-model.js';
export { scanSectorRegion, type ScanningRegion } from './scanning-model.js';
export async function loadScanningRegions(context: SageContext, rpc: ReturnType<typeof createSolanaRpc>, unlocked: readonly number[]): Promise<ScanningRegion[]> {
  const tracker=await getTerritoryRegions(context,{commitment:'confirmed',policy:'no-store'});
  const result=await rpc.getAccountInfo(tracker.address,{commitment:'confirmed',encoding:'base64'}).send();
  if (!result.value || result.value.owner!==bindings.SAGE_PROGRAM_ADDRESS || result.value.executable) throw new Error('Invalid Region Tracker');
  const data=Buffer.from(result.value.data[0],'base64');
  if (!data.subarray(0,8).equals(Buffer.from(bindings.REGION_TRACKER_DISCRIMINATOR))) throw new Error('Invalid Region Tracker discriminator');
  const raw=bindings.getRegionTrackerDecoder().decode(data);
  if (raw.gameId!==tracker.game.address) throw new Error('Region Tracker Game mismatch');
  return raw.regions.unsizedList.map(region => {
    const missing=region.scanningResearchRequirements.filter(tag=>!unlocked.includes(tag));
    return {id:region.id,border:region.border.map(([x,y])=>({xRaw:x.raw.toString(),yRaw:y.raw.toString()})),available:missing.length===0,
      ...(missing.length ? {requirement:`Region ${region.id} requires research tags: ${missing.join(', ')}`} : {})};
  });
}
