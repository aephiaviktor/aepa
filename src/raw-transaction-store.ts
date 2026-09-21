import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface RawSubmission {
  network: string;
  resetEpoch: string;
  profile: string;
  signature: string;
  wire: string;
}
export interface PendingRawSubmission extends RawSubmission { id: string }

/** Public chain evidence only. RPC response text is never reserialized: large JSON
 * integers and unknown fields must survive future decoder changes unchanged. */
export class RawTransactionStore {
  private readonly db: DatabaseSync;
  constructor(private readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS raw_submissions (
        id TEXT PRIMARY KEY, network TEXT NOT NULL, reset_epoch TEXT NOT NULL,
        profile TEXT NOT NULL, signature TEXT NOT NULL, wire TEXT NOT NULL,
        created_at TEXT NOT NULL, collected INTEGER NOT NULL DEFAULT 0,
        UNIQUE(network, reset_epoch, signature));
      CREATE INDEX IF NOT EXISTS raw_pending ON raw_submissions(collected, created_at);
      CREATE TABLE IF NOT EXISTS raw_responses (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id TEXT NOT NULL REFERENCES raw_submissions(id),
        digest TEXT NOT NULL, received_at TEXT NOT NULL, response_text TEXT NOT NULL,
        UNIQUE(submission_id, digest));
      CREATE TABLE IF NOT EXISTS raw_operation_barriers(
        network TEXT NOT NULL, profile TEXT NOT NULL, scope TEXT NOT NULL,
        submission_id TEXT NOT NULL REFERENCES raw_submissions(id),
        PRIMARY KEY(network,profile,scope));
      CREATE TABLE IF NOT EXISTS raw_generations(network TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_retry(
        submission_id TEXT PRIMARY KEY REFERENCES raw_submissions(id),
        attempts INTEGER NOT NULL, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_send_outcomes(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id TEXT NOT NULL REFERENCES raw_submissions(id),
        outcome TEXT NOT NULL, observed_at TEXT NOT NULL);`);
  }

  beforeSend(input: RawSubmission): string {
    for (const value of Object.values(input)) {
      if (typeof value !== 'string' || !value.trim()) throw new Error('Raw submission fields are required');
    }
    const id = createHash('sha256').update(JSON.stringify([input.network, input.resetEpoch, input.signature])).digest('hex');
    const existing = this.db.prepare('SELECT profile, wire FROM raw_submissions WHERE id=?').get(id);
    if (existing) {
      if (existing.profile !== input.profile || existing.wire !== input.wire) throw new Error('Raw transaction already exists with different facts');
      return id;
    }
    this.db.prepare(`INSERT INTO raw_submissions(id, network, reset_epoch, profile, signature, wire, created_at)
      VALUES(?,?,?,?,?,?,?)`).run(id, input.network, input.resetEpoch, input.profile, input.signature, input.wire, new Date().toISOString());
    return id;
  }

  beforeOperationSend(input: RawSubmission, scope: string): string {
    if (!scope.trim()) throw new Error('Operation scope is required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.db.prepare('SELECT submission_id FROM raw_operation_barriers WHERE network=? AND profile=? AND scope=?')
        .get(input.network, input.profile, scope);
      // Even the identical wire must not be sent twice after an interrupted send.
      if (pending) throw new Error('Unresolved transaction for this operation; it must not be resubmitted');
      const id = this.beforeSend(input);
      this.db.prepare('INSERT INTO raw_operation_barriers VALUES(?,?,?,?)').run(input.network,input.profile,scope,id);
      this.db.exec('COMMIT');
      return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  resolveOperation(id: string): void {
    this.db.prepare('DELETE FROM raw_operation_barriers WHERE submission_id=?').run(id);
  }

  /** Caller supplies the untouched getTransaction JSON-RPC body at finalized
   * commitment. Null/error responses remain evidence but never complete the job. */
  recordResponse(id: string, text: string): boolean {
    const envelope = JSON.parse(text) as { result?: unknown; error?: unknown };
    const expected = this.db.prepare('SELECT wire FROM raw_submissions WHERE id=?').get(id);
    if (!expected) throw new Error('Unknown raw submission');
    const complete = envelope !== null && typeof envelope === 'object' &&
      !envelope.error && envelope.result !== null && typeof envelope.result === 'object' &&
      'transaction' in envelope.result && 'meta' in envelope.result &&
      (envelope.result as { meta: unknown }).meta !== null &&
      Array.isArray((envelope.result as { transaction: unknown }).transaction) &&
      (envelope.result as { transaction: unknown[] }).transaction[0] === expected.wire &&
      (envelope.result as { transaction: unknown[] }).transaction[1] === 'base64';
    const digest = createHash('sha256').update(text).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`INSERT OR IGNORE INTO raw_responses(submission_id,digest,received_at,response_text)
        VALUES(?,?,?,?)`).run(id, digest, new Date().toISOString(), text);
      if (complete) this.db.prepare('UPDATE raw_submissions SET collected=1 WHERE id=?').run(id);
      this.db.exec('COMMIT');
      return result.changes !== 0;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  pending(limit = 100): PendingRawSubmission[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid page size');
    return this.db.prepare(`SELECT id,network,reset_epoch AS resetEpoch,profile,signature,wire FROM raw_submissions
      WHERE collected=0 ORDER BY created_at,id LIMIT ?`).all(limit) as unknown as PendingRawSubmission[];
  }
  responses(id: string): string[] {
    return this.db.prepare('SELECT response_text FROM raw_responses WHERE submission_id=? ORDER BY sequence').all(id)
      .map(row => String(row.response_text));
  }
  generation(network: string): string {
    this.db.prepare('INSERT OR IGNORE INTO raw_generations VALUES(?,?)')
      .run(network, `local-generation:${randomUUID()}`);
    return String(this.db.prepare('SELECT generation FROM raw_generations WHERE network=?').get(network)!.generation);
  }
  rotateGeneration(network: string): string {
    const generation = `local-generation:${randomUUID()}`;
    this.db.prepare('INSERT INTO raw_generations VALUES(?,?) ON CONFLICT(network) DO UPDATE SET generation=excluded.generation')
      .run(network, generation);
    return generation;
  }
  recordOutcome(id: string, outcome: 'submitted' | 'unknown'): void {
    this.db.prepare('INSERT INTO raw_send_outcomes(submission_id,outcome,observed_at) VALUES(?,?,?)')
      .run(id, outcome, new Date().toISOString());
  }

  /** Persist backoff before I/O, so a crashed collector cannot monopolize the queue. */
  claimDue(network: string, now = Date.now()): PendingRawSubmission | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT s.id,s.network,s.reset_epoch AS resetEpoch,s.profile,s.signature,s.wire,
          COALESCE(r.attempts,0) AS attempts
        FROM raw_submissions s LEFT JOIN raw_retry r ON r.submission_id=s.id
        WHERE s.collected=0 AND s.network=? AND COALESCE(r.next_at,0)<=?
        ORDER BY COALESCE(r.next_at,0),s.created_at,s.id LIMIT 1`).get(network, now) as unknown as (PendingRawSubmission & { attempts: number }) | undefined;
      if (row) {
        const delay = Math.min(3_600_000, 30_000 * 2 ** Math.min(row.attempts, 7));
        this.db.prepare(`INSERT INTO raw_retry VALUES(?,?,?) ON CONFLICT(submission_id)
          DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at`).run(row.id, row.attempts + 1, now + delay);
      }
      this.db.exec('COMMIT');
      if (!row) return undefined;
      const { attempts, ...submission } = row;
      return submission;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  health(network: string, profile: string) {
    const pending = this.db.prepare(`SELECT COUNT(*) AS count, MIN(created_at) AS oldest
      FROM raw_submissions WHERE network=? AND profile=? AND collected=0`).get(network,profile)!;
    const barriers = this.db.prepare('SELECT COUNT(*) AS count FROM raw_operation_barriers WHERE network=? AND profile=?').get(network,profile)!;
    const pages = Number(this.db.prepare('PRAGMA page_count').get()!.page_count);
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    let freeDiskBytes: number | null = null;
    let walBytes = 0;
    if (this.file !== ':memory:') {
      try { const fs = statfsSync(dirname(this.file)); freeDiskBytes = fs.bavail * fs.bsize; } catch { /* unavailable is not zero */ }
      try { walBytes = statSync(`${this.file}-wal`).size; } catch { /* no WAL yet */ }
    }
    return { pending:Number(pending.count), oldestPendingAt:pending.oldest === null ? null : String(pending.oldest),
      unresolvedOperations:Number(barriers.count), databaseBytes:pages*pageSize, walBytes, freeDiskBytes };
  }
  close(): void { this.db.close(); }
}
