import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

export function initializeDatabase(database: DatabaseSync): DatabaseSync {
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA busy_timeout=5000');
  database.exec(SCHEMA_SQL);
  return database;
}

export function openDatabase(path: string): DatabaseSync {
  return initializeDatabase(new DatabaseSync(path));
}
