import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

type StoredAuditRow = {
  assessment_id: string;
  result_json: string;
};

export function migrateLegacyIndustryAudits(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT assessment_id, result_json
    FROM assessments
    WHERE result_json IS NOT NULL
  `).all() as StoredAuditRow[];
  const update = database.prepare(
    'UPDATE assessments SET result_json = ? WHERE assessment_id = ?',
  );

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.result_json);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const audit = parsed as Record<string, unknown>;
    if (!Object.hasOwn(audit, 'industryClassification') || Object.hasOwn(audit, 'industryLabel')) continue;
    const { industryClassification: _legacy, ...rest } = audit;
    update.run(JSON.stringify({
      ...rest,
      industryLabel: null,
      industryEvidenceIds: [],
    }), row.assessment_id);
  }
}

export function initializeDatabase(database: DatabaseSync): DatabaseSync {
  // Preflight before any schema change: never silently choose a user's surviving token.
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tokens'").get();
  if (exists) {
    const duplicates = database.prepare('SELECT user_id, count(*) AS count FROM tokens GROUP BY user_id HAVING count(*) > 1').all();
    if (duplicates.length) throw new Error(`TOKEN_MIGRATION_DUPLICATE_USERS: ${JSON.stringify(duplicates)}`);
  }
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA busy_timeout=5000');
  database.exec('BEGIN IMMEDIATE');
  try {
    if (exists) {
      const columns = database.prepare('PRAGMA table_info(tokens)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'email')) {
        database.exec('ALTER TABLE tokens RENAME TO tokens_legacy_identity');
        database.exec(SCHEMA_SQL);
        database.exec(`INSERT INTO tokens(token_hash,user_id,enabled,created_at,updated_at)
          SELECT token_hash,user_id,enabled,created_at,created_at FROM tokens_legacy_identity`);
        database.exec('DROP TABLE tokens_legacy_identity');
      }
    }
    database.exec(SCHEMA_SQL);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  const assessmentColumns = database.prepare('PRAGMA table_info(assessments)').all() as Array<{ name: string }>;
  if (!assessmentColumns.some(column => column.name === 'result_json')) {
    database.exec('ALTER TABLE assessments ADD COLUMN result_json TEXT');
  }
  if (!assessmentColumns.some(column => column.name === 'evidence_snapshot_json')) {
    database.exec('ALTER TABLE assessments ADD COLUMN evidence_snapshot_json TEXT');
  }
  migrateLegacyIndustryAudits(database);
  return database;
}

export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try { return initializeDatabase(database); }
  catch (error) { database.close(); throw error; }
}
