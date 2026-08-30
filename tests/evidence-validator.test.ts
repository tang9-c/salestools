import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EvidenceBundle, ResearchBundle } from '../src/contracts/index.js';
import {
  ArkEvidenceValidationError,
  validateArkEvidence,
} from '../src/upstream/ark/evidence-validator.js';

function fixture(): EvidenceBundle {
  return JSON.parse(readFileSync(new URL('./fixtures/ark-evidence.json', import.meta.url), 'utf8'));
}

function researchBundle(): ResearchBundle {
  const evidence = fixture();
  const reference = evidence.evidence[0];
  return {
    identity: evidence.identity,
    items: [{
      ...reference,
      source: 'doubao_search',
      sourceKind: 'web',
      summary: '岗位负责参数化机械设计。',
      content: '测试制造有限公司正在招聘 Creo 机械设计工程师。',
      query: '测试制造有限公司 Creo 招聘',
      position: 1,
      logId: 'doubao-log-123',
    }],
    sourceStatus: {
      qcc: { status: 'failed', error: '企查查暂不可用' },
      doubaoSearch: { status: 'completed', error: null },
    },
    gaps: [],
    collectedAt: evidence.collectedAt,
  };
}

function expectInvalid(candidate: unknown, research = researchBundle()): void {
  expect(() => validateArkEvidence(research, candidate)).toThrow(ArkEvidenceValidationError);
}

describe('validateArkEvidence', () => {
  it('accepts a strict evidence bundle whose identity and provenance come from the research bundle', () => {
    const candidate = fixture();
    expect(validateArkEvidence(researchBundle(), candidate)).toEqual(candidate);
  });

  it('rejects invented evidence IDs and URLs', () => {
    const candidate = fixture();
    expectInvalid({
      ...candidate,
      evidence: [{ ...candidate.evidence[0], evidenceId: 'invented-id' }],
    });
    expectInvalid({
      ...candidate,
      evidence: [{ ...candidate.evidence[0], url: 'https://invented.example/evidence' }],
    });
  });

  it('rejects altered publisher, domain, mentioned name, or match basis', () => {
    const candidate = fixture();
    for (const changedReference of [
      { ...candidate.evidence[0], originalPublisher: '模型补写的发布方' },
      { ...candidate.evidence[0], originalDomain: 'invented.example' },
      { ...candidate.evidence[0], mentionedName: '另一家公司' },
      { ...candidate.evidence[0], matchBasis: ['模型改写的依据'] },
      { ...candidate.evidence[0], matchBasis: [] },
    ]) {
      expectInvalid({ ...candidate, evidence: [changedReference] });
    }
  });

  it('rejects identity aliases or other identity fields invented by the model', () => {
    const candidate = fixture();
    expectInvalid({
      ...candidate,
      identity: { ...candidate.identity, aliases: [...candidate.identity.aliases, '模型新别名'] },
    });
  });

  it('requires every fact and financing record to cite existing evidence', () => {
    const candidate = fixture();
    expectInvalid({
      ...candidate,
      facts: [{ ...candidate.facts[0], evidenceIds: [] }],
    });
    expectInvalid({
      ...candidate,
      facts: [{ ...candidate.facts[0], evidenceIds: ['missing'] }],
    });
    expectInvalid({
      ...candidate,
      financingRecords: [{
        occurredAt: null,
        typeOrRound: 'A轮',
        disclosedAmount: null,
        investors: [],
        evidenceIds: [],
      }],
    });
  });

  it('requires a non-unverified industry classification to cite existing evidence', () => {
    const candidate = fixture();
    expectInvalid({ ...candidate, industryEvidenceIds: [] });
    expectInvalid({ ...candidate, industryEvidenceIds: ['missing'] });
  });

  it('requires complete subject attribution on every cited source and extracted fact', () => {
    const candidate = fixture();
    expectInvalid({
      ...candidate,
      facts: [{ ...candidate.facts[0], matchBasis: [] }],
    });

    const research = researchBundle();
    research.items[0] = { ...research.items[0], mentionedName: '' };
    expectInvalid(candidate, research);
  });

  it('rejects a model attempt to promote unverified source attribution into a confirmed fact', () => {
    const candidate = fixture();
    const research = researchBundle();
    research.items[0] = {
      ...research.items[0],
      entityScope: 'unknown',
      entityMatch: 'unverified',
      matchBasis: ['网页仅提及简称'],
    };
    const unverifiedReference = {
      ...candidate.evidence[0],
      entityScope: 'unknown' as const,
      entityMatch: 'unverified' as const,
      matchBasis: ['网页仅提及简称'],
    };

    expectInvalid({
      ...candidate,
      industryClassification: 'unverified',
      industryEvidenceIds: [],
      evidence: [unverifiedReference],
      facts: [{ ...candidate.facts[0], evidenceIds: ['web-1'] }],
    }, research);
  });

  it('rejects fact match basis invented outside its cited references', () => {
    const candidate = fixture();
    expectInvalid({
      ...candidate,
      facts: [{ ...candidate.facts[0], matchBasis: ['模型新造的主体依据'] }],
    });
  });

  it('does not accept a verified industry classification supported only by unverified entity evidence', () => {
    const candidate = fixture();
    const research = researchBundle();
    research.items[0] = {
      ...research.items[0],
      entityScope: 'unknown',
      entityMatch: 'unverified',
      matchBasis: ['网页仅提及简称'],
    };
    const unverifiedReference = {
      ...candidate.evidence[0],
      entityScope: 'unknown' as const,
      entityMatch: 'unverified' as const,
      matchBasis: ['网页仅提及简称'],
    };

    expectInvalid({
      ...candidate,
      evidence: [unverifiedReference],
      facts: [],
    }, research);
  });

  it('allows an empty research bundle only as an unverified, fact-free result', () => {
    const candidate = fixture();
    const emptyResearch: ResearchBundle = {
      ...researchBundle(),
      items: [],
      sourceStatus: {
        qcc: { status: 'failed', error: '企查查无可用资料' },
        doubaoSearch: { status: 'failed', error: '搜索无可用资料' },
      },
      gaps: ['未获得可用证据'],
    };
    const emptyEvidence: EvidenceBundle = {
      ...candidate,
      industryClassification: 'unverified',
      industryEvidenceIds: [],
      evidence: [],
      facts: [],
      financingRecords: [],
      conflicts: [],
      gaps: ['未获得可用证据'],
    };

    expect(validateArkEvidence(emptyResearch, emptyEvidence)).toEqual(emptyEvidence);
    expectInvalid({ ...emptyEvidence, industryClassification: 'P1' }, emptyResearch);
    expectInvalid({ ...emptyEvidence, facts: candidate.facts }, emptyResearch);
    expectInvalid({ ...emptyEvidence, evidence: candidate.evidence }, emptyResearch);
  });
});
