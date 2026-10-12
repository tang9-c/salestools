export type LinkState = 'unlinked' | 'candidate' | 'confirmed' | 'conflict' | 'revoked';
export type ReadState = 'ok' | 'partial' | 'unavailable' | 'not_applicable';

export interface ReadMeta { state: ReadState; warnings: string[] }
export interface Count { count: number | null; loaded_count: number; complete: boolean }
export interface Page<T> { items: T[]; total: number | null; next_offset: number | null; complete: boolean }

export interface OrganizationIdentity {
  entity_id: string;
  version: number;
  name: string | null;
  legal_name: string | null;
  identifiers: Array<{ '@type': 'PropertyValue'; propertyID: string; value: string }>;
  archived: boolean;
  identity_complete: boolean;
  evidence: import('../contracts/index.js').ContactEvidence[];
  conflicts: import('../contracts/index.js').ContactEvidence[];
}

export interface RecentRecord {
  kind: 'entity' | 'relation' | 'evidence' | 'profile' | 'assessment';
  id: string;
  entity_id?: string;
  recorded_at: string;
  label: string;
}

export interface CompanyLink {
  organization_id: string;
  credit_code: string | null;
  state: 'confirmed' | 'revoked';
  version: number;
  identity_hash: string;
  organization_version: number;
  note: string;
  actor: string;
  updated_at: string;
}

export interface LinkWrite {
  action: 'confirm' | 'unlink';
  organization_id: string;
  credit_code?: string;
  operation_id: string;
  expected_link_version: number;
  expected_organization_version: number;
  note: string;
}

export interface LinkResolution {
  state: LinkState;
  organization_id: string;
  credit_code: string | null;
  basis: 'manual' | 'identifier_match' | null;
  version: number;
  candidates: Array<{ credit_code: string; legal_name: string }>;
  warnings: string[];
}

export interface ReportItem {
  assessment_id: string;
  generated_at: string;
  collected_at: string;
  overall_opportunity: string;
  recommended_product: string | null;
}

export interface ReportSummary { count: number; latest: ReportItem | null }

export interface CompanySummary extends ReadMeta {
  link: LinkResolution;
  has_profile: boolean | null;
  report_count: number | null;
  latest_report_at: string | null;
}

export interface CompanyDetail extends CompanySummary {
  profile: import('../db/profile-repository.js').StoredCompanyProfile | null;
  latest_report: ReportItem | null;
  reports: Page<ReportItem>;
}

export interface CompanyOverview extends ReadMeta {
  organization_ids: string[];
  organizations_complete: boolean;
  people: Count;
  projects: Count;
  reports: ReportSummary | null;
}

export interface RelatedUpdates extends ReadMeta {
  since: string;
  scope: string[];
  items: RecentRecord[];
  truncated: boolean;
}

export interface ContextCitation {
  ref: string; source_type: 'contact' | 'profile' | 'assessment'; subject_id: string;
  quote?: string; value?: unknown; evidence_id?: string; entity_id?: string;
  relation_id?: string; assessment_id?: string; source_url?: string;
  file_name?: string; page?: number; collected_at?: string; published_at?: string;
}
export interface ContextMaterial {
  citation: ContextCitation; statement: string; source_key: string;
  predicate: string; object: string; employment_status?: string;
  required_context_refs?: string[];
}
export interface ContextMaterials extends ReadMeta {
  items: ContextMaterial[]; omitted_count: number; contacts_read: number;
}
export interface MaterialReadContext {
  readonly signal: AbortSignal; remaining_contacts: number; remaining_materials: number; remaining_relation_pages: number;
  readonly selected_report_id: string | null; report_reads: number;
  report: import('../db/assessment-repository.js').AssessmentRecord | null | undefined;
  contacts: Map<string, Record<string, unknown> | null>;
}
