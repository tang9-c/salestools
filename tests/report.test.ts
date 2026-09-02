import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProductKeySchema,
  qccUnavailableLinkAuditGap,
  ReportModelSchema,
  type EvidenceBundle,
  type EvidenceFact,
  type EvidenceReference,
  type IdentityProfile,
  type OpportunityAssessment,
  type ProductKey,
  type ReportModel,
} from '../src/contracts/index.js';
import { buildReportModel } from '../src/report/build-report-model.js';
import {
  classifyReportGap,
  hasDirectLinkCoverageForKeyConclusions,
  presentStoredReport,
  renderMarkdown,
} from '../src/report/render-markdown.js';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const COLLECTED_AT = '2026-08-29T12:00:00.000Z';

const identity: IdentityProfile = {
  legalName: '测试智能装备有限公司',
  creditCode: '91310000TEST000001',
  formerNames: [],
  aliases: ['测试智能装备'],
  englishNames: [],
  brands: [],
  officialDomains: ['company.example'],
  registeredAddress: '上海市测试区一号路',
  parentLegalName: null,
  subsidiaryLegalNames: [],
};

function reference(
  evidenceId: string,
  options: Partial<EvidenceReference> = {},
): EvidenceReference {
  return {
    evidenceId,
    title: `证据 ${evidenceId}`,
    url: `https://company.example/${evidenceId}`,
    originalPublisher: '测试公司官网',
    originalDomain: 'company.example',
    publishedAt: '2026-08-20T12:00:00.000Z',
    collectedAt: COLLECTED_AT,
    mentionedName: identity.legalName,
    entityScope: 'legal_entity',
    entityMatch: 'confirmed',
    matchBasis: ['官网域名与法定全称一致'],
    ...options,
  };
}

function fact(
  factId: string,
  statement: string,
  kind: EvidenceFact['kind'],
  evidenceIds: string[],
  productTags: ProductKey[] = [],
): EvidenceFact {
  return {
    factId,
    statement,
    kind,
    productTags,
    strength: 'direct',
    evidenceIds,
    entityScope: 'legal_entity',
    entityMatch: 'confirmed',
    matchBasis: ['官网域名与法定全称一致'],
  };
}

function evidenceBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  const evidence = [
    reference('industry', { title: '公司产品与行业介绍' }),
    reference('recruitment', {
      title: 'PLM 管理员招聘',
      url: 'https://jobs.example/plm-role',
      originalPublisher: '招聘平台',
      originalDomain: 'jobs.example',
    }),
    reference('financing', {
      title: 'A 轮融资公告',
      url: 'https://exchange.example/financing',
      originalPublisher: '交易中心',
      originalDomain: 'exchange.example',
    }),
    reference('risk', {
      title: '经营风险扫描',
      url: 'https://qcc.example/risk',
      originalPublisher: '企查查',
      originalDomain: 'qcc.example',
    }),
  ];
  return {
    identity,
    industryLabel: '工业自动化装备',
    industryEvidenceIds: ['industry'],
    evidence,
    facts: [
      fact('scene', '招聘 Windchill PLM 管理员负责 BOM 变更', 'recruitment', ['recruitment'], ['windchill']),
      fact('scale', '研发组织覆盖机械、电子与软件团队', 'organization', ['industry'], ['windchill']),
      fact('risk', '存在一项经营风险，需在接触前复核', 'risk', ['risk']),
    ],
    financingRecords: [{
      occurredAt: '2026-08-10T12:00:00.000Z',
      typeOrRound: 'A 轮',
      disclosedAmount: '1 亿元',
      investors: ['测试基金'],
      evidenceIds: ['financing'],
    }],
    conflicts: ['集团采购边界尚未确认'],
    gaps: ['现有 PLM 版本待核实'],
    collectedAt: COLLECTED_AT,
    ...overrides,
  };
}

