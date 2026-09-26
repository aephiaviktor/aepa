import { installScanningStore } from './scanning-store.js';
import { installAssignmentHistory } from './assignment-history.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SavedAutomationAssignment } from './automation-assignment.js';
import type { AutomationStopMode } from './automation-stop.js';
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
  pendingAssignment?: SavedAutomationAssignment;
  stopMode?: AutomationStopMode;
  stopRequestedAt?: string;
}

export interface AutomationActivityRecord {
  id: number;
  occurredAt: string;
  kind: 'confirmed' | 'waiting' | 'paused' | 'enabled' | 'disabled';
  action?: string;
  signature?: string;
  detail: string;
  fleetAddress?: string;
  fleetName?: string;
}

export class AepaDatabase {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    installAssignmentHistory(this.db);
    installScanningStore(this.db);
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
    if (version < 4) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE automation_assignment RENAME TO automation_assignment_single;
        CREATE TABLE automation_assignment (
          profile TEXT NOT NULL, fleet_address TEXT PRIMARY KEY, fleet_name TEXT NOT NULL,
          assignment TEXT NOT NULL, home_system_address TEXT NOT NULL, home_system_id INTEGER NOT NULL,
          home_system_name TEXT NOT NULL, resource_id INTEGER NOT NULL, resource_name TEXT NOT NULL,
          destination_address TEXT NOT NULL, destination_name TEXT NOT NULL, travel_mode TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'running', 'paused')),
          target_stop_at_unix_seconds TEXT, last_action TEXT, last_error TEXT, updated_at TEXT NOT NULL
        );
        INSERT INTO automation_assignment(
          profile, fleet_address, fleet_name, assignment, home_system_address, home_system_id,
          home_system_name, resource_id, resource_name, destination_address, destination_name,
          travel_mode, enabled, status, target_stop_at_unix_seconds, last_action, last_error, updated_at
        ) SELECT profile, fleet_address, fleet_name, assignment, home_system_address, home_system_id,
          home_system_name, resource_id, resource_name, destination_address, destination_name,
          travel_mode, enabled, status, target_stop_at_unix_seconds, last_action, last_error, updated_at
          FROM automation_assignment_single;
        DROP TABLE automation_assignment_single;
        ALTER TABLE automation_activity ADD COLUMN fleet_address TEXT;
        ALTER TABLE automation_activity ADD COLUMN fleet_name TEXT;
        UPDATE automation_activity SET
          fleet_address = (SELECT fleet_address FROM automation_assignment LIMIT 1),
          fleet_name = (SELECT fleet_name FROM automation_assignment LIMIT 1);
        INSERT INTO schema_migrations(version, applied_at) VALUES (4, datetime('now'));
        COMMIT;
      `);
    }
    if (version < 5) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE automation_assignment ADD COLUMN pending_json TEXT;
        INSERT INTO schema_migrations(version, applied_at) VALUES (5, datetime('now'));
        COMMIT;
      `);
    }
    if (version < 6) {
      this.db.exec(`BEGIN; ALTER TABLE automation_assignment ADD COLUMN resource_ids_json TEXT;
        INSERT INTO schema_migrations(version, applied_at) VALUES (6, datetime('now')); COMMIT;`);
    }
    if (version < 7) {
      this.db.exec(`BEGIN;
        ALTER TABLE automation_assignment ADD COLUMN stop_mode TEXT CHECK (stop_mode IN ('now', 'end-of-cycle'));
        ALTER TABLE automation_assignment ADD COLUMN stop_requested_at TEXT;
        INSERT INTO schema_migrations(version, applied_at) VALUES (7, datetime('now'));
        COMMIT;`);
    }
    if (version < 8) {
      this.db.exec(`BEGIN; ALTER TABLE automation_assignment ADD COLUMN scanning_json TEXT;
        INSERT INTO schema_migrations(version, applied_at) VALUES (8, datetime('now')); COMMIT;`);
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
    return this.saveAutomationAssignments([value])[0]!;
  }

  saveAutomationAssignments(values: readonly SavedAutomationAssignment[]): AutomationAssignmentRecord[] {
    if (values.length === 0) throw new Error('Save at least one Automation assignment');
    if (new Set(values.map((value) => value.fleetAddress)).size !== values.length) throw new Error('Each fleet can have only one Automation assignment');
    const now = new Date().toISOString();
    const current = new Map(this.listAutomationAssignments().map((assignment) => [assignment.fleetAddress, assignment]));
    const selected = new Set(values.map((value) => value.fleetAddress));
    const insert = this.db.prepare(`
      INSERT INTO automation_assignment(
        profile, fleet_address, fleet_name, assignment, home_system_address, home_system_id,
        home_system_name, resource_id, resource_name, destination_address, destination_name,
        travel_mode, enabled, status, target_stop_at_unix_seconds, last_action, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'disabled', NULL, NULL, NULL, ?)
      ON CONFLICT(fleet_address) DO UPDATE SET
        profile=excluded.profile, fleet_name=excluded.fleet_name, assignment=excluded.assignment,
        home_system_address=excluded.home_system_address, home_system_id=excluded.home_system_id,
        home_system_name=excluded.home_system_name, resource_id=excluded.resource_id,
        resource_name=excluded.resource_name, destination_address=excluded.destination_address,
        destination_name=excluded.destination_name, travel_mode=excluded.travel_mode,
        enabled=0, status='disabled', target_stop_at_unix_seconds=NULL,
        last_action=NULL, last_error=NULL, pending_json=NULL, stop_mode=NULL,
        stop_requested_at=NULL, updated_at=excluded.updated_at
    `);
    const queue = this.db.prepare('UPDATE automation_assignment SET pending_json = ?, updated_at = ? WHERE fleet_address = ?');
    this.db.exec('BEGIN');
    try {
      for (const existing of current.values()) if (!selected.has(existing.fleetAddress)) {
        this.db.prepare('DELETE FROM scanning_runtime WHERE fleet = ?').run(existing.fleetAddress);
        this.db.prepare('DELETE FROM automation_assignment WHERE fleet_address = ?').run(existing.fleetAddress);
      }
      for (const value of values) {
        const existing = current.get(value.fleetAddress);
        const unchanged = existing && Object.entries(value).every(([key, field]) => JSON.stringify(existing[key as keyof SavedAutomationAssignment]) === JSON.stringify(field));
        if (unchanged) {
          if (existing.pendingAssignment) queue.run(null, now, value.fleetAddress);
          continue;
        }
        if (existing && (existing.enabled || existing.status === 'paused')) {
          queue.run(JSON.stringify(value), now, value.fleetAddress);
          continue;
        }
        this.db.prepare('DELETE FROM scanning_runtime WHERE fleet = ?').run(value.fleetAddress);
        insert.run(value.profile, value.fleetAddress, value.fleetName, value.assignment, value.homeSystemAddress,
          value.homeSystemId, value.homeSystemName, value.resourceId, value.resourceName,
          value.destinationAddress, value.destinationName, value.travelMode, now);
        this.db.prepare('UPDATE automation_assignment SET resource_ids_json = ?, scanning_json = ? WHERE fleet_address = ?').run(JSON.stringify(value.resourceIds ?? [value.resourceId]), scanningJson(value), value.fleetAddress);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listAutomationAssignments();
  }

  private mapAutomationAssignment(row: Omit<AutomationAssignmentRecord, 'enabled' | 'targetStopAtUnixSeconds' | 'pendingAssignment' | 'stopMode' | 'stopRequestedAt'> & { enabled: number; targetStopAtUnixSeconds: string | null; pendingJson: string | null; resourceIdsJson: string | null; scanningJson: string | null; stopMode: AutomationStopMode | null; stopRequestedAt: string | null }): AutomationAssignmentRecord {
    const { targetStopAtUnixSeconds, pendingJson, resourceIdsJson, scanningJson, stopMode, stopRequestedAt, ...rest } = row;
    return { ...rest, ...(scanningJson == null ? {} : JSON.parse(scanningJson)), resourceIds: resourceIdsJson === null ? [row.resourceId] : JSON.parse(resourceIdsJson), enabled: row.enabled === 1, ...(targetStopAtUnixSeconds === null ? {} : { targetStopAtUnixSeconds: BigInt(targetStopAtUnixSeconds) }), ...(pendingJson === null ? {} : { pendingAssignment: JSON.parse(pendingJson) as SavedAutomationAssignment }), ...(stopMode === null ? {} : { stopMode }), ...(stopRequestedAt === null ? {} : { stopRequestedAt }) };
  }

  listAutomationAssignments(): AutomationAssignmentRecord[] {
    const rows = this.db.prepare(`
      SELECT profile, fleet_address AS fleetAddress, fleet_name AS fleetName, assignment,
             home_system_address AS homeSystemAddress, home_system_id AS homeSystemId,
             home_system_name AS homeSystemName, resource_id AS resourceId, resource_name AS resourceName,
             destination_address AS destinationAddress, destination_name AS destinationName,
             travel_mode AS travelMode, enabled, status,
             target_stop_at_unix_seconds AS targetStopAtUnixSeconds,
             last_action AS lastAction, last_error AS lastError, updated_at AS updatedAt,
             pending_json AS pendingJson, resource_ids_json AS resourceIdsJson, scanning_json AS scanningJson,
             stop_mode AS stopMode, stop_requested_at AS stopRequestedAt
      FROM automation_assignment ORDER BY fleet_name COLLATE NOCASE, fleet_address
    `).all() as unknown as Array<Omit<AutomationAssignmentRecord, 'enabled' | 'targetStopAtUnixSeconds' | 'pendingAssignment' | 'stopMode' | 'stopRequestedAt'> & { enabled: number; targetStopAtUnixSeconds: string | null; pendingJson: string | null; resourceIdsJson: string | null; scanningJson: string | null; stopMode: AutomationStopMode | null; stopRequestedAt: string | null }>;
    return rows.map((row) => this.mapAutomationAssignment(row));
  }

  getAutomationAssignment(fleetAddress?: string): AutomationAssignmentRecord | undefined {
    return fleetAddress
      ? this.listAutomationAssignments().find((assignment) => assignment.fleetAddress === fleetAddress)
      : this.listAutomationAssignments()[0];
  }

  applyPendingAutomationAssignment(fleetAddress: string): AutomationAssignmentRecord {
    const current = this.getAutomationAssignment(fleetAddress);
    if (!current?.pendingAssignment) throw new Error('No pending Automation assignment exists for this fleet');
    const value = current.pendingAssignment;
    this.db.exec('SAVEPOINT apply_pending_assignment');
    try {
      const result = this.db.prepare(`UPDATE automation_assignment SET
        profile=?, fleet_name=?, assignment=?, home_system_address=?, home_system_id=?, home_system_name=?,
        resource_id=?, resource_name=?, destination_address=?, destination_name=?, travel_mode=?,
        resource_ids_json=?, scanning_json=?, pending_json=NULL, last_action=NULL, last_error=NULL, updated_at=? WHERE fleet_address=?`).run(
        value.profile, value.fleetName, value.assignment, value.homeSystemAddress, value.homeSystemId,
        value.homeSystemName, value.resourceId, value.resourceName, value.destinationAddress,
        value.destinationName, value.travelMode, JSON.stringify(value.resourceIds ?? [value.resourceId]), scanningJson(value), new Date().toISOString(), fleetAddress,
      );
      if (result.changes !== 1) throw new Error('Automation assignment disappeared while applying its pending update');
      this.db.prepare('DELETE FROM scanning_runtime WHERE fleet = ?').run(fleetAddress);
      this.db.exec('RELEASE apply_pending_assignment');
    } catch(error) {
      this.db.exec('ROLLBACK TO apply_pending_assignment; RELEASE apply_pending_assignment');
      throw error;
    }
    return this.getAutomationAssignment(fleetAddress)!;
  }

  setAutomationEnabled(enabled: boolean, fleetAddress?: string): AutomationAssignmentRecord {
    const selected = fleetAddress ?? this.getAutomationAssignment()?.fleetAddress;
    if (!selected) throw new Error('Save an Automation assignment before changing its state');
    const result = this.db.prepare(`UPDATE automation_assignment SET enabled = ?, status = ?, last_error = NULL, updated_at = ? WHERE fleet_address = ?`)
      .run(enabled ? 1 : 0, enabled ? 'running' : 'disabled', new Date().toISOString(), selected);
    if (result.changes !== 1) throw new Error('Save an Automation assignment before changing its state');
    return this.getAutomationAssignment(selected)!;
  }

  requestAutomationStop(mode: AutomationStopMode, fleetAddress: string): AutomationAssignmentRecord {
    if (mode !== 'now' && mode !== 'end-of-cycle') throw new Error('Invalid Automation stop mode');
    const assignment = this.getAutomationAssignment(fleetAddress);
    if (!assignment) throw new Error('Fleet Automation assignment was not found');
    if (assignment.status === 'paused') throw new Error(`Fleet ${assignment.fleetName} must be reconciled before it can be stopped`);
    if (!assignment.enabled || assignment.status !== 'running') throw new Error(`Fleet ${assignment.fleetName} Automation is not running`);
    const requestedAt = new Date().toISOString();
    this.db.prepare(`UPDATE automation_assignment SET stop_mode = ?, stop_requested_at = ?, pending_json = NULL, updated_at = ? WHERE fleet_address = ?`)
      .run(mode, requestedAt, requestedAt, fleetAddress);
    return this.getAutomationAssignment(fleetAddress)!;
  }

  completeAutomationStop(fleetAddress: string): AutomationAssignmentRecord {
    const assignment = this.getAutomationAssignment(fleetAddress);
    if (!assignment?.stopMode) throw new Error('No Automation stop request exists for this fleet');
    const result = this.db.prepare(`UPDATE automation_assignment SET
      enabled = 0, status = 'disabled', target_stop_at_unix_seconds = NULL,
      pending_json = NULL, stop_mode = NULL, stop_requested_at = NULL,
      last_action = 'stopped', last_error = NULL, updated_at = ? WHERE fleet_address = ?`)
      .run(new Date().toISOString(), fleetAddress);
    if (result.changes !== 1) throw new Error('Fleet Automation assignment disappeared while stopping');
    return this.getAutomationAssignment(fleetAddress)!;
  }

  setAutomationTargetStop(value: bigint | undefined, fleetAddress?: string): void {
    const selected = fleetAddress ?? this.getAutomationAssignment()?.fleetAddress;
    if (!selected) return;
    this.db.prepare(`UPDATE automation_assignment SET target_stop_at_unix_seconds = ?, updated_at = ? WHERE fleet_address = ?`)
      .run(value?.toString() ?? null, new Date().toISOString(), selected);
  }

  setAutomationLastAction(action: string, fleetAddress?: string): void {
    const selected = fleetAddress ?? this.getAutomationAssignment()?.fleetAddress;
    if (!selected) return;
    this.db.prepare(`UPDATE automation_assignment SET last_action = ?, updated_at = ? WHERE fleet_address = ?`)
      .run(action, new Date().toISOString(), selected);
  }

  confirmAutomationAction(value: { fleetAddress?: string; fleetName?: string; action: string; signature: string; detail: string; targetStopAtUnixSeconds?: bigint }): void {
    const selected = value.fleetAddress ?? this.getAutomationAssignment()?.fleetAddress;
    if (!selected) throw new Error('No Automation assignment exists to confirm');
    const assignment = this.getAutomationAssignment(selected)!;
    this.db.exec('BEGIN');
    try {
      const targetStop = value.action === 'start-mining' ? value.targetStopAtUnixSeconds?.toString() : value.action === 'stop-mining' ? null : undefined;
      if (value.action === 'start-mining' && targetStop === undefined) throw new Error('start-mining confirmation requires a target stop time');
      if (targetStop === undefined) this.db.prepare(`UPDATE automation_assignment SET last_action = ?, updated_at = ? WHERE fleet_address = ?`).run(value.action, new Date().toISOString(), selected);
      else this.db.prepare(`UPDATE automation_assignment SET target_stop_at_unix_seconds = ?, last_action = ?, updated_at = ? WHERE fleet_address = ?`).run(targetStop, value.action, new Date().toISOString(), selected);
      this.recordAutomationActivity({ fleetAddress: selected, fleetName: value.fleetName ?? assignment.fleetName, kind: 'confirmed', action: value.action, signature: value.signature, detail: value.detail });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pauseAutomation(reason: string, fleetAddress?: string): AutomationAssignmentRecord {
    const selected = fleetAddress ?? this.getAutomationAssignment()?.fleetAddress;
    if (!selected) throw new Error('No Automation assignment exists to pause');
    const result = this.db.prepare(`UPDATE automation_assignment SET enabled = 0, status = 'paused', last_error = ?, updated_at = ? WHERE fleet_address = ?`)
      .run(reason.slice(0, 2_000), new Date().toISOString(), selected);
    if (result.changes !== 1) throw new Error('No Automation assignment exists to pause');
    return this.getAutomationAssignment(selected)!;
  }

  setAutomationBlocked(reason: string, fleetAddress: string): AutomationAssignmentRecord {
    const result = this.db.prepare(`UPDATE automation_assignment SET enabled = 0, status = 'disabled', last_error = ?, updated_at = ? WHERE fleet_address = ?`)
      .run(reason.slice(0, 2_000), new Date().toISOString(), fleetAddress);
    if (result.changes !== 1) throw new Error('No Automation assignment exists to block');
    return this.getAutomationAssignment(fleetAddress)!;
  }

  recordAutomationActivity(value: Omit<AutomationActivityRecord, 'id' | 'occurredAt'>): AutomationActivityRecord {
    const occurredAt = new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO automation_activity(occurred_at, kind, action, signature, detail, fleet_address, fleet_name) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(occurredAt, value.kind, value.action ?? null, value.signature ?? null, value.detail.slice(0, 4_000), value.fleetAddress ?? null, value.fleetName ?? null);
    return { id: Number(result.lastInsertRowid), occurredAt, ...value };
  }

  listAutomationActivity(limit = 50): AutomationActivityRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.db.prepare(`SELECT id, occurred_at AS occurredAt, kind, action, signature, detail, fleet_address AS fleetAddress, fleet_name AS fleetName FROM automation_activity ORDER BY id DESC LIMIT ?`)
      .all(safeLimit) as unknown as AutomationActivityRecord[];
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
      DELETE FROM scanning_runtime;
      DELETE FROM scanning_receipts;
      DELETE FROM automation_assignment;
      DELETE FROM automation_activity;
    `);
  }

  close(): void {
    this.db.close();
  }
}

function scanningJson(value: SavedAutomationAssignment): string | null {
  return value.assignment === 'scanning' ? JSON.stringify({scanPatternId: value.scanPatternId, scanSectorX: value.scanSectorX, scanSectorY: value.scanSectorY}) : null;
}
