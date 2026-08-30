import { describe, expect, it } from 'vitest';
import {
  AssessmentReportOutputSchema,
  AssessmentStatusOutputSchema,
  CompanyProfileOutputSchema,
  countIndependentPublishers,
  EvidenceBundleSchema,
  EvidenceContractError,
  IdentityProfileSchema,
  OpportunityAssessmentSchema,
  ProductKeySchema,
  ReportModelSchema,
  ResearchBundleSchema,
  SubmitAssessmentOutputSchema,
  validateEvidenceProvenance,
} from '../src/contracts/index.js';

const timestamp = '2026-08-29T12:34:56.789Z';

const identity = {
  legalName: '测试制造有限公司',
  creditCode: '91310000TEST000001',
  formerNames: [],
  aliases: ['测试制造'],
  englishNames: [],
  brands: [],
  officialDomains: ['example.cn'],
  registeredAddress: null,
  parentLegalName: null,
  subsidiaryLegalNames: [],
};

const item = {
  evidenceId: 'ev-1',
  source: 'doubao_search' as const,
  sourceKind: 'web' as const,
  title: '原始标题',
  url: 'https://publisher.example/article',
  originalPublisher: '原始出版者',
  originalDomain: 'publisher.example',
  summary: null,
  content: null,
  publishedAt: null,
  collectedAt: timestamp,
  mentionedName: '测试制造有限公司',
  entityScope: 'legal_entity' as const,
  entityMatch: 'confirmed' as const,
  matchBasis: ['统一社会信用代码'],
  query: null,
  position: null,
  logId: null,
};

const reference = {
  evidenceId: item.evidenceId,
  title: item.title,
  url: item.url,
  originalPublisher: item.originalPublisher,
  originalDomain: item.originalDomain,
  publishedAt: item.publishedAt,
  collectedAt: item.collectedAt,
  mentionedName: item.mentionedName,
  entityScope: item.entityScope,
  entityMatch: item.entityMatch,
  matchBasis: item.matchBasis,
};

const productKeys = ProductKeySchema.options;
const products = productKeys.map(product => ({
  product,
  level: '待核实' as const,
  evidenceIds: [],
  reasons: [],
  blockers: [],
  gaps: [],
}));

const researchBundle = {
  identity,
  items: [item],
  sourceStatus: {
    qcc: { status: 'completed' as const, error: null },
    doubaoSearch: { status: 'partial' as const, error: '部分结果' },
  },
  gaps: [],
  collectedAt: timestamp,
};

const evidenceBundle = {
  identity,
  industryClassification: 'P1' as const,
  industryEvidenceIds: ['ev-1'],
  evidence: [reference],
  facts: [{
    factId: 'fact-1',
    statement: '有复杂制造流程',
    kind: 'manufacturing' as const,
    productTags: ['windchill' as const],
    strength: 'direct' as const,
    evidenceIds: ['ev-1'],
    entityScope: 'legal_entity' as const,
    entityMatch: 'confirmed' as const,
    matchBasis: ['公司全称'],
  }],
  financingRecords: [{
    occurredAt: null,
    typeOrRound: null,
    disclosedAmount: null,
    investors: [],
    evidenceIds: [],
  }],
  conflicts: [],
  gaps: [],
  collectedAt: timestamp,
};

const report = {
  legalName: identity.legalName,
  industryClassification: 'P1' as const,
  industryEvidenceIds: evidenceBundle.industryEvidenceIds,
  companyScaleClues: [],
  overallOpportunity: '待核实' as const,
  recommendedProduct: null,
  summaryReasons: [],
  latestFinancing: null,
  products,
  facts: evidenceBundle.facts,
  evidence: [reference],
  salesQuestions: [],
  risks: [],
  gaps: [],
  nextVerificationActions: [],
  sourceStatus: { qcc: 'completed' as const, doubaoSearch: 'partial' as const, ark: 'completed' as const },
  collectedAt: timestamp,
  dynamicSignalFreshness: 'current' as const,
};

