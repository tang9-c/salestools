import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

export function initializeDatabase(database: DatabaseSync): DatabaseSync {
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA busy_timeout=5000');
  database.exec(SCHEMA_SQL);
  const assessmentColumns = database.prepare('PRAGMA table_info(assessments)').all() as Array<{ name: string }>;
  if (!assessmentColumns.some(column => column.name === 'result_json')) {
    database.exec('ALTER TABLE assessments ADD COLUMN result_json TEXT');
  }
  return database;
}

export function openDatabase(path: string): DatabaseSync {
  return initializeDatabase(new DatabaseSync(path));
}
