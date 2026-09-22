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
    CREATE INDEX IF NOT EXISTS assignment_history_lookup ON assignment_history(profile,fleet_address,effective_at,id);
    INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis)
      SELECT profile,fleet_address,fleet_name,assignment,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'observed-baseline'
      FROM automation_assignment a WHERE NOT EXISTS
      (SELECT 1 FROM assignment_history h WHERE h.profile=a.profile AND h.fleet_address=a.fleet_address);
    CREATE TRIGGER IF NOT EXISTS assignment_history_insert AFTER INSERT ON automation_assignment BEGIN
      INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis)
      VALUES(NEW.profile,NEW.fleet_address,NEW.fleet_name,NEW.assignment,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'effective-change');
    END;
    CREATE TRIGGER IF NOT EXISTS assignment_history_update AFTER UPDATE ON automation_assignment
    WHEN OLD.assignment IS NOT NEW.assignment OR OLD.fleet_name IS NOT NEW.fleet_name OR OLD.profile IS NOT NEW.profile BEGIN
      INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis)
      SELECT OLD.profile,OLD.fleet_address,OLD.fleet_name,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'removed'
      WHERE OLD.profile IS NOT NEW.profile;
      INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis)
      VALUES(NEW.profile,NEW.fleet_address,NEW.fleet_name,NEW.assignment,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'effective-change');
    END;
    CREATE TRIGGER IF NOT EXISTS assignment_history_delete AFTER DELETE ON automation_assignment BEGIN
      INSERT INTO assignment_history(profile,fleet_address,fleet_name,assignment,effective_at,basis)
      VALUES(OLD.profile,OLD.fleet_address,OLD.fleet_name,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'removed');
    END;
  `); db.exec('RELEASE assignment_history_install');
  } catch(error) {db.exec('ROLLBACK TO assignment_history_install; RELEASE assignment_history_install');throw error;}
}