describe('shared contracts', () => {
  it('accepts the five complete contract shapes including explicit nulls', () => {
    expect(IdentityProfileSchema.parse(identity)).toEqual(identity);
    expect(ResearchBundleSchema.parse(researchBundle)).toEqual(researchBundle);
    expect(EvidenceBundleSchema.parse(evidenceBundle)).toEqual(evidenceBundle);
    expect(OpportunityAssessmentSchema.parse({
      products,
      overallOpportunity: '待核实',
      recommendedProduct: null,
      summaryReasons: [],
    }).recommendedProduct).toBeNull();
    expect(ReportModelSchema.parse(report)).toEqual(report);
  });

  it('rejects unknown fields at every nested object level', () => {
    expect(IdentityProfileSchema.safeParse({ ...identity, extra: true }).success).toBe(false);
    expect(ResearchBundleSchema.safeParse({ ...researchBundle, extra: true }).success).toBe(false);
    expect(ResearchBundleSchema.safeParse({ ...researchBundle, identity: { ...identity, extra: true } }).success).toBe(false);
    expect(ResearchBundleSchema.safeParse({ ...researchBundle, items: [{ ...item, extra: true }] }).success).toBe(false);
    expect(ResearchBundleSchema.safeParse({
      ...researchBundle,
      sourceStatus: { ...researchBundle.sourceStatus, extra: true },
    }).success).toBe(false);
    expect(ResearchBundleSchema.safeParse({
      ...researchBundle,
      sourceStatus: { ...researchBundle.sourceStatus, qcc: { ...researchBundle.sourceStatus.qcc, extra: true } },
    }).success).toBe(false);
    expect(EvidenceBundleSchema.safeParse({ ...evidenceBundle, extra: true }).success).toBe(false);
    expect(EvidenceBundleSchema.safeParse({ ...evidenceBundle, evidence: [{ ...reference, extra: true }] }).success).toBe(false);
    expect(EvidenceBundleSchema.safeParse({ ...evidenceBundle, facts: [{ ...evidenceBundle.facts[0], extra: true }] }).success).toBe(false);
    expect(EvidenceBundleSchema.safeParse({
      ...evidenceBundle,
      financingRecords: [{ ...evidenceBundle.financingRecords[0], extra: true }],
    }).success).toBe(false);
    expect(OpportunityAssessmentSchema.safeParse({
      products,
      overallOpportunity: '待核实',
      recommendedProduct: null,
      summaryReasons: [],
      extra: true,
    }).success).toBe(false);
    expect(OpportunityAssessmentSchema.safeParse({
      products: products.map((entry, index) => index === 0 ? { ...entry, extra: true } : entry),
      overallOpportunity: '待核实',
      recommendedProduct: null,
      summaryReasons: [],
    }).success).toBe(false);
    expect(ReportModelSchema.safeParse({ ...report, extra: true }).success).toBe(false);
    expect(ReportModelSchema.safeParse({
      ...report,
      facts: [{ ...report.facts[0], extra: true }],
    }).success).toBe(false);
    expect(ReportModelSchema.safeParse({ ...report, sourceStatus: { ...report.sourceStatus, extra: true } }).success).toBe(false);
  });

  it('accepts only millisecond-precision UTC timestamps', () => {
    for (const invalid of [
      '2026-08-29T12:34:56Z',
      '2026-08-29T12:34:56.789+00:00',
      '2026-08-29T12:34:56.789-07:00',
      '2026-08-29T12:34:56.789',
      '2026-08-29',
    ]) {
      expect(ResearchBundleSchema.safeParse({ ...researchBundle, collectedAt: invalid }).success).toBe(false);
    }
  });

  it('rejects dangling, duplicate, or missing product rows', () => {
    const base = {
      overallOpportunity: '待核实' as const,
      recommendedProduct: null,
      summaryReasons: [],
    };
    expect(OpportunityAssessmentSchema.safeParse({ ...base, products: products.slice(0, 6) }).success).toBe(false);
    expect(OpportunityAssessmentSchema.safeParse({ ...base, products: [...products.slice(0, 6), products[0]] }).success).toBe(false);
    expect(OpportunityAssessmentSchema.safeParse({
      ...base,
      products: products.map((entry, index) => index === 0 ? { ...entry, product: 'dangling' } : entry),
    }).success).toBe(false);
    expect(ReportModelSchema.safeParse({ ...report, products: products.slice(0, 6) }).success).toBe(false);
  });

  it('keeps evidence provenance fields byte-for-byte in the contract', () => {
    const parsed = EvidenceBundleSchema.parse(evidenceBundle);
    expect(parsed.evidence[0]).toEqual(reference);
    expect(parsed.evidence[0].originalPublisher).toBe(item.originalPublisher);
    expect(parsed.evidence[0].originalDomain).toBe(item.originalDomain);
  });

  it('accepts null original publisher and domain on research and evidence references', () => {
    const nullableItem = { ...item, originalPublisher: null, originalDomain: null };
    const nullableReference = { ...reference, originalPublisher: null, originalDomain: null };
    expect(ResearchBundleSchema.safeParse({ ...researchBundle, items: [nullableItem] }).success).toBe(true);
    expect(EvidenceBundleSchema.safeParse({ ...evidenceBundle, evidence: [nullableReference] }).success).toBe(true);
  });

  it('allows a missing QCC direct link but still requires a safe direct search URL', () => {
    const qccWithoutLink = {
      ...item,
      source: 'qcc' as const,
      sourceKind: 'operation' as const,
      url: null,
    };
    const qccReferenceWithoutLink = { ...reference, url: null };

    expect(ResearchBundleSchema.safeParse({ ...researchBundle, items: [qccWithoutLink] }).success).toBe(true);
    expect(EvidenceBundleSchema.safeParse({
      ...evidenceBundle,
      evidence: [qccReferenceWithoutLink],
    }).success).toBe(true);
    expect(ResearchBundleSchema.safeParse({
      ...researchBundle,
      items: [{ ...item, url: null }],
    }).success).toBe(false);
    for (const unsafe of ['javascript:alert(1)', 'https://user:password@example.cn/private', 'https://agent.qcc.com/data']) {
      expect(ResearchBundleSchema.safeParse({
        ...researchBundle,
        items: [{ ...item, url: unsafe }],
      }).success).toBe(false);
    }
  });

  it('validates nullable QCC URL provenance byte-for-byte', () => {
    const qccItem = {
      ...item,
      source: 'qcc' as const,
      sourceKind: 'operation' as const,
      url: null,
    };
    const qccReference = { ...reference, url: null };
    const qccResearch = { ...researchBundle, items: [qccItem] };
    const qccEvidence = { ...evidenceBundle, evidence: [qccReference] };

    expect(validateEvidenceProvenance(qccResearch, qccEvidence)).toEqual(qccEvidence);
  });

  it('validates references and every evidence-id edge against research provenance', () => {
    expect(validateEvidenceProvenance(researchBundle, evidenceBundle)).toEqual(evidenceBundle);
    expect(() => validateEvidenceProvenance(researchBundle, {
      ...evidenceBundle,
      evidence: [{ ...reference, url: 'https://invented.example/article' }],
    })).toThrow(EvidenceContractError);
    expect(() => validateEvidenceProvenance(researchBundle, {
      ...evidenceBundle,
      industryEvidenceIds: ['missing'],
    })).toThrow(EvidenceContractError);
    expect(() => validateEvidenceProvenance(researchBundle, {
      ...evidenceBundle,
      facts: [{ ...evidenceBundle.facts[0], evidenceIds: ['missing'] }],
    })).toThrow(EvidenceContractError);
    expect(() => validateEvidenceProvenance(researchBundle, {
      ...evidenceBundle,
      financingRecords: [{ ...evidenceBundle.financingRecords[0], evidenceIds: ['missing'] }],
    })).toThrow(EvidenceContractError);
  });

  it('deduplicates original publishers by normalized domain with publisher fallback', () => {
    expect(countIndependentPublishers([
      reference,
      { ...reference, evidenceId: 'ev-2', originalDomain: ' WWW.Publisher.Example ', originalPublisher: '转载媒体' },
      { ...reference, evidenceId: 'ev-3', originalDomain: null, originalPublisher: ' Ａｃｍｅ ' },
      { ...reference, evidenceId: 'ev-4', originalDomain: null, originalPublisher: 'acme' },
      { ...reference, evidenceId: 'ev-5', originalDomain: null, originalPublisher: null },
    ])).toBe(2);
  });

  it('never accepts a failed or partial Ark result as a report', () => {
    expect(ReportModelSchema.safeParse({ ...report, sourceStatus: { ...report.sourceStatus, ark: 'partial' } }).success).toBe(false);
    expect(ReportModelSchema.safeParse({ ...report, sourceStatus: { ...report.sourceStatus, ark: 'failed' } }).success).toBe(false);
  });
});