function assessment(recommendedProduct: ProductKey | null = 'windchill'): OpportunityAssessment {
  const products = ProductKeySchema.options.map(product => ({
    product,
    level: recommendedProduct === null
      ? '待核实' as const
      : product === 'windchill' ? '高' as const : '低' as const,
    evidenceIds: recommendedProduct === null
      ? []
      : product === 'windchill' ? ['recruitment', 'industry'] : ['industry'],
    reasons: recommendedProduct !== null && product === 'windchill'
      ? ['已确认产品场景', '近期招聘信号明确']
      : [],
    blockers: recommendedProduct !== null && product === 'creo' ? ['已发现现有 CAD 生态'] : [],
    gaps: recommendedProduct === null
      ? ['证据不足，无法形成稳定判断']
      : product === 'windchill' ? ['预算能力待核实'] : ['未发现具体产品场景'],
  }));
  return {
    products,
    overallOpportunity: recommendedProduct === null ? '待核实' : '高',
    recommendedProduct,
    summaryReasons: recommendedProduct === null
      ? ['未获得足够的可归属证据']
      : ['已确认产品场景', '近期招聘信号明确'],
  };
}

const sourceStatus: ReportModel['sourceStatus'] = {
  qcc: 'partial',
  doubaoSearch: 'failed',
  ark: 'completed',
};

