import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type { ScanSignalSnapshot } from '@aephia/atlas-kit/scanning';
import {AepaDatabase} from '../src/database.js';
import {scanningPhase,setScanningPhase,captureScanReceipt} from '../src/scanning-store.js';

test('scan config, pending update, return phase and exact receipt survive database reopen',()=>{
  const folder=mkdtempSync(join(tmpdir(),'aepa-scan-'));const file=join(folder,'db.sqlite');
  let database=new AepaDatabase(file);
  try {
    const assignment={profile:'profile',fleetAddress:'fleet',fleetName:'MF-01',assignment:'scanning' as const,homeSystemAddress:'home',homeSystemId:1,homeSystemName:'Home',resourceId:0,resourceIds:[],resourceName:'Broad Spectrum',destinationAddress:'',destinationName:'Sector',travelMode:'subwarp' as const,scanPatternId:0,scanSectorX:-7,scanSectorY:8};
    database.saveAutomationAssignment(assignment);database.setAutomationEnabled(true,'fleet');
    database.saveAutomationAssignment({...assignment,scanPatternId:2,scanSectorX:-8});
    setScanningPhase(database.db,'profile','fleet','returning');
    const receipt={status:'recovered',sequence:5n,receipt:{acceptedQuantityRaw:9007199254740993n,clippedQuantityRaw:1n,xpAwardedRaw:3n}} as ScanSignalSnapshot;
    captureScanReceipt(database.db,'profile','fleet',receipt);captureScanReceipt(database.db,'profile','fleet',receipt);
    database.close();database=new AepaDatabase(file);
    assert.equal(scanningPhase(database.db,'profile','fleet'),'returning');
    assert.equal(database.getAutomationAssignment('fleet')?.scanSectorX,-7);
    assert.equal(database.getAutomationAssignment('fleet')?.pendingAssignment?.scanSectorX,-8);
    assert.equal(database.getAutomationAssignment('fleet')?.pendingAssignment?.scanPatternId,2);
    const rows=database.db.prepare('SELECT signal_json FROM scanning_receipts').all();assert.equal(rows.length,1);
    assert.equal(JSON.parse(String(rows[0].signal_json)).receipt.acceptedQuantityRaw,'9007199254740993');
    database.applyPendingAutomationAssignment('fleet');assert.equal(scanningPhase(database.db,'profile','fleet'),'servicing');assert.equal(database.getAutomationAssignment('fleet')?.scanPatternId,2);
  } finally {database.close();rmSync(folder,{recursive:true,force:true});}
});
