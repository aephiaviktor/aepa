import test from 'node:test';
import assert from 'node:assert/strict';
import { decideScanningStep, type ScanningObservation } from '../src/scanning-loop.js';
const base: ScanningObservation = { fleetState: 'idle', atHome: false, atSector: true, registered: true, now: 100n, cooldown: 0n, signal: 'empty', suppliesReady: true, serviceUnload: false, serviceLoad: false, contactInRange: true, contactReachable: true };
test('open is explicit, detection only follows an empty signal', () => {
  assert.equal(decideScanningStep({ ...base, signal: 'absent' }).kind, 'scan-open');
  assert.equal(decideScanningStep(base).kind, 'scan-detect');
});
test('entropy window controls resolve, wait and forfeit after restart', () => {
  assert.equal(decideScanningStep({ ...base, signal: 'pending-entropy', entropy: 'ready' }).kind, 'scan-resolve');
  assert.equal(decideScanningStep({ ...base, signal: 'pending-entropy', entropy: 'waiting' }).kind, 'wait');
  assert.equal(decideScanningStep({ ...base, signal: 'pending-entropy', entropy: 'expired' }).kind, 'scan-forfeit');
});
test('contact expires at deadline; travel precedes recovery and unreachable contacts are abandoned', () => {
  assert.equal(decideScanningStep({ ...base, signal: 'contact', contactExpired: true }).kind, 'scan-expire');
  assert.equal(decideScanningStep({ ...base, signal: 'contact', contactInRange: false }).kind, 'travel-contact');
  assert.equal(decideScanningStep({ ...base, signal: 'contact', contactInRange: false, contactReachable: false }).kind, 'scan-abandon');
  assert.equal(decideScanningStep({ ...base, signal: 'contact' }).kind, 'scan-recover');
});
test('terminal outcomes acknowledge at sector without a round trip; durable return phase drives service', () => {
  for (const signal of ['recovered', 'no-contact', 'abandoned', 'expired'] as const) {
    assert.equal(decideScanningStep({ ...base, signal }).kind, 'scan-acknowledge');
  }
  const state = { ...base, phase: 'returning' as const };
  assert.equal(decideScanningStep(state).kind, 'travel-home');
  assert.equal(decideScanningStep({ ...state, atHome: true }).kind, 'dock');
  assert.equal(decideScanningStep({ ...state, atHome: true, fleetState: 'docked', serviceUnload: true }).kind, 'unload');
  assert.equal(decideScanningStep({ ...state, atHome: true, fleetState: 'docked', serviceLoad: true }).kind, 'load');
});
test('safe stop never starts another detection and movement must settle before recovery', () => {
  assert.equal(decideScanningStep({ ...base, stop: 'now' }).kind, 'travel-home');
  assert.equal(decideScanningStep({ ...base, stop: 'now', signal: 'contact' }).kind, 'scan-abandon');
  assert.equal(decideScanningStep({ ...base, stop: 'end-of-cycle', signal: 'contact' }).kind, 'scan-recover');
  assert.equal(decideScanningStep({ ...base, stop: 'now', fleetState: 'docked', atHome: true }).kind, 'stopped');
  assert.equal(decideScanningStep({ ...base, fleetState: 'subwarp', arrivesAt: 100n, signal: 'contact' }).kind, 'settle-arrival');
});

test('a stored Warp journey never masquerades as Idle or silently falls back to Subwarp',()=>{
  assert.equal(decideScanningStep({...base,fleetState:'warp',arrivesAt:99n}).kind,'blocked');
});
test('empty signal after a recovery stays scanning until supplies, capacity or return fuel require service',()=>{
  assert.equal(decideScanningStep({...base,phase:'scanning'}).kind,'scan-detect');
  assert.equal(decideScanningStep({...base,phase:'scanning',suppliesReady:false}).kind,'travel-home');
  assert.equal(decideScanningStep({...base,phase:'returning',suppliesReady:true}).kind,'travel-home');
});

test('active contact completion precedes returning phase and docked contact recovery undocks first',()=>{
  assert.equal(decideScanningStep({...base,signal:'contact',phase:'returning',suppliesReady:false}).kind,'scan-recover');
  assert.equal(decideScanningStep({...base,signal:'contact',fleetState:'docked',atHome:true,contactInRange:false}).kind,'undock');
});
