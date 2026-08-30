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

  it('rejects washing a mixed confirmed and unverified citation set into one confirmed fact', () => {
    const candidate = fixture();
    const research = researchBundle();
    const unverifiedItem = {
      ...research.items[0],
      evidenceId: 'web-2',
      title: '简称相关转载',
      url: 'https://news.example.net/repost',
      originalPublisher: '转载站',
      originalDomain: 'news.example.net',
      mentionedName: '测试制造',
      entityScope: 'unknown' as const,
      entityMatch: 'unverified' as const,
      matchBasis: ['网页仅提及简称'],
    };
    research.items.push(unverifiedItem);
    const unverifiedReference = {
      evidenceId: unverifiedItem.evidenceId,
      title: unverifiedItem.title,
      url: unverifiedItem.url,
      originalPublisher: unverifiedItem.originalPublisher,
      originalDomain: unverifiedItem.originalDomain,
      publishedAt: unverifiedItem.publishedAt,
      collectedAt: unverifiedItem.collectedAt,
      mentionedName: unverifiedItem.mentionedName,
      entityScope: unverifiedItem.entityScope,
      entityMatch: unverifiedItem.entityMatch,
      matchBasis: unverifiedItem.matchBasis,
    };

    expectInvalid({
      ...candidate,
      evidence: [...candidate.evidence, unverifiedReference],
      facts: [{ ...candidate.facts[0], evidenceIds: ['web-1', 'web-2'] }],
    }, research);
  });

  it('rejects fact match basis invented outside its cited references', () => {
    const candidate = fixture();
    expectInvalid({
      ...candidate,
      facts: [{ ...candidate.facts[0], matchBasis: ['模型新造的主体依据'] }],
    });
  });

  it.each([
    ['organization', '董事长 64 岁，因此属于老年一代掌权并偏向保守决策'],
    ['risk', '高管人格激进，预计决策风格偏冒险'],
    ['organization', '按员工人数和行业人效倒推真实营收约 5 亿元'],
    ['risk', '预计营收将在明年达到 10 亿元'],
    ['procurement', '公司有采购需求并计划采购 Windchill'],
    ['risk', '公司存在采购 意向'],
    ['organization', '按行业人效乘以员工人数倒推营业收入'],
  ] as const)('rejects unsupported inference in a %s fact: %s', (kind, statement) => {
    const candidate = fixture();
    expectInvalid({
      ...candidate,
      facts: [{ ...candidate.facts[0], kind, statement }],
    });
  });

  it.each([
    ['conflicts', '董事长年龄较大，因此决策风格保守'],
    ['gaps', '预计营收约 5 亿元'],
    ['gaps', '公司即将采购 CATIA'],
  ] as const)('rejects unsupported inference hidden in %s: %s', (field, statement) => {
    const candidate = fixture();
    expectInvalid({ ...candidate, [field]: [statement] });
  });

  it('keeps direct recruitment and published tender facts', () => {
    const candidate = fixture();
    const accepted = {
      ...candidate,
      facts: [
        { ...candidate.facts[0], statement: '公司发布 Windchill 管理员招聘岗位', kind: 'recruitment' as const },
        { ...candidate.facts[0], factId: 'fact-tender', statement: '公司已发布软件采购招标公告', kind: 'procurement' as const },
        { ...candidate.facts[0], factId: 'fact-revenue', statement: '年报披露 2025 年营业收入 5 亿元', kind: 'budget' as const },
      ],
    };
    expect(validateArkEvidence(researchBundle(), accepted)).toEqual(accepted);
  });

  it.each([
    { typeOrRound: '按董事长年龄判断决策风格保守' },
    { disclosedAmount: '按员工人数和行业人效倒推约 5 亿元' },
    { investors: ['投资方计划采购某软件'] },
  ])('rejects unsupported inference in every renderable financing field: %j', polluted => {
    const candidate = fixture();
    expectInvalid({
      ...candidate,
      financingRecords: [{
        occurredAt: '2026-08-20T12:00:00.000Z',
        typeOrRound: 'A 轮',
        disclosedAmount: '1 亿元',
        investors: ['测试基金'],
        evidenceIds: ['web-1'],
        ...polluted,
      }],
    });
  });

  it('keeps normal financing fields', () => {
    const candidate = fixture();
    const accepted = {
      ...candidate,
      financingRecords: [{
        occurredAt: '2026-08-20T12:00:00.000Z',
        typeOrRound: 'A 轮',
        disclosedAmount: '1 亿元',
        investors: ['测试基金'],
        evidenceIds: ['web-1'],
      }],
    };
    expect(validateArkEvidence(researchBundle(), accepted)).toEqual(accepted);
  });

  it('allows purchase wording only as a direct, confirmed, cited public procurement notice fact', () => {
    const candidate = fixture();
    const directNotice = {
      ...candidate.facts[0],
      factId: 'fact-procurement-notice',
      kind: 'procurement' as const,
      strength: 'direct' as const,
      statement: '采购公告原文披露该项目拟采购 Windchill 软件',
    };
    expect(validateArkEvidence(researchBundle(), { ...candidate, facts: [directNotice] }).facts)
      .toEqual([directNotice]);

    expectInvalid({ ...candidate, facts: [{ ...directNotice, strength: 'supporting' }] });
    expectInvalid({ ...candidate, facts: [{ ...directNotice, statement: '公司计划采购 Windchill 软件' }] });
    expectInvalid({ ...candidate, facts: [{ ...directNotice, statement: '公司已发布新品，计划采购 Windchill 软件' }] });
    expectInvalid({ ...candidate, facts: [{ ...directNotice, kind: 'organization' }] });

    const research = researchBundle();
    research.items[0] = {
      ...research.items[0],
      entityScope: 'unknown',
      entityMatch: 'unverified',
      matchBasis: ['仅提及简称'],
    };
    const unverifiedReference = {
      ...candidate.evidence[0],
      entityScope: 'unknown' as const,
      entityMatch: 'unverified' as const,
      matchBasis: ['仅提及简称'],
    };
    expectInvalid({
      ...candidate,
      industryClassification: 'unverified',
      industryEvidenceIds: [],
      evidence: [unverifiedReference],
      facts: [{
        ...directNotice,
        entityScope: 'unknown',
        entityMatch: 'unverified',
        matchBasis: ['仅提及简称'],
      }],
    }, research);
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

  it.each([
    '2026-08-30T12:00:00.000Z',
    '2026-08-28T12:00:00.000Z',
  ])('rejects an Ark-collected timestamp that differs from ResearchBundle.collectedAt: %s', collectedAt => {
    expectInvalid({ ...fixture(), collectedAt });
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
