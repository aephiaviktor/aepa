import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SavedAutomationAssignment } from './automation-assignment.js';
import { DEFAULT_SETTINGS, type AppSettings, validateSettings } from './settings.js';

export interface FleetRecord {
  address: string;
  profile: string;
  name: string;
  state: string;
  shipCount: number;
  snapshot: unknown;
  updatedAt: string;
}

export type FleetSyncStatus = 'never' | 'refreshing' | 'ready' | 'error';

export interface FleetSyncState {
  dataset: 'fleets';
  scope: string;
  status: FleetSyncStatus;
  lastStartedAt?: string;
  lastSucceededAt?: string;
  lastError?: string;
  chainSlot?: string;
  updatedAt?: string;
}

export interface FleetSnapshot {
  fleets: FleetRecord[];
  sync: FleetSyncState;
  payload?: unknown;
}

export interface CatalogSnapshot {
  catalog?: unknown;
  sync: {
    dataset: 'catalog';
    scope: string;
    status: FleetSyncStatus;
    lastStartedAt?: string;
    lastSucceededAt?: string;
    lastError?: string;
    chainSlot?: string;
    updatedAt?: string;
  };
}

export type AutomationStatus = 'disabled' | 'running' | 'paused';

export interface AutomationAssignmentRecord extends SavedAutomationAssignment {
  enabled: boolean;
  status: AutomationStatus;
  targetStopAtUnixSeconds?: bigint;
  lastAction?: string;
  lastError?: string;
  updatedAt: string;
}

export interface AutomationActivityRecord {
  id: number;
  occurredAt: string;
  kind: 'confirmed' | 'waiting' | 'paused' | 'enabled' | 'disabled';
  action?: string;
  signature?: string;
  detail: string;
}

