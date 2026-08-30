import {
  ReportModelSchema,
  UtcTimestampSchema,
  type EvidenceFact,
  type EvidenceReference,
  type FinancingRecord,
  type ProductKey,
  type ReportModel,
} from '../contracts/index.js';

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
    const normalizedPath = url.pathname.replace(/\/+$/u, '') || '/';
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username !== ''
      || url.password !== ''
      || (url.origin === 'https://agent.qcc.com' && normalizedPath === '/data')) return null;
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
  if (model.industryClassification !== 'unverified' && model.industryEvidenceIds.length === 0) return false;
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
    return model.gaps.includes('融资信息获取失败') ? '融资信息获取失败' : '未查到或未披露';
  }
  const financing = model.latestFinancing;
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
    industry: '行业分类事实',
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
        : [evidenceRow(`行业分类：${model.industryClassification}`, reference, '行业分类依据')];
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

function renderDegraded(model: ReportModel): string {
  const gaps = model.gaps.length === 0 ? ['证据不足，无法形成销售判断'] : model.gaps;
  const actions = model.nextVerificationActions.length === 0
    ? ['补充可归属于法定主体的产品技术场景证据']
    : model.nextVerificationActions;
  return [
    '# 目标客户体检报告',
    '',
    ...freshnessHeader(model),
    '',
    '## 证据缺口',
    '',
    ...gaps.map(gap => `- ${escapeInline(gap)}`),
    '',
    ...sourceStatusSection(model),
    '',
    '## 下一步核实',
    '',
    ...actions.map(action => `- ${escapeInline(action)}`),
  ].join('\n');
}

function renderNormal(model: ReportModel): string {
  const recommendedProduct = model.recommendedProduct!;
  const recommended = model.products.find(product => product.product === recommendedProduct)!;
  const barriers = recommended.blockers.length === 0
    ? '暂未发现已确认的系统壁垒'
    : recommended.blockers.join('；');
  const scaleClues = model.companyScaleClues.length === 0
    ? '未获得可靠规模线索'
    : model.companyScaleClues.join('；');
  const summaryReasons = model.summaryReasons.length === 0 ? '暂无' : model.summaryReasons.join('；');
  const riskAndGapLines = [
    ...model.risks.map(risk => `- 风险：${escapeInline(risk)}`),
    ...model.gaps.map(gap => `- 缺口：${escapeInline(gap)}`),
  ];

  return [
    '# 目标客户体检报告',
    '',
    ...freshnessHeader(model),
    '',
    '## 客户摘要',
    '',
    `- 法定主体：${escapeInline(model.legalName)}`,
    `- 行业优先级：${model.industryClassification}`,
    `- 企业规模线索：${escapeInline(scaleClues)}`,
    `- 最近融资：${financingSummary(model)}`,
    `- 最佳切入产品：${PRODUCT_LABELS[recommendedProduct]}`,
    `- 综合机会：${model.overallOpportunity}`,
    `- 核心判断理由：${escapeInline(summaryReasons)}`,
    '',
    '## 七项产品机会',
    '',
    '| 产品 | 机会 | 依据 | 阻碍/缺口 |',
    '| --- | --- | --- | --- |',
    ...model.products.map(product => `| ${PRODUCT_LABELS[product.product]} | ${product.level} | ${formatValues(product.reasons)} | ${formatValues([...product.blockers, ...product.gaps])} |`),
    '',
    '## 关键证据',
    '',
    '| 事实 | 提及主体 | 归属 | 匹配 | 匹配依据 | 来源 | 时间 | 支持结论 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...evidenceRows(model),
    '',
    '## 销售建议',
    '',
    `- 建议切入产品：${PRODUCT_LABELS[recommendedProduct]}`,
    `- 建议联系岗位：${TARGET_ROLES[recommendedProduct]}`,
    '- 首轮访谈问题：',
    ...model.salesQuestions.map(question => `  - ${escapeInline(question)}`),
    `- 主要系统壁垒：${escapeInline(barriers)}`,
    '- 下一步行动：',
    ...model.nextVerificationActions.map(action => `  - ${escapeInline(action)}`),
    '',
    '## 风险与缺口',
    '',
    ...(riskAndGapLines.length === 0 ? ['- 暂无已确认风险或关键缺口'] : riskAndGapLines),
    '',
    ...sourceStatusSection(model),
  ].join('\n');
}

export function renderMarkdown(modelInput: ReportModel): string {
  const model = ReportModelSchema.parse(modelInput);
  return model.recommendedProduct === null ? renderDegraded(model) : renderNormal(model);
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
