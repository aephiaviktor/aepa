import type { ScanSignalStatus } from '@aephia/atlas-kit/scanning';
import type { AutomationStopMode } from './automation-stop.js';

export interface ScanningObservation {
  fleetState: string;
  atHome: boolean;
  atSector: boolean;
  registered: boolean;
  now: bigint;
  cooldown: bigint;
  arrivesAt?: bigint;
  signal: ScanSignalStatus | 'absent';
  entropy?: 'waiting' | 'ready' | 'expired';
  contactExpired?: boolean;
  contactInRange: boolean;
  contactReachable: boolean;
  suppliesReady: boolean;
  serviceUnload: boolean;
  serviceLoad: boolean;
  stop?: AutomationStopMode;
  phase?: 'scanning' | 'returning' | 'servicing';
}
export type ScanningAction = 'scan-open' | 'scan-detect' | 'scan-resolve' | 'scan-recover' | 'scan-expire' | 'scan-forfeit' | 'scan-abandon' | 'scan-acknowledge'
  | 'travel-home' | 'travel-sector' | 'travel-contact' | 'settle-arrival' | 'register-starbase' | 'dock' | 'undock' | 'unload' | 'load';
export type ScanningDecision = { kind: ScanningAction } | { kind: 'wait'; until: bigint; detail: string } | { kind: 'stopped' } | { kind: 'blocked'; reason: string };

/** Source: https://develop.atlas-kit-docs.pages.dev/guides/scanning/#reveal-recover-and-clear-a-result
 * Terminal receipts are captured durably before acknowledgement. A separate
 * durable return/service phase prevents a restart from starting another sortie
 * midway through a resupply or operator stop. */
export function decideScanningStep(s: ScanningObservation): ScanningDecision {
  const wait = (until: bigint, detail: string): ScanningDecision => ({ kind: 'wait', until, detail });
  if (s.fleetState === 'subwarp' || s.fleetState === 'warp') {
    if (s.arrivesAt === undefined) return { kind: 'blocked', reason: 'Missing journey arrival time' };
    if (s.now < s.arrivesAt) return wait(s.arrivesAt, 'Travelling');
    return s.fleetState === 'subwarp' ? { kind: 'settle-arrival' }
      : { kind: 'blocked', reason: 'SDK does not support settlement of a stored Warp journey; reconcile Fleet state' };
  }
  if (s.fleetState !== 'idle' && s.fleetState !== 'docked') return { kind: 'blocked', reason: `Scanning cannot operate a ${s.fleetState} Fleet` };
  if (s.signal === 'pending-entropy') {
    if (s.entropy === 'expired') return { kind: 'scan-forfeit' };
    if (s.entropy === 'ready') return { kind: 'scan-resolve' };
    return wait(s.now + 2n, 'Waiting for scan reveal window');
  }
  if (s.signal === 'contact') {
    if (s.contactExpired) return { kind: 'scan-expire' };
    if (s.stop === 'now' || !s.contactReachable) return { kind: 'scan-abandon' };
    if (s.fleetState === 'docked') return { kind: 'undock' };
    return { kind: s.contactInRange ? 'scan-recover' : 'travel-contact' };
  }
  const terminal = s.signal !== 'empty' && s.signal !== 'absent';
  if (terminal) return { kind: 'scan-acknowledge' };
  if (s.fleetState === 'docked') {
    if (!s.atHome) return { kind: 'undock' };
    if (s.serviceUnload) return { kind: 'unload' };
    if (s.serviceLoad) return { kind: 'load' };
    if (s.stop) return { kind: 'stopped' };
    if (s.signal === 'absent') return { kind: 'scan-open' };
    return { kind: 'undock' };
  }
  if (s.phase === 'returning' || s.phase === 'servicing' || s.stop || !s.suppliesReady) {
    if (!s.atHome) return { kind: 'travel-home' };
    return { kind: s.registered ? 'dock' : 'register-starbase' };
  }
  if (s.signal === 'absent') return { kind: 'scan-open' };
  if (!s.atSector) return { kind: 'travel-sector' };
  if (s.cooldown > s.now) return wait(s.cooldown, 'Scan cooldown');
  return { kind: 'scan-detect' };
}
