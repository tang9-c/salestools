import { describe, expect, it } from 'vitest';
import type { EvidenceBundle, EvidenceFact, EvidenceReference } from '../src/contracts/index.js';
import { supplementIndustryClassification } from '../src/industry/classify-industry.js';

const identity = {
  legalName: '测试能源科技股份有限公司',
  creditCode: '91310000TEST000001',
  formerNames: [], aliases: [], englishNames: [], brands: [], officialDomains: ['company.example'],
  registeredAddress: null, parentLegalName: null, subsidiaryLegalNames: [],
};

function reference(id: string, match: EvidenceReference['entityMatch'] = 'confirmed'): EvidenceReference {
  return {
    evidenceId: id,
    title: id,
    url: `https://company.example/${id}`,
    originalPublisher: '公司官网',
    originalDomain: 'company.example',
    publishedAt: null,
    collectedAt: '2026-09-01T00:00:00.000Z',
    mentionedName: identity.legalName,
    entityScope: match === 'confirmed' ? 'legal_entity' : 'unknown',
    entityMatch: match,
    matchBasis: ['官网披露'],
  };
}

function fact(
  id: string,
  statement: string,
  options: Partial<Pick<EvidenceFact, 'kind' | 'strength' | 'entityScope' | 'entityMatch' | 'evidenceIds'>> = {},
): EvidenceFact {
  return {
    factId: id,
    statement,
    kind: options.kind ?? 'industry',
    productTags: [],
    strength: options.strength ?? 'direct',
    evidenceIds: options.evidenceIds ?? [id],
    entityScope: options.entityScope ?? 'legal_entity',
    entityMatch: options.entityMatch ?? 'confirmed',
    matchBasis: ['官网披露'],
  };
}

function bundle(facts: EvidenceFact[], evidence: EvidenceReference[]): EvidenceBundle {
  return {
    identity,
    industryClassification: 'unverified',
    industryEvidenceIds: [],
    evidence,
    facts,
    financingRecords: [],
    conflicts: [],
    gaps: [],
    collectedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('supplementIndustryClassification', () => {
  it.each(['移动储能', '便携式电源', '家庭储能', '储能系统', '光伏逆变器'])('%s maps confirmed evidence to P1', keyword => {
    const result = supplementIndustryClassification(bundle(
      [fact('industry', `公司研发和制造${keyword}产品`)],
      [reference('industry')],
    ));

    expect(result.industryClassification).toBe('P1');
    expect(result.industryEvidenceIds).toEqual(['industry']);
  });

  it('keeps weak, unconfirmed, wrong-scope and unknown-reference facts unverified', () => {
    const result = supplementIndustryClassification(bundle([
      fact('weak', '移动储能设备', { strength: 'weak' }),
      fact('unconfirmed', '便携式电源', { entityMatch: 'unverified', entityScope: 'unknown' }),
      fact('group', '家庭储能系统', { entityScope: 'group' }),
      fact('missing', '光伏逆变器', { evidenceIds: ['not-present'] }),
    ], [reference('weak'), reference('unconfirmed', 'unverified'), reference('group')]));

    expect(result.industryClassification).toBe('unverified');
    expect(result.industryEvidenceIds).toEqual([]);
  });

  it('keeps conflicting P1 new-energy and P2 communication evidence unverified', () => {
    const result = supplementIndustryClassification(bundle([
      fact('energy', '公司生产移动储能设备'),
      fact('rf', '公司生产射频通信设备'),
    ], [reference('energy'), reference('rf')]));

    expect(result.industryClassification).toBe('unverified');
    expect(result.industryEvidenceIds).toEqual([]);
  });

  it('does not override a classification already returned by Ark', () => {
    const input = { ...bundle([fact('energy', '公司生产移动储能设备')], [reference('energy')]), industryClassification: 'P2' as const };
    expect(supplementIndustryClassification(input)).toEqual(input);
  });
});
