import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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
  constructor(file: string) {
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
        UNIQUE(submission_id, digest));`);
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
  close(): void { this.db.close(); }
}