describe('assessment report', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  it('builds and snapshots a normal auditable report without unsupported inferences', () => {
    const model = buildReportModel(identity, evidenceBundle(), assessment(), sourceStatus);
    const markdown = renderMarkdown(model);

    expect(ReportModelSchema.parse(model)).toEqual(model);
    expect(model).not.toHaveProperty('financingStatus');
    expect(model.latestFinancing).toMatchObject({ typeOrRound: 'A 轮', disclosedAmount: '1 亿元' });
    expect(model.products).toHaveLength(7);
    expect(model.facts.map(fact => fact.factId)).toEqual(['scene', 'scale', 'risk']);
    expect(markdown).toContain('[招聘平台](<https://jobs.example/plm-role>)');
    expect(markdown).toContain('2026-08-20T12:00:00.000Z');
    expect(markdown).toContain('官网域名与法定全称一致');
    expect(markdown).toContain('豆包搜索 | failed');
    expect(markdown).not.toContain('Feigenbaum QMS：低');
    expect(markdown).not.toMatch(/真实营收|决策保守|一定有采购意向|cache_hit|cached_at/);
    expect(markdown).toMatchInlineSnapshot(`
      "# 目标客户体检报告

      > 信息采集时间：2026-08-29T12:00:00.000Z

      ## 客户摘要

      - 法定主体：测试智能装备有限公司
      - 行业：工业自动化装备
      - 企业规模线索：研发组织覆盖机械、电子与软件团队
      - 最近融资：2026-08-10T12:00:00.000Z；A 轮；1 亿元；投资方：测试基金
      - 最佳切入产品：PTC Windchill
      - 综合机会：高
      - 核心判断理由：已确认产品场景；近期招聘信号明确

      ## 七项产品机会

      | 产品 | 机会 | 依据 | 阻碍/缺口 |
      | --- | --- | --- | --- |
      | PTC Windchill | 高 | 已确认产品场景；近期招聘信号明确 | 预算能力待核实 |
      | Feigenbaum QMS | 低 | — | 未发现具体产品场景 |
      | PTC Creo | 低 | — | 已发现现有 CAD 生态；未发现具体产品场景 |
      | Dassault Systèmes CATIA | 低 | — | 未发现具体产品场景 |
      | Dassault Systèmes Abaqus | 低 | — | 未发现具体产品场景 |
      | CST Studio Suite | 低 | — | 未发现具体产品场景 |
      | Dassault Systèmes SolidWorks | 低 | — | 未发现具体产品场景 |

      ## 关键证据

      | 事实 | 提及主体 | 归属 | 匹配 | 匹配依据 | 来源 | 时间 | 支持结论 |
      | --- | --- | --- | --- | --- | --- | --- | --- |
      | 招聘 Windchill PLM 管理员负责 BOM 变更 | 测试智能装备有限公司 | 法定主体 | confirmed | 官网域名与法定全称一致 | [招聘平台](<https://jobs.example/plm-role>) | 2026-08-20T12:00:00.000Z | PTC Windchill：高 |
      | 研发组织覆盖机械、电子与软件团队 | 测试智能装备有限公司 | 法定主体 | confirmed | 官网域名与法定全称一致 | [测试公司官网](<https://company.example/industry>) | 2026-08-20T12:00:00.000Z | PTC Windchill：高 |
      | 存在一项经营风险，需在接触前复核 | 测试智能装备有限公司 | 法定主体 | confirmed | 官网域名与法定全称一致 | [企查查](<https://qcc.example/risk>) | 2026-08-20T12:00:00.000Z | 风险事实 |
      | 融资记录：2026-08-10T12:00:00.000Z；A 轮；1 亿元；投资方：测试基金 | 测试智能装备有限公司 | 法定主体 | confirmed | 官网域名与法定全称一致 | [交易中心](<https://exchange.example/financing>) | 2026-08-20T12:00:00.000Z | 最近融资概况 |

      ## 销售建议

      - 建议切入产品：PTC Windchill
      - 建议联系岗位：研发负责人、PLM/数字化负责人、产品数据或配置管理负责人
      - 首轮访谈问题：
        - 当前 BOM、工程变更和配置管理分别由哪些系统或表格承载？
        - 研发、制造和质量团队之间如何同步产品数据与版本？
        - 当前系统的扩容、替换或集成计划由谁负责，预算和决策流程是什么？
      - 主要系统壁垒：暂未发现已确认的系统壁垒
      - 下一步行动：
        - 核实现有 PLM 版本待核实
        - 核实集团采购边界尚未确认
        - 核实预算能力待核实

      ## 风险

      - 存在一项经营风险，需在接触前复核

      ## 评级缺口

      - 现有 PLM 版本待核实
      - 集团采购边界尚未确认

      ## 增强缺口

      - 预算能力待核实

      ## 审计缺口

      - 暂无来源、链接或容量告警

      ## 来源状态

      | 来源 | 状态 |
      | --- | --- |
      | 企查查 | partial |
      | 豆包搜索 | failed |
      | 火山方舟 | completed |"
    `);
  });

  it('renders financing failure as an existing gap without inventing a financing status', () => {
    const input = evidenceBundle({
      financingRecords: [],
      gaps: ['融资信息获取失败'],
    });
    const model = buildReportModel(identity, input, assessment(), sourceStatus);
    const markdown = renderMarkdown(model);

    expect(model.latestFinancing).toBeNull();
    expect(model.sourceStatus.qcc).toBe('partial');
    expect(model).not.toHaveProperty('financingStatus');
    expect(markdown).toContain('- 最近融资：融资信息获取失败');
    expect(markdown).toContain('## 审计缺口');
    expect(markdown).toContain('- 融资信息获取失败');
  });

  it('renders an LLM financing summary when precise fields are unavailable', () => {
    const input = evidenceBundle({
      financingRecords: [{
        occurredAt: null,
        typeOrRound: null,
        disclosedAmount: null,
        investors: [],
        summary: '公司曾完成战略融资并引入产业投资者，具体轮次和金额未披露。',
        evidenceIds: ['financing'],
      }],
    });
    const markdown = renderMarkdown(buildReportModel(identity, input, assessment(), sourceStatus));

    expect(markdown).toContain('- 最近融资：公司曾完成战略融资并引入产业投资者，具体轮次和金额未披露。');
    expect(markdown).toContain('| 融资记录：公司曾完成战略融资并引入产业投资者，具体轮次和金额未披露。 |');
    expect(markdown).not.toContain('日期未披露；类型或轮次未披露；金额未披露');
  });

  it('renders the full assessment with layered gaps when no product is recommended', () => {
    const model = buildReportModel(
      identity,
      evidenceBundle({
        industryLabel: null,
        industryEvidenceIds: [],
        evidence: [reference('industry', { title: '企业官网简介' })],
        facts: [fact('industry-fact', '企业行业和产品技术场景仍待核实', 'industry', ['industry'])],
        financingRecords: [],
        conflicts: ['主体归属存在冲突，需核实'],
        gaps: ['预算能力待核实', '企查查来源链接不可用：industry'],
      }),
      assessment(null),
      { qcc: 'failed', doubaoSearch: 'failed', ark: 'completed' },
    );
    const markdown = renderMarkdown(model);

    expect(markdown).toContain('## 客户摘要');
    expect(markdown).toContain('- 行业：待核实');
    expect(markdown).toContain('- 最佳切入产品：暂不推荐');
    for (const product of [
      'PTC Windchill',
      'Feigenbaum QMS',
      'PTC Creo',
      'Dassault Systèmes CATIA',
      'Dassault Systèmes Abaqus',
      'CST Studio Suite',
      'Dassault Systèmes SolidWorks',
    ]) expect(markdown).toContain(product);
    expect(markdown).toContain('## 关键证据');
    expect(markdown).toContain('企业行业和产品技术场景仍待核实');
    expect(markdown).toContain('## 评级缺口');
    expect(markdown).toContain('## 增强缺口');
    expect(markdown).toContain('## 审计缺口');
    expect(markdown).toContain('- 暂不推荐：当前证据不足以给出产品切入建议。');
    expect(markdown).not.toContain('建议联系岗位');
    expect(markdown).not.toContain('首轮访谈问题');
    expect(model.products.every(product => product.level === '待核实')).toBe(true);
  });

  it.each([
    ['行业和产品技术场景待核实', 'rating'],
    ['预算审批时间为 2026/09，待核实', 'enhancement'],
    ['决策权待核实', 'enhancement'],
    ['方舟输入容量已裁剪：6/12', 'audit'],
    ['近期融资情况待核实', 'enhancement'],
    ['融资信息获取失败', 'audit'],
    ['融资结果无法结构化验证（适配器契约缺口）', 'audit'],
    ['年报信息获取失败', 'audit'],
  ] as const)('classifies %s as %s for presentation only', (gap, category) => {
    expect(classifyReportGap(gap)).toBe(category);
  });

  it('rejects identity mismatches and every dangling evidence reference', () => {
    expect(() => buildReportModel(
      { ...identity, legalName: '另一个主体有限公司' },
      evidenceBundle(),
      assessment(),
      sourceStatus,
    )).toThrow(/identity/i);

    const dangling = assessment();
    dangling.products[0]!.evidenceIds.push('invented-evidence');
    expect(() => buildReportModel(identity, evidenceBundle(), dangling, sourceStatus))
      .toThrow(/invented-evidence/);
  });

  it('does not promote group or unverified references into target scale, risk or financing facts', () => {
    const groupReference = reference('group-only', {
      entityScope: 'group',
      entityMatch: 'probable',
      mentionedName: '测试集团',
      matchBasis: ['仅集团名称一致'],
    });
    const input = evidenceBundle({
      industryEvidenceIds: ['group-only'],
      evidence: [groupReference],
      facts: [
        fact('group-scale', '集团拥有万人研发组织', 'organization', ['group-only']),
        fact('group-risk', '集团存在重大经营风险', 'risk', ['group-only']),
      ],
      financingRecords: [{
        occurredAt: '2026-08-10T12:00:00.000Z',
        typeOrRound: '集团战略融资',
        disclosedAmount: '10 亿元',
        investors: ['集团投资方'],
        evidenceIds: ['group-only'],
      }],
      conflicts: [],
      gaps: ['集团证据不能自动归属于目标主体'],
    });
    const result = assessment();
    result.products = result.products.map(row => ({ ...row, evidenceIds: ['group-only'] }));

    const model = buildReportModel(identity, input, result, sourceStatus);

    expect(model.companyScaleClues).toEqual([]);
    expect(model.risks).toEqual([]);
    expect(model.facts).toEqual([]);
    expect(model.latestFinancing).toBeNull();
  });

  it('keeps weak but attributed facts in the audit chain without promoting them into the summary', () => {
    const weakFact = fact('weak-role', '招聘普通研发工程师', 'recruitment', ['industry']);
    weakFact.strength = 'weak';
    const input = evidenceBundle({
      facts: [weakFact],
      financingRecords: [],
      conflicts: [],
      gaps: [],
    });

    const model = buildReportModel(identity, input, assessment(), sourceStatus);

    expect(model.facts.map(item => item.factId)).toContain('weak-role');
    expect(model.companyScaleClues).not.toContain(weakFact.statement);
  });

  it('escapes unsafe table labels and content without emitting executable markup', () => {
    const unsafe = reference('unsafe', {
      title: '官网 | 标题\n第二行<script>alert(1)</script>',
      url: 'https://company.example/unsafe',
      originalPublisher: '来源 | 名称<img src=x>',
      originalDomain: null,
    });
    const input = evidenceBundle({
      industryEvidenceIds: ['unsafe'],
      evidence: [unsafe],
      facts: [fact(
        'unsafe-fact',
        '官网 | 标题\n第二行<script>alert(1)</script>',
        'industry',
        ['unsafe'],
        ['windchill'],
      )],
      financingRecords: [],
      conflicts: [],
      gaps: [],
    });
    const result = assessment();
    result.products = result.products.map(row => ({ ...row, evidenceIds: ['unsafe'] }));
    const markdown = renderMarkdown(buildReportModel(identity, input, result, sourceStatus));

    expect(markdown).toContain('官网 \\| 标题<br>第二行&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markdown).toContain('[来源 \\| 名称&lt;img src=x&gt;](<https://company.example/unsafe>)');
    expect(markdown).not.toMatch(/<script>|<img/);
  });

  it('renders unavailable QCC links explicitly and does not count them as conclusion link coverage', () => {
    const qccOnly = {
      ...reference('qcc-only'),
      url: null,
      originalPublisher: null,
      originalDomain: null,
    } as unknown as EvidenceReference;
    const input = evidenceBundle({
      industryEvidenceIds: ['qcc-only'],
      evidence: [qccOnly],
      facts: [fact(
        'qcc-scene',
        '企查查记录显示研发组织设有 PLM 管理岗位',
        'organization',
        ['qcc-only'],
        ['windchill'],
      )],
      financingRecords: [],
      conflicts: [],
      gaps: [qccUnavailableLinkAuditGap('qcc-only')],
    });
    const result = assessment();
    result.products = result.products.map(row => ({ ...row, evidenceIds: ['qcc-only'] }));
    const model = buildReportModel(identity, input, result, sourceStatus);
    const markdown = renderMarkdown(model);

    expect(markdown).toContain('来源链接不可用');
    expect(markdown).not.toContain('https://agent.qcc.com/data');
    expect(hasDirectLinkCoverageForKeyConclusions(model)).toBe(false);
  });

  it('aggregates per-evidence QCC link gaps and excludes audit gaps from sales actions', () => {
    const auditGaps = Array.from({ length: 200 }, (_, index) => (
      qccUnavailableLinkAuditGap(`qcc-${index + 1}`)
    ));
    const input = evidenceBundle({
      gaps: [...auditGaps, '预算能力待核实'],
    });
    const originalGaps = [...input.gaps];

    const model = buildReportModel(identity, input, assessment(), sourceStatus);
    const markdown = renderMarkdown(model);

    expect(input.gaps).toEqual(originalGaps);
    expect(model.gaps.filter(gap => gap.includes('企查查有 200 条证据未提供直接来源链接')))
      .toHaveLength(1);
    expect(model.gaps.some(gap => gap.startsWith('企查查来源链接不可用：'))).toBe(false);
    expect(model.nextVerificationActions).toContain('核实预算能力待核实');
    expect(model.nextVerificationActions.join('\n')).not.toContain('200 条证据');
    expect(markdown.match(/企查查有 200 条证据未提供直接来源链接/gu)).toHaveLength(1);
  });

  it('does not require an industry link when the industry label is unverified', () => {
    const model = buildReportModel(identity, evidenceBundle(), assessment(), sourceStatus);
    expect(hasDirectLinkCoverageForKeyConclusions(model)).toBe(true);
    expect(hasDirectLinkCoverageForKeyConclusions({
      ...model,
      industryLabel: null,
      industryEvidenceIds: [],
    })).toBe(true);
  });

  it('requires a direct link for the industry label even when product evidence has one', () => {
    const industryWithoutLink = reference('industry-without-link', {
      url: null,
      originalPublisher: null,
      originalDomain: null,
      title: 'QCC 行业标签依据',
    });
    const productWithLink = reference('product-with-link', {
      url: 'https://jobs.example/windchill-role',
      originalPublisher: '招聘官网',
      originalDomain: 'jobs.example',
    });
    const input = evidenceBundle({
      industryEvidenceIds: ['industry-without-link'],
      evidence: [industryWithoutLink, productWithLink],
      facts: [fact(
        'direct-product-scene',
        '招聘 Windchill 管理员负责 BOM 与工程变更',
        'recruitment',
        ['product-with-link'],
        ['windchill'],
      )],
      financingRecords: [],
      conflicts: [],
      gaps: [qccUnavailableLinkAuditGap('industry-without-link')],
    });
    const result = assessment();
    result.products = result.products.map(row => ({
      ...row,
      evidenceIds: row.product === 'windchill' ? ['product-with-link'] : [],
    }));

    const model = buildReportModel(identity, input, result, sourceStatus);
    const markdown = renderMarkdown(model);

    expect(model.industryEvidenceIds).toEqual(['industry-without-link']);
    expect(markdown).toContain('行业：工业自动化装备');
    expect(markdown).toContain('QCC 行业标签依据（来源链接不可用）');
    expect(hasDirectLinkCoverageForKeyConclusions(model)).toBe(false);
  });

  it('presents stored markdown by completed_at without persisting a ReportModel', () => {
    const generated = renderMarkdown(buildReportModel(identity, evidenceBundle(), assessment(), sourceStatus));
    const completedAt = '2026-08-20T12:00:00.000Z';

    const exactSevenDays = presentStoredReport(generated, completedAt, new Date('2026-08-27T12:00:00.000Z'));
    expect(exactSevenDays.dynamicSignalFreshness).toBe('current');
    expect(exactSevenDays.markdown).not.toContain('动态信号已超过 7 天');

    const eighthDay = presentStoredReport(generated, completedAt, new Date('2026-08-28T12:00:00.000Z'));
    expect(eighthDay.dynamicSignalFreshness).toBe('stale');
    expect(eighthDay.markdown.match(/动态信号已超过 7 天/gu)).toHaveLength(1);

    const normalized = presentStoredReport(eighthDay.markdown, completedAt, new Date('2026-08-29T12:00:00.000Z'));
    expect(normalized.markdown.match(/动态信号已超过 7 天/gu)).toHaveLength(1);
  });

  it('warns when dynamic signals are older than seven days and never exposes cache metadata', () => {
    const model = buildReportModel(
      identity,
      evidenceBundle({ collectedAt: '2026-08-20T11:59:59.999Z' }),
      assessment(),
      sourceStatus,
    );
    const markdown = renderMarkdown(model);

    expect(model.dynamicSignalFreshness).toBe('stale');
    expect(markdown).toContain('动态信号已超过 7 天');
    expect(JSON.stringify(model)).not.toMatch(/cache_hit|cached_at|cacheHit|cachedAt/);
    expect(markdown).not.toMatch(/cache_hit|cached_at|cacheHit|cachedAt/);
  });
});