export class AepaDatabase {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const version = Number((this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0);
    if (version < 1) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE app_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          network TEXT NOT NULL,
          rpc_url TEXT NOT NULL,
          player_profile TEXT NOT NULL,
          refresh_interval_seconds INTEGER NOT NULL
        );
        CREATE TABLE fleet_snapshots (
          address TEXT PRIMARY KEY,
          profile TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL,
          ship_count INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX fleet_snapshots_profile_idx ON fleet_snapshots(profile);
        INSERT INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
        COMMIT;
      `);
    }
    if (version < 2) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE automation_assignment (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          profile TEXT NOT NULL, fleet_address TEXT NOT NULL, fleet_name TEXT NOT NULL,
          assignment TEXT NOT NULL, home_system_address TEXT NOT NULL, home_system_id INTEGER NOT NULL,
          home_system_name TEXT NOT NULL, resource_id INTEGER NOT NULL, resource_name TEXT NOT NULL,
          destination_address TEXT NOT NULL, destination_name TEXT NOT NULL, travel_mode TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'running', 'paused')),
          target_stop_at_unix_seconds TEXT, last_action TEXT, last_error TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE automation_activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('confirmed', 'waiting', 'paused', 'enabled', 'disabled')),
          action TEXT, signature TEXT, detail TEXT NOT NULL
        );
        INSERT INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));
        COMMIT;
      `);
    }
    if (version < 3) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE sync_state (
          dataset TEXT NOT NULL,
          scope TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('refreshing', 'ready', 'error')),
          last_started_at TEXT,
          last_succeeded_at TEXT,
          last_error TEXT,
          chain_slot TEXT,
          payload_json TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(dataset, scope)
        );
        INSERT INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'));
        COMMIT;
      `);
    }
  }

  getSettings(): AppSettings {
    const row = this.db.prepare(`
      SELECT network, rpc_url AS rpcUrl, player_profile AS playerProfile,
             refresh_interval_seconds AS refreshIntervalSeconds
      FROM app_settings WHERE id = 1
    `).get();
    return row ? validateSettings(row) : { ...DEFAULT_SETTINGS };
  }

  saveSettings(value: unknown): AppSettings {
    const settings = validateSettings(value);
    this.db.prepare(`
      INSERT INTO app_settings(id, network, rpc_url, player_profile, refresh_interval_seconds)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        network = excluded.network,
        rpc_url = excluded.rpc_url,
        player_profile = excluded.player_profile,
        refresh_interval_seconds = excluded.refresh_interval_seconds
    `).run(settings.network, settings.rpcUrl, settings.playerProfile, settings.refreshIntervalSeconds);
    return settings;
  }

  replaceFleets(profile: string, fleets: readonly FleetRecord[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM fleet_snapshots WHERE profile = ?').run(profile);
      const insert = this.db.prepare(`
        INSERT INTO fleet_snapshots(address, profile, name, state, ship_count, snapshot_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const fleet of fleets) {
        insert.run(fleet.address, profile, fleet.name, fleet.state, fleet.shipCount, JSON.stringify(fleet.snapshot), fleet.updatedAt);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listFleets(profile: string): FleetRecord[] {
    const rows = this.db.prepare(`
      SELECT address, profile, name, state, ship_count AS shipCount,
             snapshot_json AS snapshotJson, updated_at AS updatedAt
      FROM fleet_snapshots WHERE profile = ? ORDER BY name COLLATE NOCASE, address
    `).all(profile) as Array<Omit<FleetRecord, 'snapshot'> & { snapshotJson: string }>;
    return rows.map(({ snapshotJson, ...row }) => ({ ...row, snapshot: JSON.parse(snapshotJson) }));
  }

  private getSyncRow(dataset: string, scope: string) {
    return this.db.prepare(`
      SELECT status, last_started_at AS lastStartedAt, last_succeeded_at AS lastSucceededAt,
             last_error AS lastError, chain_slot AS chainSlot, payload_json AS payloadJson,
             updated_at AS updatedAt
      FROM sync_state WHERE dataset = ? AND scope = ?
    `).get(dataset, scope) as {
      status: Exclude<FleetSyncStatus, 'never'>;
      lastStartedAt: string | null;
      lastSucceededAt: string | null;
      lastError: string | null;
      chainSlot: string | null;
      payloadJson: string | null;
      updatedAt: string;
    } | undefined;
  }

  getFleetSnapshot(profile: string): FleetSnapshot {
    const row = this.getSyncRow('fleets', profile);
    if (!row) return { fleets: this.listFleets(profile), sync: { dataset: 'fleets', scope: profile, status: 'never' } };
    const optional = <T>(value: T | null): T | undefined => value ?? undefined;
    return {
      fleets: this.listFleets(profile),
      sync: {
        dataset: 'fleets', scope: profile, status: row.status,
        lastStartedAt: optional(row.lastStartedAt), lastSucceededAt: optional(row.lastSucceededAt),
        lastError: optional(row.lastError), chainSlot: optional(row.chainSlot), updatedAt: row.updatedAt,
      },
      ...(row.payloadJson === null ? {} : { payload: JSON.parse(row.payloadJson) }),
    };
  }

  getCatalogSnapshot(scope: string): CatalogSnapshot {
    const row = this.getSyncRow('catalog', scope);
    const optional = <T>(value: T | null): T | undefined => value ?? undefined;
    if (!row) return { sync: { dataset: 'catalog', scope, status: 'never' } };
    return {
      ...(row.payloadJson === null ? {} : { catalog: JSON.parse(row.payloadJson) }),
      sync: {
        dataset: 'catalog', scope, status: row.status,
        lastStartedAt: optional(row.lastStartedAt), lastSucceededAt: optional(row.lastSucceededAt),
        lastError: optional(row.lastError), chainSlot: optional(row.chainSlot), updatedAt: row.updatedAt,
      },
    };
  }

  beginCatalogSync(scope: string, startedAt: string): void {
    this.db.prepare(`
      INSERT INTO sync_state(dataset, scope, status, last_started_at, last_error, updated_at)
      VALUES ('catalog', ?, 'refreshing', ?, NULL, ?)
      ON CONFLICT(dataset, scope) DO UPDATE SET
        status='refreshing', last_started_at=excluded.last_started_at,
        last_error=NULL, updated_at=excluded.updated_at
    `).run(scope, startedAt, startedAt);
  }

  completeCatalogSync(
    scope: string,
    catalog: unknown,
    value: { startedAt: string; succeededAt: string },
  ): void {
    this.db.prepare(`
      INSERT INTO sync_state(
        dataset, scope, status, last_started_at, last_succeeded_at, last_error,
        chain_slot, payload_json, updated_at
      ) VALUES ('catalog', ?, 'ready', ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(dataset, scope) DO UPDATE SET
        status='ready', last_started_at=excluded.last_started_at,
        last_succeeded_at=excluded.last_succeeded_at, last_error=NULL,
        chain_slot=excluded.chain_slot, payload_json=excluded.payload_json,
        updated_at=excluded.updated_at
    `).run(scope, value.startedAt, value.succeededAt, JSON.stringify(catalog), value.succeededAt);
  }

  failCatalogSync(scope: string, error: string, failedAt: string): void {
    this.db.prepare(`
      INSERT INTO sync_state(dataset, scope, status, last_started_at, last_error, updated_at)
      VALUES ('catalog', ?, 'error', ?, ?, ?)
      ON CONFLICT(dataset, scope) DO UPDATE SET
        status='error', last_error=excluded.last_error, updated_at=excluded.updated_at
    `).run(scope, failedAt, error.slice(0, 2_000), failedAt);
  }

  beginFleetSync(profile: string, startedAt: string): void {
    this.db.prepare(`
      INSERT INTO sync_state(dataset, scope, status, last_started_at, last_error, updated_at)
      VALUES ('fleets', ?, 'refreshing', ?, NULL, ?)
      ON CONFLICT(dataset, scope) DO UPDATE SET
        status='refreshing', last_started_at=excluded.last_started_at,
        last_error=NULL, updated_at=excluded.updated_at
    `).run(profile, startedAt, startedAt);
  }

  completeFleetSync(
    profile: string,
    fleets: readonly FleetRecord[],
    value: { startedAt: string; succeededAt: string; chainSlot?: string; payload?: unknown },
  ): void {
    if (fleets.some((fleet) => fleet.profile !== profile)) throw new Error('Fleet snapshot profile does not match its sync scope');
    const payloadJson = value.payload === undefined ? null : JSON.stringify(value.payload);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM fleet_snapshots WHERE profile = ?').run(profile);
      const insert = this.db.prepare(`
        INSERT INTO fleet_snapshots(address, profile, name, state, ship_count, snapshot_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const fleet of fleets) {
        insert.run(fleet.address, profile, fleet.name, fleet.state, fleet.shipCount, JSON.stringify(fleet.snapshot), fleet.updatedAt);
      }
      this.db.prepare(`
        INSERT INTO sync_state(
          dataset, scope, status, last_started_at, last_succeeded_at, last_error,
          chain_slot, payload_json, updated_at
        ) VALUES ('fleets', ?, 'ready', ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(dataset, scope) DO UPDATE SET
          status='ready', last_started_at=excluded.last_started_at,
          last_succeeded_at=excluded.last_succeeded_at, last_error=NULL,
          chain_slot=excluded.chain_slot, payload_json=excluded.payload_json,
          updated_at=excluded.updated_at
      `).run(profile, value.startedAt, value.succeededAt, value.chainSlot ?? null, payloadJson, value.succeededAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  failFleetSync(profile: string, error: string, failedAt: string): void {
    this.db.prepare(`
      INSERT INTO sync_state(dataset, scope, status, last_started_at, last_error, updated_at)
      VALUES ('fleets', ?, 'error', ?, ?, ?)
      ON CONFLICT(dataset, scope) DO UPDATE SET
        status='error', last_error=excluded.last_error, updated_at=excluded.updated_at
    `).run(profile, failedAt, error.slice(0, 2_000), failedAt);
  }

  saveAutomationAssignment(value: SavedAutomationAssignment): AutomationAssignmentRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO automation_assignment(
        id, profile, fleet_address, fleet_name, assignment, home_system_address, home_system_id,
        home_system_name, resource_id, resource_name, destination_address, destination_name,
        travel_mode, enabled, status, target_stop_at_unix_seconds, last_action, last_error, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'disabled', NULL, NULL, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        profile=excluded.profile, fleet_address=excluded.fleet_address, fleet_name=excluded.fleet_name,
        assignment=excluded.assignment, home_system_address=excluded.home_system_address,
        home_system_id=excluded.home_system_id, home_system_name=excluded.home_system_name,
        resource_id=excluded.resource_id, resource_name=excluded.resource_name,
        destination_address=excluded.destination_address, destination_name=excluded.destination_name,
        travel_mode=excluded.travel_mode, enabled=0, status='disabled',
        target_stop_at_unix_seconds=NULL, last_action=NULL, last_error=NULL, updated_at=excluded.updated_at
    `).run(
      value.profile, value.fleetAddress, value.fleetName, value.assignment, value.homeSystemAddress,
      value.homeSystemId, value.homeSystemName, value.resourceId, value.resourceName,
      value.destinationAddress, value.destinationName, value.travelMode, now,
    );
    return this.getAutomationAssignment()!;
  }

  getAutomationAssignment(): AutomationAssignmentRecord | undefined {
    const row = this.db.prepare(`
      SELECT profile, fleet_address AS fleetAddress, fleet_name AS fleetName, assignment,
             home_system_address AS homeSystemAddress, home_system_id AS homeSystemId,
             home_system_name AS homeSystemName, resource_id AS resourceId, resource_name AS resourceName,
             destination_address AS destinationAddress, destination_name AS destinationName,
             travel_mode AS travelMode, enabled, status,
             target_stop_at_unix_seconds AS targetStopAtUnixSeconds,
             last_action AS lastAction, last_error AS lastError, updated_at AS updatedAt
      FROM automation_assignment WHERE id = 1
    `).get() as (Omit<AutomationAssignmentRecord, 'enabled' | 'targetStopAtUnixSeconds'> & { enabled: number; targetStopAtUnixSeconds: string | null }) | undefined;
    if (!row) return undefined;
    const { targetStopAtUnixSeconds, ...rest } = row;
    return {
      ...rest,
      enabled: row.enabled === 1,
      ...(targetStopAtUnixSeconds === null ? {} : { targetStopAtUnixSeconds: BigInt(targetStopAtUnixSeconds) }),
    };
  }

  setAutomationEnabled(enabled: boolean): AutomationAssignmentRecord {
    const result = this.db.prepare(`
      UPDATE automation_assignment SET enabled = ?, status = ?, last_error = NULL, updated_at = ? WHERE id = 1
    `).run(enabled ? 1 : 0, enabled ? 'running' : 'disabled', new Date().toISOString());
    if (result.changes !== 1) throw new Error('Save an Automation assignment before changing its state');
    return this.getAutomationAssignment()!;
  }

  setAutomationTargetStop(value?: bigint): void {
    this.db.prepare(`UPDATE automation_assignment SET target_stop_at_unix_seconds = ?, updated_at = ? WHERE id = 1`)
      .run(value?.toString() ?? null, new Date().toISOString());
  }

  setAutomationLastAction(action: string): void {
    this.db.prepare(`UPDATE automation_assignment SET last_action = ?, updated_at = ? WHERE id = 1`)
      .run(action, new Date().toISOString());
  }

  confirmAutomationAction(value: { action: string; signature: string; detail: string; targetStopAtUnixSeconds?: bigint }): void {
    this.db.exec('BEGIN');
    try {
      const targetStop = value.action === 'start-mining'
        ? value.targetStopAtUnixSeconds?.toString()
        : value.action === 'stop-mining' ? null : undefined;
      if (value.action === 'start-mining' && targetStop === undefined) throw new Error('start-mining confirmation requires a target stop time');
      if (targetStop === undefined) {
        this.db.prepare(`UPDATE automation_assignment SET last_action = ?, updated_at = ? WHERE id = 1`)
          .run(value.action, new Date().toISOString());
      } else {
        this.db.prepare(`UPDATE automation_assignment SET target_stop_at_unix_seconds = ?, last_action = ?, updated_at = ? WHERE id = 1`)
          .run(targetStop, value.action, new Date().toISOString());
      }
      this.recordAutomationActivity({ kind: 'confirmed', action: value.action, signature: value.signature, detail: value.detail });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pauseAutomation(reason: string): AutomationAssignmentRecord {
    const message = reason.slice(0, 2_000);
    const result = this.db.prepare(`
      UPDATE automation_assignment SET enabled = 0, status = 'paused', last_error = ?, updated_at = ? WHERE id = 1
    `).run(message, new Date().toISOString());
    if (result.changes !== 1) throw new Error('No Automation assignment exists to pause');
    return this.getAutomationAssignment()!;
  }

  recordAutomationActivity(value: Omit<AutomationActivityRecord, 'id' | 'occurredAt'>): AutomationActivityRecord {
    const occurredAt = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO automation_activity(occurred_at, kind, action, signature, detail) VALUES (?, ?, ?, ?, ?)
    `).run(occurredAt, value.kind, value.action ?? null, value.signature ?? null, value.detail.slice(0, 4_000));
    return { id: Number(result.lastInsertRowid), occurredAt, ...value };
  }

  listAutomationActivity(limit = 50): AutomationActivityRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.db.prepare(`
      SELECT id, occurred_at AS occurredAt, kind, action, signature, detail
      FROM automation_activity ORDER BY id DESC LIMIT ?
    `).all(safeLimit) as unknown as AutomationActivityRecord[];
  }

  /** Fresh-start after a C4 reset: removes every chain-derived row (cached
   * fleet snapshots, sync metadata, the saved Automation assignment, and the
   * activity log) while keeping local app settings untouched. The encrypted
   * signer file is out of SQLite and stays as-is.
   */
  clearGameCache(): void {
    this.db.exec(`
      DELETE FROM fleet_snapshots;
      DELETE FROM sync_state;
      DELETE FROM automation_assignment;
      DELETE FROM automation_activity;
    `);
  }

  close(): void {
    this.db.close();
  }
}
