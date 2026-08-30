import {
  EvidenceBundleSchema,
  IdentityProfileSchema,
  OpportunityAssessmentSchema,
  ReportModelSchema,
  type EvidenceBundle,
  type EvidenceFact,
  type EvidenceReference,
  type IdentityProfile,
  type OpportunityAssessment,
  type ProductKey,
  type ReportModel,
} from '../contracts/index.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const DYNAMIC_SIGNAL_MAX_AGE_MS = 7 * DAY_MS;

const SALES_QUESTIONS: Readonly<Record<ProductKey, readonly string[]>> = {
  windchill: [
    '当前 BOM、工程变更和配置管理分别由哪些系统或表格承载？',
    '研发、制造和质量团队之间如何同步产品数据与版本？',
    '当前系统的扩容、替换或集成计划由谁负责，预算和决策流程是什么？',
  ],
  feigenbaum_qms: [
    '当前 CAPA、审计和质量追溯由哪些系统承载？',
    '供应商质量与内部质量流程之间有哪些数据断点？',
    '质量系统升级由哪个岗位负责，预算和决策流程是什么？',
  ],
  creo: [
    '机械设计团队当前主要使用哪些 CAD 工具和版本？',
    '参数化建模、工程变更或二次开发中最耗时的环节是什么？',
    'CAD 工具选型、扩容或替换由谁负责，预算和决策流程是什么？',
  ],
  catia: [
    '复杂曲面和大型装配目前使用哪些设计工具？',
    '跨团队设计协同和数据交换的主要障碍是什么？',
    'CATIA 相关工具选型、扩容或替换由谁负责？',
  ],
  abaqus: [
    '当前结构、非线性或材料仿真主要使用哪些工具？',
    '哪些仿真任务存在精度、算力或流程效率瓶颈？',
    'CAE 工具采购和方法验证由哪些岗位共同决策？',
  ],
  cst: [
    '射频、天线或 EMC/EMI 仿真当前使用哪些工具？',
    '电磁仿真的精度、求解效率或协同瓶颈是什么？',
    '电磁仿真工具采购和验证由哪些岗位共同决策？',
  ],
  solidworks: [
    '机械与设备设计团队当前使用哪些三维设计和 PDM 工具？',
    '多型号设计复用、图纸管理和工程变更有哪些痛点？',
    'SolidWorks 相关扩容、替换或集成由谁负责？',
  ],
};

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))];
}

function sameIdentity(left: IdentityProfile, right: IdentityProfile): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertKnownEvidenceIds(evidence: EvidenceBundle, assessment: OpportunityAssessment): void {
  const known = new Set(evidence.evidence.map(reference => reference.evidenceId));
  const used = [
    ...evidence.industryEvidenceIds,
    ...evidence.facts.flatMap(fact => fact.evidenceIds),
    ...evidence.financingRecords.flatMap(record => record.evidenceIds),
    ...assessment.products.flatMap(product => product.evidenceIds),
  ];
  for (const evidenceId of used) {
    if (!known.has(evidenceId)) throw new Error(`Unknown evidence reference: ${evidenceId}`);
  }
}

function isConfirmedTargetReference(reference: EvidenceReference | undefined): boolean {
  return reference?.entityScope === 'legal_entity' && reference.entityMatch === 'confirmed';
}

function attributedTargetFacts(
  facts: readonly EvidenceFact[],
  referencesById: ReadonlyMap<string, EvidenceReference>,
): EvidenceFact[] {
  return facts.filter(fact => fact.entityScope === 'legal_entity'
    && fact.entityMatch === 'confirmed'
    && fact.evidenceIds.length > 0
    && fact.evidenceIds.every(evidenceId => isConfirmedTargetReference(referencesById.get(evidenceId))));
}

