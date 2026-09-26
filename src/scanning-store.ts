import type { DatabaseSync } from 'node:sqlite';
import type { ScanSignalSnapshot } from '@aephia/atlas-kit/scanning';
export type ScanningPhase = 'scanning' | 'returning' | 'servicing';
export function installScanningStore(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scanning_runtime (
    profile TEXT NOT NULL, fleet TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('scanning','returning','servicing')),
    PRIMARY KEY(profile,fleet));
    CREATE TABLE IF NOT EXISTS scanning_receipts (
    profile TEXT NOT NULL, fleet TEXT NOT NULL, sequence TEXT NOT NULL, signal_json TEXT NOT NULL,
    captured_at TEXT NOT NULL, PRIMARY KEY(profile,fleet,sequence));`);
}
export function scanningPhase(db: DatabaseSync, profile: string, fleet: string): ScanningPhase {
  return (db.prepare('SELECT phase FROM scanning_runtime WHERE profile=? AND fleet=?').get(profile, fleet) as {phase: ScanningPhase} | undefined)?.phase ?? 'servicing';
}
export function setScanningPhase(db: DatabaseSync, profile: string, fleet: string, phase: ScanningPhase): void {
  db.prepare(`INSERT INTO scanning_runtime(profile,fleet,phase) VALUES(?,?,?) ON CONFLICT(profile,fleet) DO UPDATE SET phase=excluded.phase`).run(profile,fleet,phase);
}
export function captureScanReceipt(db: DatabaseSync, profile: string, fleet: string, signal: ScanSignalSnapshot): void {
  if (!['recovered','no-contact','abandoned','expired'].includes(signal.status)) throw new Error('Only terminal scan results can be acknowledged');
  // Preserve exact receipt, clipping and XP before an acknowledgement clears it.
  db.prepare(`INSERT OR IGNORE INTO scanning_receipts(profile,fleet,sequence,signal_json,captured_at) VALUES(?,?,?,?,?)`)
    .run(profile, fleet, signal.sequence.toString(), JSON.stringify(signal, (_key, value) => typeof value === 'bigint' ? value.toString() : value), new Date().toISOString());
}
