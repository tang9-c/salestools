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
