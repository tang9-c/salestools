export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_profiles (
  credit_code TEXT PRIMARY KEY,
  normalized_legal_name TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  basic_profile_json TEXT NOT NULL,
  collected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS company_profiles_normalized_name
ON company_profiles(normalized_legal_name);

CREATE TABLE IF NOT EXISTS contact_query_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  normalized_region_hint TEXT,
  result_json TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  stored_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS contact_snapshots_cache_time
ON contact_query_snapshots(cache_key, stored_at DESC, snapshot_id DESC);

CREATE TABLE IF NOT EXISTS assessments (
  assessment_id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  credit_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  report_markdown TEXT,
  recommended_product TEXT,
  overall_opportunity TEXT,
  source_status_json TEXT,
  result_json TEXT,
  evidence_snapshot_json TEXT,
  collected_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  cached_at TEXT,
  failed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS one_processing_per_company
ON assessments(cache_key) WHERE status = 'processing';
`;
