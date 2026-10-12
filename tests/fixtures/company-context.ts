import type { StoredCompanyProfile } from '../../src/db/profile-repository.js';
import type { OrganizationIdentity } from '../../src/companies/company-context-types.js';
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { initializeDatabase } from '../../src/db/database.js';
import { ProfileRepository } from '../../src/db/profile-repository.js';
import { AssessmentRepository } from '../../src/db/assessment-repository.js';
import { CompanyLinkRepository } from '../../src/db/company-link-repository.js';
import { CompanyContextService } from '../../src/companies/company-context-service.js';
import { identityHash } from '../../src/companies/company-link.js';
import type { GraphClient } from '../../src/contacts/graph-client.js';

const chars = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
const prefix = '91310000123456789';
export const CODE = prefix + chars[(31 - [...prefix].reduce((n, c, i) => n + chars.indexOf(c) * weights[i], 0) % 31) % 31];
export const AT = '2026-10-12T00:00:00.000Z';
export const ORG: OrganizationIdentity = {
  entity_id: 'o1', version: 1, name: '测试装备有限公司', legal_name: null,
  identifiers: [], archived: false, identity_complete: true, evidence: [], conflicts: [],
};
export const PROFILE: StoredCompanyProfile = {
  identity: { legalName: '测试装备有限公司', creditCode: CODE, formerNames: [], aliases: [],
    englishNames: [], brands: [], officialDomains: [], registeredAddress: null,
    parentLegalName: null, subsidiaryLegalNames: [] },
  normalizedLegalName: '测试装备有限公司', collectedAt: AT,
  basicProfile: { industry: null, region: null, company_type: null, founded_year: null,
    registered_capital: null, legal_representative: null, website: null,
    employee_range: null, risk_summary: null, collected_at: AT },
};

export function createContextFixture() {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  const links = new CompanyLinkRepository(db), profiles = new ProfileRepository(db);
  const assessments = new AssessmentRepository(db);
  const org = structuredClone(ORG);
  profiles.upsert(PROFILE);
  links.write({ action: 'confirm', organization_id: 'o1', credit_code: CODE,
    operation_id: 'fixture-link', expected_link_version: 0, expected_organization_version: 1,
    note: '合成数据人工关联' }, 'test', identityHash(org), AT);
  const request = vi.fn(async (op: string, _payload: unknown, _signal?: AbortSignal): Promise<unknown> => {
    if (op === 'company_organizations') return { items: [org], total: 1, next_offset: null, complete: true };
    if (op === 'company_relations' || op === 'company_recent_records')
      return { items: [], total: 0, next_offset: null, complete: true };
    throw new Error(`Unexpected graph operation: ${op}`);
  });
  const graph = { request, close: async () => {} } as unknown as GraphClient;
  const service = new CompanyContextService({ graph, links, profiles, assessments,
    now: () => new Date(AT), profileTtlDays: 30 });
  return { db, links, profiles, assessments, org, request, graph, service };
}
