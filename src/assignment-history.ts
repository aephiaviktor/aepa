import type { DatabaseSync } from 'node:sqlite';
/** Append-only effective assignment history. Queue edits are not effective changes. */
export function installAssignmentHistory(db: DatabaseSync): void {
  db.exec('SAVEPOINT assignment_history_install');
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS assignment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL,
      fleet_address TEXT NOT NULL, fleet_name TEXT NOT NULL, assignment TEXT,
      effective_at TEXT NOT NULL, basis TEXT NOT NULL
    );
  `);
    const fields = ['destination_address','destination_name','home_system_address','resource_id','resource_ids_json'];
    const columns = db.prepare('PRAGMA table_info(assignment_history)').all().map(row=>row.name);
    const upgrade = !columns.includes('destination_address');
    for (const field of fields) if (!columns.includes(field)) db.exec(`ALTER TABLE assignment_history ADD COLUMN ${field} TEXT`);
    // Replace only our own triggers, atomically; pending_json is deliberately excluded.
    db.exec('DROP TRIGGER IF EXISTS assignment_history_insert; DROP TRIGGER IF EXISTS assignment_history_update; DROP TRIGGER IF EXISTS assignment_history_delete');
    db.exec(`
    CREATE INDEX IF NOT EXISTS assignment_history_lookup ON assignment_history(profile,fleet_address,effective_at,id);
    INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis,destination_address,destination_name,home_system_address,resource_id,resource_ids_json)
      SELECT profile,fleet_address,fleet_name,assignment,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'observed-baseline',destination_address,destination_name,home_system_address,resource_id,resource_ids_json
      FROM automation_assignment a WHERE NOT EXISTS
      (SELECT 1 FROM assignment_history h WHERE h.profile=a.profile AND h.fleet_address=a.fleet_address);
    CREATE TRIGGER IF NOT EXISTS assignment_history_insert AFTER INSERT ON automation_assignment BEGIN
      INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis,destination_address,destination_name,home_system_address,resource_id,resource_ids_json)
      VALUES(NEW.profile,NEW.fleet_address,NEW.fleet_name,NEW.assignment,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'effective-change',NEW.destination_address,NEW.destination_name,NEW.home_system_address,NEW.resource_id,NEW.resource_ids_json);
    END;
    CREATE TRIGGER IF NOT EXISTS assignment_history_update AFTER UPDATE ON automation_assignment
    WHEN OLD.assignment IS NOT NEW.assignment OR OLD.fleet_name IS NOT NEW.fleet_name OR OLD.profile IS NOT NEW.profile OR OLD.destination_address IS NOT NEW.destination_address OR OLD.destination_name IS NOT NEW.destination_name OR OLD.home_system_address IS NOT NEW.home_system_address OR OLD.resource_id IS NOT NEW.resource_id OR OLD.resource_ids_json IS NOT NEW.resource_ids_json BEGIN
      INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis,destination_address,destination_name,home_system_address,resource_id,resource_ids_json)
      SELECT OLD.profile,OLD.fleet_address,OLD.fleet_name,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'removed',OLD.destination_address,OLD.destination_name,OLD.home_system_address,OLD.resource_id,OLD.resource_ids_json
      WHERE OLD.profile IS NOT NEW.profile;
      INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis,destination_address,destination_name,home_system_address,resource_id,resource_ids_json)
      VALUES(NEW.profile,NEW.fleet_address,NEW.fleet_name,NEW.assignment,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'effective-change',NEW.destination_address,NEW.destination_name,NEW.home_system_address,NEW.resource_id,NEW.resource_ids_json);
    END;
    CREATE TRIGGER IF NOT EXISTS assignment_history_delete AFTER DELETE ON automation_assignment BEGIN
      INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis,destination_address,destination_name,home_system_address,resource_id,resource_ids_json)
      VALUES(OLD.profile,OLD.fleet_address,OLD.fleet_name,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'removed',OLD.destination_address,OLD.destination_name,OLD.home_system_address,OLD.resource_id,OLD.resource_ids_json);
    END;
  `);
    if (upgrade) db.exec(`INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis,destination_address,destination_name,home_system_address,resource_id,resource_ids_json) SELECT a.profile,a.fleet_address,a.fleet_name,a.assignment,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'destination-observed-baseline',a.destination_address,a.destination_name,a.home_system_address,a.resource_id,a.resource_ids_json FROM automation_assignment a WHERE a.destination_address IS NOT NULL AND EXISTS (SELECT 1 FROM assignment_history h WHERE h.profile=a.profile AND h.fleet_address=a.fleet_address AND h.destination_address IS NULL)`);
    db.exec('RELEASE assignment_history_install');
  } catch(error) {db.exec('ROLLBACK TO assignment_history_install; RELEASE assignment_history_install');throw error;}
}
