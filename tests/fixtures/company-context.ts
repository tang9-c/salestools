import type { StoredCompanyProfile } from '../../src/db/profile-repository.js';
import type { OrganizationIdentity } from '../../src/companies/company-context-types.js';

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