describe('MCP output unions', () => {
  const candidate = {
    legal_name: identity.legalName,
    credit_code: identity.creditCode,
    status: null,
    registered_address: null,
    match_reason: '精确名称',
  };
  const basicProfile = {
    industry: null,
    region: null,
    company_type: null,
    founded_year: null,
    registered_capital: null,
    legal_representative: null,
    website: null,
    employee_range: null,
    risk_summary: null,
    collected_at: timestamp,
  };
  const assessmentId = '10bd94c4-724a-4ca9-87fb-f474f563d475';

  it('freezes get_company_profile variants and candidate/cache rules', () => {
    expect(CompanyProfileOutputSchema.safeParse({
      source_status: 'completed', candidates: [candidate], basic_profile: basicProfile, cache_hit: true,
    }).success).toBe(true);
    expect(CompanyProfileOutputSchema.safeParse({
      source_status: 'completed', candidates: [candidate, { ...candidate, credit_code: 'other' }], basic_profile: null, cache_hit: false,
    }).success).toBe(true);
    expect(CompanyProfileOutputSchema.safeParse({
      source_status: 'failed', candidates: [], basic_profile: null, cache_hit: false, message: '上游失败',
    }).success).toBe(true);
    expect(CompanyProfileOutputSchema.safeParse({
      source_status: 'completed', candidates: [candidate, { ...candidate, credit_code: 'other' }], basic_profile: basicProfile, cache_hit: false,
    }).success).toBe(false);
    expect(CompanyProfileOutputSchema.safeParse({
      source_status: 'completed', candidates: [candidate, { ...candidate, credit_code: 'other' }], basic_profile: null, cache_hit: true,
    }).success).toBe(false);
    expect(CompanyProfileOutputSchema.safeParse({
      source_status: 'failed', candidates: [], basic_profile: null, cache_hit: false, message: '失败', extra: true,
    }).success).toBe(false);
    expect(CompanyProfileOutputSchema.safeParse({
      source_status: 'completed', candidates: [{ ...candidate, extra: true }], basic_profile: basicProfile, cache_hit: false,
    }).success).toBe(false);
    expect(CompanyProfileOutputSchema.safeParse({
      source_status: 'completed', candidates: [candidate], basic_profile: { ...basicProfile, extra: true }, cache_hit: false,
    }).success).toBe(false);
  });

  it('freezes the two and only two submit_assessment variants', () => {
    expect(SubmitAssessmentOutputSchema.safeParse({
      assessment_id: assessmentId, status: 'processing', estimated_minutes: '5-10', cache_hit: false,
    }).success).toBe(true);
    expect(SubmitAssessmentOutputSchema.safeParse({
      assessment_id: assessmentId, status: 'completed', cache_hit: true, cached_at: timestamp,
    }).success).toBe(true);
    expect(SubmitAssessmentOutputSchema.safeParse({
      assessment_id: assessmentId, status: 'processing', estimated_minutes: '5-10', cache_hit: true,
    }).success).toBe(false);
    expect(SubmitAssessmentOutputSchema.safeParse({
      assessment_id: assessmentId, status: 'failed', cache_hit: false,
    }).success).toBe(false);
  });

  it('freezes assessment status and report unions', () => {
    for (const status of ['processing', 'completed', 'failed'] as const) {
      expect(AssessmentStatusOutputSchema.safeParse({ assessment_id: assessmentId, status, message: '状态' }).success).toBe(true);
    }
    for (const status of ['processing', 'failed'] as const) {
      expect(AssessmentReportOutputSchema.safeParse({ assessment_id: assessmentId, status, message: '状态' }).success).toBe(true);
    }
    const completed = {
      assessment_id: assessmentId,
      status: 'completed' as const,
      legal_name: identity.legalName,
      overall_opportunity: '待核实' as const,
      recommended_product: null,
      collected_at: timestamp,
      dynamic_signal_freshness: 'stale' as const,
      source_status: { qcc: 'partial' as const, doubao_search: 'completed' as const, ark: 'completed' as const },
      markdown: '# 报告',
    };
    expect(AssessmentReportOutputSchema.safeParse(completed).success).toBe(true);
    expect(AssessmentReportOutputSchema.safeParse({ ...completed, cache_hit: true }).success).toBe(false);
    expect(AssessmentReportOutputSchema.safeParse({ ...completed, financing_status: 'unknown' }).success).toBe(false);
    expect(AssessmentReportOutputSchema.safeParse({
      ...completed, source_status: { ...completed.source_status, ark: 'failed' },
    }).success).toBe(false);
    expect(AssessmentReportOutputSchema.safeParse({
      ...completed, source_status: { ...completed.source_status, extra: true },
    }).success).toBe(false);
    expect(AssessmentStatusOutputSchema.safeParse({
      assessment_id: assessmentId, status: 'processing', message: '状态', extra: true,
    }).success).toBe(false);
    expect(AssessmentReportOutputSchema.safeParse({
      assessment_id: assessmentId, status: 'processing', message: '状态', extra: true,
    }).success).toBe(false);
  });
});
