import {
  ReportModelSchema,
  UtcTimestampSchema,
  type EvidenceFact,
  type EvidenceReference,
  type FinancingRecord,
  type ProductKey,
  type ReportModel,
} from '../contracts/index.js';
import {
  classifyReportGap,
  rankReportFacts,
  type ReportGapCategory,
} from './build-report-model.js';
import { containsKeyword } from '../opportunity/evaluate-product.js';
import { PRODUCT_RULES } from '../opportunity/product-rules.js';

export { classifyReportGap } from './build-report-model.js';

const DYNAMIC_SIGNAL_WARNING = '> ⚠️ 动态信号已超过 7 天，招聘、采购、诉讼和经营风险可能已经变化。';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

const PRODUCT_LABELS: Readonly<Record<ProductKey, string>> = {
  windchill: 'PTC Windchill',
  feigenbaum_qms: 'Feigenbaum QMS',
  creo: 'PTC Creo',
  catia: 'Dassault Systèmes CATIA',
  abaqus: 'Dassault Systèmes Abaqus',
  cst: 'CST Studio Suite',
  solidworks: 'Dassault Systèmes SolidWorks',
};

const TARGET_ROLES: Readonly<Record<ProductKey, string>> = {
  windchill: '研发负责人、PLM/数字化负责人、产品数据或配置管理负责人',
  feigenbaum_qms: '质量负责人、QMS/质量数字化负责人、供应商质量负责人',
  creo: '研发负责人、机械设计负责人、CAD/工程工具负责人',
  catia: '研发负责人、整车或复杂曲面设计负责人、CAD 平台负责人',
  abaqus: '研发负责人、CAE/仿真负责人、结构或材料分析负责人',
  cst: '研发负责人、电磁仿真负责人、射频/天线/EMC 负责人',
  solidworks: '研发负责人、机械设计负责人、CAD/PDM 负责人',
};

const ENTITY_SCOPE_LABELS: Readonly<Record<EvidenceReference['entityScope'], string>> = {
  legal_entity: '法定主体',
  group: '集团',
  subsidiary: '子公司',
  brand: '品牌',
  unknown: '未知',
};

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').replace(/\r?\n/gu, ' ').trim();
}

