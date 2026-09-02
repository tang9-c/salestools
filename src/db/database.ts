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
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA busy_timeout=5000');
  database.exec(SCHEMA_SQL);
  const assessmentColumns = database.prepare('PRAGMA table_info(assessments)').all() as Array<{ name: string }>;
  if (!assessmentColumns.some(column => column.name === 'result_json')) {
    database.exec('ALTER TABLE assessments ADD COLUMN result_json TEXT');
  }
  migrateLegacyIndustryAudits(database);
  return database;
}

export function openDatabase(path: string): DatabaseSync {
  return initializeDatabase(new DatabaseSync(path));
}
