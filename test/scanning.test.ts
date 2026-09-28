import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scanCargoCosts, scanningPatternOption, validateScanSector } from '../src/scanning-model.js';

test('scan consumption rounds each configured cost before aggregating, using exact integers', () => {
  assert.deepEqual(scanCargoCosts(3, [
    { cargo: { id: 1, name: 'Food' }, multiplier: { raw: 32768n } },
    { cargo: { id: 1, name: 'Food' }, multiplier: { raw: 32768n } },
    { cargo: { id: 8, name: 'Data' }, multiplier: { raw: 65536n } },
  ]), [{ cargoId: 1, name: 'Food', amount: 4n }, { cargoId: 8, name: 'Data', amount: 3n }]);
});
test('pattern availability uses policy research, not a hardcoded tier or loot research', () => {
  const pattern = { id: 9, name: 'Broad Spectrum', status: 'active' as const, costs: [] };
  assert.equal(scanningPatternOption(pattern, { status: 'active', requiredResearchTagIds: [7] }, []).available, false);
  assert.equal(scanningPatternOption(pattern, { status: 'active', requiredResearchTagIds: [7] }, [7]).available, true);
  assert.equal(scanningPatternOption(pattern, undefined, [7]).available, false);
});
test('scan sector accepts signed i8 integers and rejects fractional, empty and overflowing input', () => {
  assert.deepEqual(validateScanSector(-128, 127), { x: -128, y: 127 });
  for (const value of ['', null, 1.5, 128, -129, NaN]) assert.throws(() => validateScanSector(value, 0));
});

test('region research is evaluated at the exact signed sector including boundary', async () => {
  const {scanSectorRegion}=await import('../src/scanning-model.js');
  const region={id:3,available:false,requirement:'Research 5',border:[[-2,-2],[2,-2],[2,2],[-2,2]].map(([x,y])=>({xRaw:(BigInt(x)*(1n<<56n)).toString(),yRaw:(BigInt(y)*(1n<<56n)).toString()}))};
  assert.equal(scanSectorRegion([region],-2,0)?.available,false);
  assert.equal(scanSectorRegion([region],2,2)?.id,3);
  assert.equal(scanSectorRegion([region],3,0),undefined);
});

test('scanning reuses shared pattern, policy, and region configuration through bounded TTL caches', async () => {
  const source = await readFile(new URL('../src/scanning-c4.ts', import.meta.url), 'utf8')
    .catch(() => readFile(new URL('../../src/scanning-c4.ts', import.meta.url), 'utf8'));
  assert.match(source, /new TtlPromiseCache<[\s\S]*?\(SCANNING_CATALOG_TTL_MS\)/);
  assert.match(source, /patternCache\.get/);
  assert.match(source, /regionCache\.get/);
  assert.match(source, /const SCANNING_CATALOG_TTL_MS = 5 \* 60_000/);
});

test('scanning persists per-stage action timings in confirmed activity detail', async () => {
  const source = await readFile(new URL('../src/scanning-c4.ts', import.meta.url), 'utf8')
    .catch(() => readFile(new URL('../../src/scanning-c4.ts', import.meta.url), 'utf8'));
  assert.match(source, /new ActionStageTimer\(\)/);
  assert.match(source, /formatActionTimings\(result\.timings\)/);
});
