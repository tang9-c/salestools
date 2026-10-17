export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  email TEXT UNIQUE CHECK(email IS NULL OR (email = lower(trim(email)) AND length(email) > 0)),
  crm_connection_id TEXT CHECK(crm_connection_id IS NULL OR crm_connection_id IN ('qx','st')),
  crm_org_id TEXT,
  crm_user_id TEXT,
  updated_at TEXT,
  CHECK ((crm_connection_id IS NULL AND crm_org_id IS NULL AND crm_user_id IS NULL)
    OR (crm_connection_id IS NOT NULL AND crm_org_id IS NOT NULL AND crm_user_id IS NOT NULL AND email IS NOT NULL)),
  UNIQUE(crm_org_id, crm_user_id)
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

CREATE INDEX IF NOT EXISTS assessments_company_completed
ON assessments(credit_code, status, completed_at DESC, assessment_id DESC);

CREATE TABLE IF NOT EXISTS company_links (
  organization_id TEXT PRIMARY KEY,
  credit_code TEXT,
  state TEXT NOT NULL CHECK(state IN ('confirmed','revoked')),
  version INTEGER NOT NULL CHECK(version > 0),
  identity_hash TEXT NOT NULL,
  organization_version INTEGER NOT NULL,
  note TEXT NOT NULL,
  actor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS company_links_credit_code ON company_links(credit_code);

CREATE TABLE IF NOT EXISTS company_link_operations (
  actor TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  before_json TEXT,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor, operation_id)
);

CREATE TABLE IF NOT EXISTS company_research_dossiers (
 dossier_id TEXT PRIMARY KEY, credit_code TEXT NOT NULL UNIQUE, legal_name TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_research_runs (
 run_id TEXT PRIMARY KEY, dossier_id TEXT NOT NULL REFERENCES company_research_dossiers(dossier_id),
 actor TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('initial','continue','refresh')), base_version_id TEXT,
 request_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','failed','cancelled')),
 progress_json TEXT NOT NULL, budget_usage_json TEXT NOT NULL, source_status_json TEXT NOT NULL,
 stop_reason TEXT, error_code TEXT, cancelled_by TEXT,
 created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, version_id TEXT,
 UNIQUE(actor, operation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_research_per_dossier
 ON company_research_runs(dossier_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS company_research_queue ON company_research_runs(status,created_at,run_id);
CREATE INDEX IF NOT EXISTS company_research_actor_active ON company_research_runs(actor,status);
CREATE TABLE IF NOT EXISTS company_research_versions (
 version_id TEXT PRIMARY KEY, dossier_id TEXT NOT NULL REFERENCES company_research_dossiers(dossier_id),
 run_id TEXT NOT NULL UNIQUE REFERENCES company_research_runs(run_id), sequence INTEGER NOT NULL CHECK(sequence>0),
 parent_version_id TEXT, scope_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('completed','partial')), snapshot_json TEXT NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(dossier_id,sequence)
);
CREATE INDEX IF NOT EXISTS company_research_versions_dossier ON company_research_versions(dossier_id,sequence DESC);
`;
