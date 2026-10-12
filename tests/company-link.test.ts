import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { CompanyLinkRepository } from '../src/db/company-link-repository.js';
import { CompanyLinkService, identityHash, resolveCompanyLink, validCreditCode } from '../src/companies/company-link.js';
import type { CompanyLink, OrganizationIdentity } from '../src/companies/company-context-types.js';
import type { ContactEvidence } from '../src/contracts/index.js';
import type { GraphClient } from '../src/contacts/graph-client.js';
import { ORG, PROFILE, CODE, AT } from './fixtures/company-context.js';

const evidence = (field_path: string, value: unknown): ContactEvidence => ({
  evidence_id: `${field_path}:${JSON.stringify(value)}`, subject_kind: 'entity', subject_id: 'o1',
  field_path, value, source_type: 'manual', locator_status: 'not_applicable', collected_at: AT,
} as ContactEvidence);
const saved = (org: OrganizationIdentity): CompanyLink => ({
  organization_id: org.entity_id, credit_code: CODE, state: 'confirmed', version: 1,
  identity_hash: identityHash(org), organization_version: org.version, note: '人工确认', actor: 'test', updated_at: AT,
});

it('checks checksum and hashes identity fields only', () => {
  expect(validCreditCode(CODE)).toBe(true);
  expect(validCreditCode(CODE.slice(0, 17) + (CODE[17] === '0' ? '1' : '0'))).toBe(false);
  expect(identityHash(ORG)).toBe(identityHash({ ...ORG, version: 2, evidence: [evidence('properties.name', ORG.name)] }));
  expect(identityHash(ORG)).not.toBe(identityHash({ ...ORG, name: '另一个组织' }));
});

it('resolves evidence backed codes and names, and fails closed on incomplete or conflicting identity', () => {
  expect(resolveCompanyLink(ORG, null, [PROFILE]).state).toBe('candidate');
  const withCode = { ...ORG, identifiers: [{ '@type': 'PropertyValue' as const, propertyID: '统一社会信用代码', value: CODE }] };
  expect(resolveCompanyLink(withCode, null, [PROFILE]).state).toBe('candidate');
  const proven = { ...withCode, evidence: [evidence('properties.identifier', withCode.identifiers[0]),
    evidence('properties.name', withCode.name)] };
  expect(resolveCompanyLink(proven, null, [PROFILE]).state).toBe('confirmed');
  expect(resolveCompanyLink({ ...proven, conflicts: proven.evidence }, null, [PROFILE]).state).toBe('conflict');
  expect(resolveCompanyLink({ ...proven, identity_complete: false }, null, [PROFILE]).state).toBe('conflict');
  expect(resolveCompanyLink({ ...proven, archived: true }, null, [PROFILE]).state).toBe('unlinked');
  expect(resolveCompanyLink({ ...ORG, name: '测试品牌' }, null, [{ ...PROFILE, identity: { ...PROFILE.identity, brands: ['测试品牌'] } }]).state).toBe('unlinked');
});

it('honors revocation and changed confirmed identity', () => {
  expect(resolveCompanyLink(ORG, { ...saved(ORG), state: 'revoked' }, [PROFILE]).state).toBe('revoked');
  expect(resolveCompanyLink({ ...ORG, name: '另一个组织' }, saved(ORG), [PROFILE]).state).toBe('conflict');
});

it('returns identical committed receipt after immediate graph identity change and replays without graph reads', async () => {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  try {
    const profiles = new ProfileRepository(db); profiles.upsert(PROFILE);
    const links = new CompanyLinkRepository(db), org = structuredClone(ORG);
    const request = vi.fn(async () => ({ items: [structuredClone(org)], total: 1, next_offset: null, complete: true }));
    const graph = { request, close: async () => {} } as unknown as GraphClient;
    const originalWrite = links.write.bind(links);
    vi.spyOn(links, 'write').mockImplementationOnce((...args) => {
      const receipt = originalWrite(...args);
      org.name = '另一个组织'; org.version = 2;
      return receipt;
    });
    const service = new CompanyLinkService({ graph, links, profiles, now: () => new Date(AT) });
    const input = { action: 'confirm' as const, organization_id: 'o1', credit_code: CODE,
      operation_id: 'race', expected_link_version: 0, expected_organization_version: 1, note: '人工确认合成主体' };
    const first = await service.change(input, 'test');
    const reads = request.mock.calls.length;
    const replay = await service.change(input, 'test');
    expect(replay).toEqual(first);
    expect(request).toHaveBeenCalledTimes(reads);
    expect(db.prepare('SELECT count(*) AS n FROM company_link_operations').get()?.n).toBe(1);
    expect(resolveCompanyLink(org, links.get('o1'), [PROFILE]).state).toBe('conflict');
  } finally { db.close(); }
});
