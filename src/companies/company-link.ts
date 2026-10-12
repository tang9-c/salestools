import { createHash } from 'node:crypto';
import type { GraphClient } from '../contacts/graph-client.js';
import type { StoredCompanyProfile } from '../db/profile-repository.js';
import { ProfileRepository } from '../db/profile-repository.js';
import { CompanyLinkRepository } from '../db/company-link-repository.js';
import type { CompanyLink, LinkResolution, LinkWrite, OrganizationIdentity } from './company-context-types.js';

const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
const creditIds = new Set(['统一社会信用代码', '统一社会信用代码号', 'creditCode', 'socialCreditCode', 'USCC']);
const normalize = (value: string | null | undefined): string => (value ?? '').normalize('NFKC').replace(/\s+/gu, '').trim();

export function validCreditCode(code: string): boolean {
  if (code.length !== 18 || [...code].some(c => !alphabet.includes(c))) return false;
  const sum = [...code.slice(0, 17)].reduce((n, c, i) => n + alphabet.indexOf(c) * weights[i], 0);
  return code[17] === alphabet[(31 - sum % 31) % 31];
}

export function identityHash(org: OrganizationIdentity): string {
  const identifiers = [...new Set(org.identifiers.map(x => `${normalize(x.propertyID)}\u0000${normalize(x.value)}`))].sort();
  return createHash('sha256').update(JSON.stringify([normalize(org.name), normalize(org.legal_name), identifiers])).digest('hex');
}

function matchesEvidence(org: OrganizationIdentity, field: string, value: unknown): boolean {
  const target = JSON.stringify(value);
  const excluded = new Set(org.conflicts.map(x => x.evidence_id));
  return org.evidence.some(x => x.subject_kind === 'entity' && x.subject_id === org.entity_id
    && x.field_path === field && !excluded.has(x.evidence_id) && JSON.stringify(x.value) === target);
}

function codeEvidence(org: OrganizationIdentity, code: string): boolean {
  return org.identifiers.some(x => creditIds.has(x.propertyID) && x.value === code
    && matchesEvidence(org, 'properties.identifier', x));
}

function nameEvidence(org: OrganizationIdentity, name: string): boolean {
  if (normalize(org.legal_name)) {
    return normalize(org.legal_name) === name
      && matchesEvidence(org, 'properties.legalName', org.legal_name);
  }
  return org.name !== null && normalize(org.name) === name
    && matchesEvidence(org, 'properties.name', org.name);
}

function legalNames(profile: StoredCompanyProfile): string[] {
  return [profile.identity.legalName, ...profile.identity.formerNames].map(normalize);
}

export function resolveCompanyLink(org: OrganizationIdentity, saved: CompanyLink | null,
  profiles: StoredCompanyProfile[]): LinkResolution {
  const base: LinkResolution = { state: 'unlinked', organization_id: org.entity_id,
    credit_code: null, basis: null, version: saved?.version ?? 0, candidates: [], warnings: [] };
  if (org.archived) return base;
  if (saved?.state === 'revoked') return { ...base, state: 'revoked' };
  if (!org.identity_complete) return { ...base, state: 'conflict', warnings: ['组织身份资料未完整读取'] };
  if (saved && saved.identity_hash !== identityHash(org)) {
    return { ...base, state: 'conflict', warnings: ['组织身份已变化'] };
  }
  const rawCodes = org.identifiers.filter(x => creditIds.has(x.propertyID) && validCreditCode(x.value));
  const distinctCodes = [...new Set(rawCodes.map(x => x.value))];
  if (distinctCodes.length > 1) return { ...base, state: 'conflict', warnings: ['多个有效信用代码'] };
  const byCode = new Map(profiles.map(x => [x.identity.creditCode, x]));
  if (saved?.state === 'confirmed') {
    if (!saved.credit_code || !byCode.has(saved.credit_code)
      || (distinctCodes.length === 1 && distinctCodes[0] !== saved.credit_code)) {
      return { ...base, state: 'conflict', warnings: ['人工关联与当前企业资料冲突'] };
    }
    return { ...base, state: 'confirmed', credit_code: saved.credit_code, basis: 'manual' };
  }
  const names = [normalize(org.name), normalize(org.legal_name)].filter(Boolean);
  const candidates = profiles.filter(profile => legalNames(profile).some(name => names.includes(name)));
  if (distinctCodes.length === 1 && codeEvidence(org, distinctCodes[0])) {
    const profile = byCode.get(distinctCodes[0]);
    if (profile && legalNames(profile).some(name => names.includes(name) && nameEvidence(org, name))) {
      return { ...base, state: 'confirmed', credit_code: distinctCodes[0], basis: 'identifier_match' };
    }
  }
  if (candidates.length > 0) return { ...base, state: 'candidate',
    candidates: candidates.map(x => ({ credit_code: x.identity.creditCode, legal_name: x.identity.legalName })) };
  return base;
}

export class CompanyLinkService {
  constructor(private readonly deps: { graph: GraphClient; links: CompanyLinkRepository;
    profiles: ProfileRepository; now: () => Date }) {}

  async change(input: LinkWrite, actor: string): Promise<CompanyLink> {
    if (actor.trim() === '') throw new Error('ACTOR_REQUIRED');
    if (!input.organization_id.trim() || !input.operation_id.trim() || !input.note.trim()
      || !Number.isSafeInteger(input.expected_link_version) || input.expected_link_version < 0
      || !Number.isSafeInteger(input.expected_organization_version) || input.expected_organization_version < 0
      || (input.action !== 'confirm' && input.action !== 'unlink')) throw new Error('INVALID_LINK_WRITE');
    if (input.action === 'confirm' && (!input.credit_code || !validCreditCode(input.credit_code))) {
      throw new Error('INVALID_CREDIT_CODE');
    }
    const replay = this.deps.links.replay(input, actor);
    if (replay) return replay;
    const page = await this.deps.graph.request<{ items: OrganizationIdentity[]; total: number | null;
      next_offset: number | null; complete: boolean }>('company_organizations', {
        entity_ids: [input.organization_id], credit_codes: [], normalized_names: [], offset: 0, limit: 1,
      });
    if (!page.complete || page.next_offset !== null || page.items.length !== 1
      || page.items[0].entity_id !== input.organization_id) throw new Error('ORGANIZATION_UNAVAILABLE');
    const org = page.items[0];
    if (org.archived || !org.identity_complete) throw new Error('ORGANIZATION_UNAVAILABLE');
    if (org.version !== input.expected_organization_version) throw new Error('ORGANIZATION_VERSION_CONFLICT');
    if (input.action === 'confirm') {
      if (this.deps.profiles.findByCreditCodes([input.credit_code!]).length !== 1) throw new Error('COMPANY_PROFILE_NOT_FOUND');
      const codes = org.identifiers.filter(x => creditIds.has(x.propertyID) && validCreditCode(x.value));
      const disputedCodes = org.conflicts.filter(x => x.field_path === 'properties.identifier')
        .map(x => x.value).filter((value): value is { propertyID: string; value: string } =>
          typeof value === 'object' && value !== null && 'propertyID' in value && 'value' in value
          && typeof value.propertyID === 'string' && typeof value.value === 'string')
        .filter(x => creditIds.has(x.propertyID) && validCreditCode(x.value));
      if (codes.some(x => x.value !== input.credit_code)
        || disputedCodes.some(x => x.value !== input.credit_code)) throw new Error('CREDIT_CODE_CONFLICT');
    }
    return this.deps.links.write(input, actor, identityHash(org), this.deps.now().toISOString());
  }
}
