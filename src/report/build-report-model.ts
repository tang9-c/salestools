import {
  EvidenceBundleSchema,
  IdentityProfileSchema,
  isQccUnavailableLinkAuditGap,
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

export type ReportGapCategory = 'rating' | 'enhancement' | 'audit';

const ARK_INPUT_CAPACITY_GAP_PATTERN = /(?:方舟输入.*容量.*\d+\/\d+|Ark 批次处理失败：\d+\/\d+|Ark 容量上限未处理证据：\d+)/u;
const EXPLICIT_AUDIT_GAP_PATTERN = /来源|链接|url|网址|上游|获取失败|调用失败|无法结构化验证|适配器契约|工具不可用|未调用|未重试|企查查|豆包|年报|链接不可用|Ark|方舟|超时|材料未处理|证据未处理|模型未从.*提炼|多批次.*冲突/iu;
const ENHANCEMENT_GAP_PATTERN = /融资|预算|时机|时间|周期|决策|审批|采购计划|扩容|替换/iu;

/**
 * Categorizes an already-recorded gap for Markdown presentation only.
 * Opportunity evaluation happens before report-model construction and does not
 * consult this function.
 */
export function classifyReportGap(gap: string): ReportGapCategory {
  if (ARK_INPUT_CAPACITY_GAP_PATTERN.test(gap)) return 'audit';
  if (EXPLICIT_AUDIT_GAP_PATTERN.test(gap)) return 'audit';
  if (ENHANCEMENT_GAP_PATTERN.test(gap)) return 'enhancement';
  return 'rating';
}

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

/** Presentation order only; never used for opportunity scoring. */
export function rankReportFacts(
  facts: readonly EvidenceFact[],
  references: ReadonlyMap<string, EvidenceReference>,
  collectedAt: string,
): EvidenceFact[] {
  const cutoff = Date.parse(collectedAt);
  const date = (fact: EvidenceFact): number => {
    const dates = fact.evidenceIds.map(id => Date.parse(references.get(id)?.publishedAt ?? ''));
    return dates.length > 0 && dates.every(value => Number.isFinite(value) && value <= cutoff)
      ? Math.min(...dates) : Number.NEGATIVE_INFINITY;
  };
  const seen = new Set<string>();
  return [...facts].sort((a, b) => Number(b.strength === 'direct') - Number(a.strength === 'direct')
    || date(b) - date(a)).filter(fact => {
    const key = fact.statement.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const rawBaseGaps = uniqueInOrder([
    ...evidence.gaps,
    ...evidence.conflicts,
    ...(recommended === null ? assessment.summaryReasons : recommended.gaps),
  ]);
  const unavailableQccLinkCount = rawBaseGaps.filter(isQccUnavailableLinkAuditGap).length;
  const baseGaps = uniqueInOrder([
    ...rawBaseGaps.filter(gap => !isQccUnavailableLinkAuditGap(gap)),
    ...(unavailableQccLinkCount === 0
      ? []
      : [`企查查有 ${unavailableQccLinkCount} 条证据未提供直接来源链接`]),
  ]);
  const actionableGaps = baseGaps.filter(gap => classifyReportGap(gap) !== 'audit');
  const discoveryFacts = rankReportFacts(reliableFacts.filter(fact =>
    ['recruitment', 'software_ecosystem', 'product_scene', 'procurement', 'quality', 'manufacturing'].includes(fact.kind)), referencesById, evidence.collectedAt)
    .sort((a, b) => {
      const product = assessment.recommendedProduct;
      return product === null ? 0 : Number(b.productTags.includes(product)) - Number(a.productTags.includes(product));
    });
  const topics = new Set<string>();
  const selectedDiscoveryFacts = discoveryFacts.filter(fact => {
    const topic = fact.kind === 'procurement' ? 'timing' : fact.kind === 'software_ecosystem' ? 'ecosystem' : 'scenario';
    if (topics.has(topic)) return false;
    topics.add(topic);
    return true;
  });
  const discoveryQuestions = selectedDiscoveryFacts.map(fact => {
    const question = fact.kind === 'recruitment'
      ? '该岗位对应现有工具的维护还是新增团队？实际使用的软件、席位和扩容计划分别是什么？'
      : fact.kind === 'procurement'
        ? '该项目目前是计划、招标、已成交还是已结束？本次可参与的范围和时间窗口是什么？'
        : fact.kind === 'software_ecosystem'
          ? '该系统目前覆盖哪些团队和版本？有没有明确的扩容、集成或替换问题？'
          : '这一场景目前由什么工具和流程支撑？最需要改善的具体环节及负责岗位是什么？';
    const sources = uniqueInOrder(fact.evidenceIds.map(id => referencesById.get(id)!.title));
    return `资料记载“${fact.statement}”（来源：${sources.join('、')}）。${question}`;
  });

  return ReportModelSchema.parse({
    legalName: identity.legalName,
    industryLabel: evidence.industryLabel,
    industryEvidenceIds: evidence.industryEvidenceIds,
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
    salesQuestions: discoveryQuestions.length > 0
      ? discoveryQuestions
      : assessment.recommendedProduct === null ? [] : [...SALES_QUESTIONS[assessment.recommendedProduct]],
    risks: uniqueInOrder(reliableFacts.filter(fact => fact.kind === 'risk').map(fact => fact.statement)),
    gaps: baseGaps,
    nextVerificationActions: actionableGaps.length === 0
      ? ['联系研发或质量负责人，了解现有工具、具体痛点和近期项目安排']
      : actionableGaps.map(gap => `访谈确认：${gap}；请相关负责人说明现状与计划`),
    sourceStatus,
    collectedAt: evidence.collectedAt,
    dynamicSignalFreshness: dynamicSignalFreshness(evidence.collectedAt),
  });
}
