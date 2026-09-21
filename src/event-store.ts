import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** SQLite layout version; the additive public event envelope remains version 1. */
export const AEPA_EVENT_SCHEMA_VERSION = 2 as const;
const EVENT_ENVELOPE_VERSION = 1;


export type AepaEventStatus = 'planned' | 'submitted' | 'confirmed' | 'finalized' | 'failed' | 'unknown';

export interface PlannedAepaEvent {
  eventId: string;
  network: string;
  resetEpoch: string;
  profile: string;
  fleetAddress?: string;
  fleetName?: string;
  /** Ordered public instruction facts, never signer objects or secrets. */
  instructions?: readonly { programAddress: string; accounts: readonly { address: string; role: number }[]; dataBase64: string }[];
  action: string;
  occurredAt: string;
  payload: unknown;
}

export interface AepaEventStatusChange {
  status: Exclude<AepaEventStatus, 'planned'> | 'planned';
  changedAt: string;
  signature?: string;
  instructionIndex?: number;
  error?: string;
  evidence?: unknown;
}

export interface AepaEventChange extends PlannedAepaEvent {
  schemaVersion: number;
  sequence: number;
  revision: number;
  status: AepaEventStatus;
  changedAt: string;
  signature?: string;
  instructionIndex?: number;
  error?: string;
  evidence?: unknown;
}

const allowedTransitions: Readonly<Record<AepaEventStatus, readonly AepaEventStatus[]>> = Object.freeze({
  planned: ['submitted', 'failed', 'unknown'],
  submitted: ['confirmed', 'failed', 'unknown'],
  unknown: ['submitted', 'confirmed', 'failed'],
  confirmed: ['finalized', 'failed'],
  finalized: [],
  failed: [],
});

function requiredText(value: unknown, label: string, maxLength = 512): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  return text;
}

function isoTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp`);
  return text;
}

function canonicalJson(value: unknown): string {
  const visit = (entry: unknown): unknown => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Error('Event payload numbers must be finite');
      return entry;
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, visit(record[key])]));
    }
    throw new Error('Event payload must be JSON serializable');
  };
  return JSON.stringify(visit(value));
}

export class AepaEventStore {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    try { this.migrate(); } catch (error) {
      this.db.close();
      throw error;
    }
    if (filePath !== ':memory:') {
      try { chmodSync(filePath, 0o600); } catch { /* Best effort on Windows. */ }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const version = Number((this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0);
    if (version > AEPA_EVENT_SCHEMA_VERSION) throw new Error(`AEPA event database schema ${version} is newer than supported ${AEPA_EVENT_SCHEMA_VERSION}`);
    if (version < 1) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          network TEXT NOT NULL,
          reset_epoch TEXT NOT NULL,
          profile TEXT NOT NULL,
          fleet_address TEXT NOT NULL,
          fleet_name TEXT NOT NULL,
          action TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          signature TEXT,
          instruction_index INTEGER,
          CHECK (schema_version = 1),
          CHECK (instruction_index IS NULL OR instruction_index >= 0)
        );
        CREATE UNIQUE INDEX events_chain_identity_idx
          ON events(network, reset_epoch, signature, instruction_index)
          WHERE signature IS NOT NULL AND instruction_index IS NOT NULL;
        CREATE INDEX events_profile_fleet_idx ON events(profile, fleet_address, occurred_at);
        CREATE TABLE event_changes (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('planned', 'submitted', 'confirmed', 'finalized', 'failed', 'unknown')),
          changed_at TEXT NOT NULL,
          signature TEXT,
          instruction_index INTEGER,
          error TEXT,
          UNIQUE(event_id, revision)
        );
        CREATE INDEX event_changes_event_idx ON event_changes(event_id, revision);
        INSERT INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
        COMMIT;
      `);
    }
    if (version < 2) {
      // Existing local v1 rows keep their original schema marker and facts.
      // A collision aborts migration rather than silently discarding history.
      this.db.exec(`BEGIN IMMEDIATE;
        DROP INDEX events_chain_identity_idx;
        CREATE UNIQUE INDEX events_chain_identity_idx ON events(network, reset_epoch, signature)
          WHERE signature IS NOT NULL;
        ALTER TABLE events ADD COLUMN instructions_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE event_changes ADD COLUMN evidence_json TEXT;
        INSERT INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));
        COMMIT;`);
    }

  }

  recordPlanned(input: PlannedAepaEvent): AepaEventChange {
    const normalized = {
      eventId: requiredText(input.eventId, 'eventId', 128),
      network: requiredText(input.network, 'network', 64),
      resetEpoch: requiredText(input.resetEpoch, 'resetEpoch', 128),
      profile: requiredText(input.profile, 'profile', 128),
      fleetAddress: input.fleetAddress === undefined ? '' : requiredText(input.fleetAddress, 'fleetAddress', 128),
      fleetName: input.fleetName === undefined ? '' : requiredText(input.fleetName, 'fleetName', 256),
      action: requiredText(input.action, 'action', 64),
      occurredAt: isoTimestamp(input.occurredAt, 'occurredAt'),
      payloadJson: canonicalJson(input.payload),
      instructionsJson: canonicalJson(input.instructions ?? []),
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`SELECT event_id AS eventId, network, reset_epoch AS resetEpoch,
        profile, fleet_address AS fleetAddress, fleet_name AS fleetName, action, occurred_at AS occurredAt,
        payload_json AS payloadJson, instructions_json AS instructionsJson FROM events WHERE event_id = ?`).get(normalized.eventId) as typeof normalized | undefined;
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(normalized)) throw new Error(`eventId ${normalized.eventId} already exists with different facts`);
        const latest = this.latestChange(normalized.eventId);
        this.db.exec('COMMIT');
        return latest;
      }
      this.db.prepare(`INSERT INTO events(event_id, schema_version, network, reset_epoch, profile,
        fleet_address, fleet_name, action, occurred_at, payload_json, instructions_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        normalized.eventId, EVENT_ENVELOPE_VERSION, normalized.network, normalized.resetEpoch,
        normalized.profile, normalized.fleetAddress, normalized.fleetName, normalized.action,
        normalized.occurredAt, normalized.payloadJson, normalized.instructionsJson,
      );
      this.db.prepare(`INSERT INTO event_changes(event_id, revision, status, changed_at)
        VALUES (?, 1, 'planned', ?)`).run(normalized.eventId, normalized.occurredAt);
      const created = this.latestChange(normalized.eventId);
      this.db.exec('COMMIT');
      return created;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordStatus(eventId: string, change: AepaEventStatusChange): AepaEventChange {
    const selected = requiredText(eventId, 'eventId', 128);
    const status = change.status;
    if (status === 'planned') throw new Error('Invalid event status transition to planned');
    const changedAt = isoTimestamp(change.changedAt, 'changedAt');
    const suppliedSignature = change.signature === undefined ? undefined : requiredText(change.signature, 'signature', 128);
    const suppliedIndex = change.instructionIndex;
    if (suppliedIndex !== undefined && (!Number.isSafeInteger(suppliedIndex) || suppliedIndex < 0)) throw new Error('instructionIndex must be a non-negative safe integer');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const event = this.db.prepare('SELECT signature, instruction_index AS instructionIndex FROM events WHERE event_id = ?').get(selected) as { signature: string | null; instructionIndex: number | null } | undefined;
      if (!event) throw new Error(`Unknown eventId ${selected}`);
      const current = this.latestChange(selected);
      const signature = suppliedSignature ?? event.signature ?? undefined;
      const instructionIndex = suppliedIndex ?? event.instructionIndex ?? (signature ? 0 : undefined);
      const evidenceJson = canonicalJson(change.evidence ?? current.evidence ?? null);
      const errorText = change.error === undefined ? current.error ?? null : String(change.error).slice(0, 2_000);
      if (current.status === status && current.signature === signature && current.instructionIndex === instructionIndex &&
          evidenceJson === canonicalJson(current.evidence ?? null) && errorText === (current.error ?? null)) {
        this.db.exec('COMMIT');
        return current;
      }
      if (current.status !== status && !allowedTransitions[current.status].includes(status)) throw new Error(`Invalid event status transition ${current.status} -> ${status}`);
      if (['submitted', 'confirmed', 'finalized'].includes(status) && !signature) throw new Error(`${status} requires a transaction signature`);
      if (event.signature && signature !== event.signature) throw new Error('Transaction signature cannot change after submission');
      if (event.instructionIndex !== null && instructionIndex !== event.instructionIndex) throw new Error('Instruction index cannot change after submission');
      if (signature && event.signature === null) {
        this.db.prepare('UPDATE events SET signature = ?, instruction_index = ? WHERE event_id = ?')
          .run(signature, instructionIndex ?? 0, selected);
      }
      this.db.prepare(`INSERT INTO event_changes(event_id, revision, status, changed_at, signature, instruction_index, error, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        selected, current.revision + 1, status, changedAt, signature ?? null, instructionIndex ?? null,
        errorText, evidenceJson,
      );
      const recorded = this.latestChange(selected);
      this.db.exec('COMMIT');
      return recorded;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listChanges(afterSequence = 0, limit = 500): AepaEventChange[] {
    const cursor = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 2_000);
    const rows = this.db.prepare(`SELECT c.sequence, c.revision, c.status, c.changed_at AS changedAt,
      c.signature, c.instruction_index AS instructionIndex, c.error, c.evidence_json AS evidenceJson,
      e.event_id AS eventId, e.schema_version AS schemaVersion, e.network, e.reset_epoch AS resetEpoch,
      e.profile, e.fleet_address AS fleetAddress, e.fleet_name AS fleetName, e.action,
      e.occurred_at AS occurredAt, e.payload_json AS payloadJson, e.instructions_json AS instructionsJson
      FROM event_changes c JOIN events e ON e.event_id = c.event_id
      WHERE c.sequence > ? ORDER BY c.sequence ASC LIMIT ?`).all(cursor, safeLimit) as Array<Omit<AepaEventChange, 'payload' | 'instructions' | 'evidence' | 'signature' | 'instructionIndex' | 'error'> & {
        payloadJson: string; instructionsJson: string; evidenceJson: string | null; signature: string | null; instructionIndex: number | null; error: string | null;
      }>;
    return rows.map(({ payloadJson, instructionsJson, evidenceJson, signature, instructionIndex, error, ...row }) => ({
      ...row,
      payload: JSON.parse(payloadJson),
      instructions: JSON.parse(instructionsJson),
      fleetAddress: row.fleetAddress || undefined,
      fleetName: row.fleetName || undefined,
      ...(evidenceJson === null || evidenceJson === 'null' ? {} : { evidence: JSON.parse(evidenceJson) }),
      ...(signature === null ? {} : { signature }),
      ...(instructionIndex === null ? {} : { instructionIndex }),
      ...(error === null ? {} : { error }),
    }));
  }

  private latestChange(eventId: string): AepaEventChange {
    const row = this.listChangesForEvent(eventId, 1)[0];
    if (!row) throw new Error(`No lifecycle exists for eventId ${eventId}`);
    return row;
  }

  private listChangesForEvent(eventId: string, limit: number): AepaEventChange[] {
    const rows = this.db.prepare(`SELECT c.sequence, c.revision, c.status, c.changed_at AS changedAt,
      c.signature, c.instruction_index AS instructionIndex, c.error, c.evidence_json AS evidenceJson,
      e.event_id AS eventId, e.schema_version AS schemaVersion, e.network, e.reset_epoch AS resetEpoch,
      e.profile, e.fleet_address AS fleetAddress, e.fleet_name AS fleetName, e.action,
      e.occurred_at AS occurredAt, e.payload_json AS payloadJson, e.instructions_json AS instructionsJson
      FROM event_changes c JOIN events e ON e.event_id = c.event_id
      WHERE c.event_id = ? ORDER BY c.revision DESC LIMIT ?`).all(eventId, limit) as Array<Omit<AepaEventChange, 'payload' | 'instructions' | 'evidence' | 'signature' | 'instructionIndex' | 'error'> & {
        payloadJson: string; instructionsJson: string; evidenceJson: string | null; signature: string | null; instructionIndex: number | null; error: string | null;
      }>;
    return rows.map(({ payloadJson, instructionsJson, evidenceJson, signature, instructionIndex, error, ...row }) => ({
      ...row,
      payload: JSON.parse(payloadJson),
      instructions: JSON.parse(instructionsJson),
      fleetAddress: row.fleetAddress || undefined,
      fleetName: row.fleetName || undefined,
      ...(evidenceJson === null || evidenceJson === 'null' ? {} : { evidence: JSON.parse(evidenceJson) }),
      ...(signature === null ? {} : { signature }),
      ...(instructionIndex === null ? {} : { instructionIndex }),
      ...(error === null ? {} : { error }),
    }));
  }

  close(): void {
    this.db.close();
  }
}