function escapeInline(value: string): string {
  return cleanText(value).replace(/([\\`*_[\]<>#])/gu, '\\$1');
}

function escapeTableCell(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
    .replace(/\r?\n/gu, '<br>')
    .replace(/([\[\]])/gu, '\\$1')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .trim();
}

function safeHttpUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username !== ''
      || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

function sourceLink(reference: EvidenceReference): string {
  const label = reference.originalPublisher ?? reference.originalDomain ?? reference.title;
  const url = safeHttpUrl(reference.url);
  if (url === null) return `${escapeTableCell(label)}（来源链接不可用）`;
  return `[${escapeTableCell(label)}](<${url}>)`;
}

export function hasDirectLinkCoverageForKeyConclusions(modelInput: ReportModel): boolean {
  const model = ReportModelSchema.parse(modelInput);
  if (model.industryLabel !== null && model.industryEvidenceIds.length === 0) return false;
  const recommendedEvidenceIds = model.recommendedProduct === null
    ? []
    : model.products.find(product => product.product === model.recommendedProduct)?.evidenceIds ?? [];
  const keyEvidenceIds = new Set([
    ...model.industryEvidenceIds,
    ...recommendedEvidenceIds,
    ...model.facts.flatMap(fact => fact.evidenceIds),
    ...(model.latestFinancing?.evidenceIds ?? []),
  ]);
  if (keyEvidenceIds.size === 0) return false;
  const referencesById = new Map(model.evidence.map(reference => [reference.evidenceId, reference]));
  return [...keyEvidenceIds].every(evidenceId => {
    const reference = referencesById.get(evidenceId);
    return reference !== undefined && safeHttpUrl(reference.url) !== null;
  });
}

function formatValues(values: readonly string[], empty = '—'): string {
  return values.length === 0 ? empty : values.map(escapeTableCell).join('；');
}

function financingSummary(model: ReportModel): string {
  if (model.latestFinancing === null) {
    return model.gaps.some(gap => gap.startsWith('融资信息获取失败')) ? '融资信息获取失败' : '未查到或未披露';
  }
  const financing = model.latestFinancing;
  if (financing.summary !== undefined && financing.summary !== null) {
    return escapeInline(financing.summary);
  }
  return [
    financing.occurredAt ?? '日期未披露',
    financing.typeOrRound ?? '类型或轮次未披露',
    financing.disclosedAmount ?? '金额未披露',
    `投资方：${financing.investors.length === 0 ? '未披露' : financing.investors.join('、')}`,
  ].map(escapeInline).join('；');
}

function sourceStatusSection(model: ReportModel): string[] {
  return [
    '## 来源状态',
    '',
    '| 来源 | 状态 |',
    '| --- | --- |',
    `| 企查查 | ${model.sourceStatus.qcc} |`,
    `| 豆包搜索 | ${model.sourceStatus.doubaoSearch} |`,
    `| 火山方舟 | ${model.sourceStatus.ark} |`,
  ];
}

function freshnessHeader(model: ReportModel): string[] {
  const lines = [`> 信息采集时间：${model.collectedAt}`];
  if (model.dynamicSignalFreshness === 'stale') {
    lines.push('>', DYNAMIC_SIGNAL_WARNING);
  }
  return lines;
}

function factSupport(model: ReportModel, fact: EvidenceFact): string {
  const products = model.products
    .filter(product => fact.productTags.includes(product.product)
      && product.evidenceIds.some(evidenceId => fact.evidenceIds.includes(evidenceId)))
    .map(product => `${PRODUCT_LABELS[product.product]}：${product.level}`);
  if (products.length > 0) return products.join('；');
  const purpose: Readonly<Record<EvidenceFact['kind'], string>> = {
    industry: '行业事实',
    product_scene: '产品技术场景事实',
    recruitment: '招聘事实',
    software_ecosystem: '软件生态事实',
    organization: '研发或组织复杂度事实',
    quality: '质量体系事实',
    manufacturing: '制造与供应链事实',
    procurement: '招投标或采购原始事实',
    budget: '预算能力事实',
    decision_power: '决策权事实',
    risk: '风险事实',
  };
  return purpose[fact.kind];
}

function financingStatement(record: FinancingRecord): string {
  if (record.summary !== undefined && record.summary !== null) {
    return `融资记录：${record.summary}`;
  }
  return `融资记录：${[
    record.occurredAt ?? '日期未披露',
    record.typeOrRound ?? '类型或轮次未披露',
    record.disclosedAmount ?? '金额未披露',
    `投资方：${record.investors.length === 0 ? '未披露' : record.investors.join('、')}`,
  ].join('；')}`;
}

function evidenceRow(statement: string, reference: EvidenceReference, support: string): string {
  return `| ${escapeTableCell(statement)} | ${escapeTableCell(reference.mentionedName)} | ${ENTITY_SCOPE_LABELS[reference.entityScope]} | ${reference.entityMatch} | ${formatValues(reference.matchBasis)} | ${sourceLink(reference)} | ${reference.publishedAt ?? reference.collectedAt} | ${escapeTableCell(support)} |`;
}

function evidenceRows(model: ReportModel): string[] {
  const referencesById = new Map(model.evidence.map(reference => [reference.evidenceId, reference]));
  const factEvidenceIds = new Set(model.facts.flatMap(fact => fact.evidenceIds));
  const factRows = model.facts.flatMap(fact => fact.evidenceIds.flatMap(evidenceId => {
    const reference = referencesById.get(evidenceId);
    return reference === undefined ? [] : [evidenceRow(fact.statement, reference, factSupport(model, fact))];
  }));
  const industryRows = model.industryEvidenceIds
    .filter(evidenceId => !factEvidenceIds.has(evidenceId))
    .flatMap(evidenceId => {
      const reference = referencesById.get(evidenceId);
      return reference === undefined
        ? []
        : [evidenceRow(`行业：${model.industryLabel ?? '待核实'}`, reference, '行业依据')];
    });
  const baseRows = [...factRows, ...industryRows];
  const latestFinancing = model.latestFinancing;
  if (latestFinancing === null) return baseRows;
  return [
    ...baseRows,
    ...latestFinancing.evidenceIds.flatMap(evidenceId => {
      const reference = referencesById.get(evidenceId);
      return reference === undefined
        ? []
        : [evidenceRow(financingStatement(latestFinancing), reference, '最近融资概况')];
    }),
  ];
}

const GAP_SECTION_TITLES: Readonly<Record<ReportGapCategory, string>> = {
  rating: '评级缺口',
  enhancement: '增强缺口',
  audit: '审计缺口',
};

const GAP_SECTION_EMPTY_MESSAGES: Readonly<Record<ReportGapCategory, string>> = {
  rating: '暂无影响评级的信息缺口',
  enhancement: '暂无影响高机会条件的信息缺口',
  audit: '暂无来源、链接或容量告警',
};

function layeredGapSections(model: ReportModel): string[] {
  const gaps: Record<ReportGapCategory, string[]> = {
    rating: [],
    enhancement: [],
    audit: [],
  };
  for (const gap of model.gaps) gaps[classifyReportGap(gap)].push(gap);
  return (['rating', 'enhancement', 'audit'] as const).flatMap(category => [
    `## ${GAP_SECTION_TITLES[category]}`,
    '',
    ...(gaps[category].length === 0
      ? [`- ${GAP_SECTION_EMPTY_MESSAGES[category]}`]
      : gaps[category].map(gap => `- ${escapeInline(gap)}`)),
    '',
  ]);
}

function productEvidenceSections(model: ReportModel): string[] {
  const references = new Map(model.evidence.map(reference => [reference.evidenceId, reference]));
  return model.products.flatMap(product => {
    const rule = PRODUCT_RULES.find(rule => rule.product === product.product)!;
    const facts = rankReportFacts(model.facts.filter(fact => fact.strength !== 'weak'
      && (fact.productTags.includes(product.product)
        || (fact.productTags.length === 0
          && fact.evidenceIds.some(id => product.evidenceIds.includes(id))
          && [...rule.positiveKeywords, ...rule.engineeringMethods].some(keyword => containsKeyword(fact.statement, keyword))))), references, model.collectedAt);
    const scenario = facts.filter(fact => ['product_scene', 'recruitment', 'organization', 'quality', 'manufacturing'].includes(fact.kind));
    const ecosystem = facts.filter(fact => fact.kind === 'software_ecosystem');
    const procurement = facts.filter(fact => fact.kind === 'procurement');
    if (scenario.length + ecosystem.length + procurement.length === 0) return [];
    const rows = (label: string, selected: EvidenceFact[]): string[] => selected.slice(0, 2).map(fact => {
      const sources = fact.evidenceIds.flatMap(id => {
        const reference = references.get(id);
        return reference === undefined ? [] : [sourceLink(reference)];
      }).join('、');
      return `- ${label}：${escapeInline(fact.statement)}（${sources}）`;
    });
    return [
      `### ${PRODUCT_LABELS[product.product]}`,
      '',
      ...rows('场景线索', scenario),
      ...rows('已披露软件生态', ecosystem),
      ...rows('采购原始记录（需核实当前阶段）', procurement),
      ...(scenario.some(fact => fact.kind === 'recruitment') ? ['- 招聘要求不等于已部署软件或采购意向。'] : []),
      ...(scenario.length + ecosystem.length + procurement.length === 0 ? ['- 尚无可归属到该产品的具体事实，不能据此断言客户不适合。'] : []),
      ...(procurement.length === 0 ? ['- 未获得该产品的明确采购记录；采购时机需访谈核实。'] : []),
      ...(product.blockers.length === 0 ? [] : [`- 已知阻碍：${formatValues(product.blockers)}`]),
      '',
    ];
  });
}

function renderAssessment(model: ReportModel): string {
  const recommended = model.recommendedProduct === null
    ? null
    : model.products.find(product => product.product === model.recommendedProduct) ?? null;
  const barriers = recommended === null || recommended.blockers.length === 0
    ? '暂未发现已确认的系统壁垒'
    : recommended.blockers.join('；');
  const scaleClues = model.companyScaleClues.length === 0
    ? '未获得可靠规模线索'
    : model.companyScaleClues.join('；');
  const summaryReasons = model.summaryReasons.length === 0 ? '暂无' : model.summaryReasons.join('；');
  const productEvidence = productEvidenceSections(model);
  const salesRecommendationLines = recommended === null
    ? ['- 暂不推荐：当前证据不足以给出产品切入建议。']
    : [
      `- 建议切入产品：${PRODUCT_LABELS[recommended.product]}`,
      `- 建议联系岗位：${TARGET_ROLES[recommended.product]}`,
      `- 主要系统壁垒：${escapeInline(barriers)}`,
    ];

  return [
    '# 目标客户体检报告',
    '',
    ...freshnessHeader(model),
    '',
    '## 客户摘要',
    '',
    `- 法定主体：${escapeInline(model.legalName)}`,
    `- 行业：${model.industryLabel === null ? '待核实' : escapeInline(model.industryLabel)}`,
    `- 企业规模线索：${escapeInline(scaleClues)}`,
    `- 最近融资：${financingSummary(model)}`,
    `- 最佳切入产品：${recommended === null ? '暂不推荐' : PRODUCT_LABELS[recommended.product]}`,
    `- 综合机会：${model.overallOpportunity}`,
    `- 核心判断理由：${escapeInline(summaryReasons)}`,
    '',
    '## 七项产品机会',
    '',
    '| 产品 | 机会 | 置信度 | 依据 | 阻碍/缺口 |',
    '| --- | --- | --- | --- | --- |',
    ...model.products.map(product => `| ${PRODUCT_LABELS[product.product]} | ${product.level} | ${product.confidence} | ${formatValues(product.reasons)} | ${formatValues([...product.blockers, ...product.gaps])} |`),
    '',
    ...(productEvidence.length === 0 ? [] : ['## 产品切入依据', '', ...productEvidence]),
    '## 关键证据',
    '',
    '| 事实 | 提及主体 | 归属 | 匹配 | 匹配依据 | 来源 | 时间 | 支持结论 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...evidenceRows(model),
    '',
    '## 销售建议',
    '',
    ...salesRecommendationLines,
    ...(model.salesQuestions.length === 0 ? [] : [
      '- 首轮访谈问题（用于核实，不代表已确认需求）：',
      ...model.salesQuestions.map(question => `  - ${escapeInline(question)}`),
    ]),
    '- 下一步行动：',
    ...model.nextVerificationActions.map(action => `  - ${escapeInline(action)}`),
    '',
    '## 风险',
    '',
    ...(model.risks.length === 0 ? ['- 暂无已确认风险'] : model.risks.map(risk => `- ${escapeInline(risk)}`)),
    '',
    ...layeredGapSections(model),
    ...sourceStatusSection(model),
  ].join('\n');
}

export function renderMarkdown(modelInput: ReportModel): string {
  const model = ReportModelSchema.parse(modelInput);
  return renderAssessment(model);
}

export type StoredReportPresentation = Readonly<{
  markdown: string;
  dynamicSignalFreshness: ReportModel['dynamicSignalFreshness'];
}>;

function withoutDynamicSignalWarning(markdown: string): string {
  const output: string[] = [];
  for (const line of markdown.split('\n')) {
    if (line === DYNAMIC_SIGNAL_WARNING) {
      if (output.at(-1) === '>') output.pop();
      continue;
    }
    output.push(line);
  }
  return output.join('\n');
}

function withDynamicSignalWarning(markdown: string): string {
  const lines = withoutDynamicSignalWarning(markdown).split('\n');
  const collectedAtLine = lines.findIndex(line => line.startsWith('> 信息采集时间：'));
  if (collectedAtLine >= 0) lines.splice(collectedAtLine + 1, 0, '>', DYNAMIC_SIGNAL_WARNING);
  else lines.unshift(DYNAMIC_SIGNAL_WARNING, '');
  return lines.join('\n');
}

export function presentStoredReport(
  markdown: string,
  completedAtInput: string,
  now: Date,
): StoredReportPresentation {
  const completedAt = UtcTimestampSchema.parse(completedAtInput);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('now must be a valid Date');
  const dynamicSignalFreshness = nowMs - Date.parse(completedAt) > SEVEN_DAYS_MS ? 'stale' : 'current';
  return {
    markdown: dynamicSignalFreshness === 'stale'
      ? withDynamicSignalWarning(markdown)
      : withoutDynamicSignalWarning(markdown),
    dynamicSignalFreshness,
  };
}