function latestFinancing(
  evidence: EvidenceBundle,
  referencesById: ReadonlyMap<string, EvidenceReference>,
): EvidenceBundle['financingRecords'][number] | null {
  let latest: EvidenceBundle['financingRecords'][number] | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const record of evidence.financingRecords) {
    if (record.evidenceIds.length === 0
      || !record.evidenceIds.every(evidenceId => isConfirmedTargetReference(referencesById.get(evidenceId)))) {
      continue;
    }
    const occurredAt = record.occurredAt === null ? Number.NEGATIVE_INFINITY : Date.parse(record.occurredAt);
    if (latest === null || occurredAt > latestTime) {
      latest = record;
      latestTime = occurredAt;
    }
  }
  return latest;
}

function dynamicSignalFreshness(collectedAt: string): ReportModel['dynamicSignalFreshness'] {
  return Date.now() - Date.parse(collectedAt) > DYNAMIC_SIGNAL_MAX_AGE_MS ? 'stale' : 'current';
}

export function buildReportModel(
  identityInput: IdentityProfile,
  evidenceInput: EvidenceBundle,
  assessmentInput: OpportunityAssessment,
  sourceStatus: ReportModel['sourceStatus'],
): ReportModel {
  const identity = IdentityProfileSchema.parse(identityInput);
  const evidence = EvidenceBundleSchema.parse(evidenceInput);
  const assessment = OpportunityAssessmentSchema.parse(assessmentInput);
  if (!sameIdentity(identity, evidence.identity)) {
    throw new Error('Report identity does not match evidence identity');
  }
  assertKnownEvidenceIds(evidence, assessment);

  const referencesById = new Map(evidence.evidence.map(reference => [reference.evidenceId, reference]));
  const reportFacts = attributedTargetFacts(evidence.facts, referencesById);
  const reliableFacts = reportFacts.filter(fact => fact.strength !== 'weak');
  const latest = latestFinancing(evidence, referencesById);
  const selectedEvidenceIds = new Set([
    ...evidence.industryEvidenceIds,
    ...reportFacts.flatMap(fact => fact.evidenceIds),
    ...(latest?.evidenceIds ?? []),
    ...assessment.products.flatMap(product => product.evidenceIds),
  ]);
  const recommended = assessment.recommendedProduct === null
    ? null
    : assessment.products.find(product => product.product === assessment.recommendedProduct) ?? null;
  const baseGaps = uniqueInOrder([
    ...evidence.gaps,
    ...evidence.conflicts,
    ...(recommended === null ? assessment.summaryReasons : recommended.gaps),
    ...(assessment.recommendedProduct === null && evidence.industryClassification === 'unverified'
      ? ['行业和产品技术场景待核实']
      : []),
  ]);

  return ReportModelSchema.parse({
    legalName: identity.legalName,
    industryClassification: evidence.industryClassification,
    companyScaleClues: uniqueInOrder(reliableFacts
      .filter(fact => fact.kind === 'organization' || fact.kind === 'manufacturing')
      .map(fact => fact.statement)),
    overallOpportunity: assessment.overallOpportunity,
    recommendedProduct: assessment.recommendedProduct,
    summaryReasons: assessment.summaryReasons,
    latestFinancing: latest,
    products: assessment.products,
    facts: reportFacts,
    evidence: evidence.evidence.filter(reference => selectedEvidenceIds.has(reference.evidenceId)),
    salesQuestions: assessment.recommendedProduct === null
      ? []
      : [...SALES_QUESTIONS[assessment.recommendedProduct]],
    risks: uniqueInOrder(reliableFacts.filter(fact => fact.kind === 'risk').map(fact => fact.statement)),
    gaps: baseGaps,
    nextVerificationActions: baseGaps.length === 0
      ? ['核实当前软件生态、预算和独立决策权']
      : baseGaps.map(gap => `核实${gap}`),
    sourceStatus,
    collectedAt: evidence.collectedAt,
    dynamicSignalFreshness: dynamicSignalFreshness(evidence.collectedAt),
  });
}
