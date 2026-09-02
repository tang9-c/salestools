import { describe, expect, it } from 'vitest';
import {
  ProductKeySchema,
  type EvidenceBundle,
  type EvidenceFact,
  type EvidenceReference,
  type ProductKey,
} from '../src/contracts/index.js';
import { evaluateOpportunities } from '../src/opportunity/evaluate-all.js';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const RECENT = '2026-08-01T12:00:00.000Z';
const identity = {
  legalName: '测试制造有限公司',
  creditCode: '91310000TEST000001',
  formerNames: [], aliases: ['测试制造'], englishNames: [], brands: [],
  officialDomains: ['company.example'], registeredAddress: null,
  parentLegalName: null, subsidiaryLegalNames: [],
};

const cases: ReadonlyArray<{
  product: ProductKey;
  named: string;
  method: string;
  complexityKind: EvidenceFact['kind'];
  complexity: string;
}> = [
  { product: 'windchill', named: 'Windchill PLM 管理员', method: 'BOM 变更和配置管理', complexityKind: 'organization', complexity: '多部门研发使用 EBOM/MBOM 协同' },
  { product: 'feigenbaum_qms', named: 'Feigenbaum QMS 实施顾问', method: 'CAPA 和质量追溯', complexityKind: 'quality', complexity: 'IATF 16949 体系与供应商质量审计' },
  { product: 'creo', named: 'Creo 机械设计工程师', method: '参数化机械设计', complexityKind: 'organization', complexity: '研发团队负责复杂零部件工程变更' },
  { product: 'catia', named: 'CATIA 设计工程师', method: '复杂曲面与大型装配', complexityKind: 'manufacturing', complexity: '整车大型装配和复杂曲面设计' },
  { product: 'abaqus', named: 'Abaqus 仿真工程师', method: '有限元非线性分析', complexityKind: 'organization', complexity: '材料疲劳与碰撞仿真研发团队' },
  { product: 'cst', named: 'CST Studio Suite 电磁仿真工程师', method: '射频天线 EMC/EMI 电磁仿真', complexityKind: 'organization', complexity: '雷达微波与天线研发团队' },
  { product: 'solidworks', named: 'SolidWorks 机械设计工程师', method: '通用设备三维建模', complexityKind: 'manufacturing', complexity: '多型号非标设备设计与 PDM 协同' },
];

function reference(id: string, domain: string, publishedAt: string | null = RECENT,
  entityMatch: EvidenceReference['entityMatch'] = 'confirmed'): EvidenceReference {
  return {
    evidenceId: id, title: `证据 ${id}`, url: `https://${domain}/${id}`,
    originalPublisher: domain, originalDomain: domain, publishedAt,
    collectedAt: NOW.toISOString(), mentionedName: identity.legalName,
    entityScope: entityMatch === 'unverified' ? 'unknown' : 'legal_entity', entityMatch,
    matchBasis: [entityMatch === 'unverified' ? '仅提及简称' : '官方域名与全称一致'],
  };
}

function fact(
  id: string,
  product: ProductKey,
  statement: string,
  kind: EvidenceFact['kind'],
  evidenceIds: string[],
  options: Partial<Pick<EvidenceFact, 'strength' | 'entityMatch' | 'entityScope'>> = {},
): EvidenceFact {
  return {
    factId: id, statement, kind, productTags: [product],
    strength: options.strength ?? 'direct', evidenceIds,
    entityScope: options.entityScope ?? 'legal_entity',
    entityMatch: options.entityMatch ?? 'confirmed',
    matchBasis: ['官方域名与全称一致'],
  };
}

function bundle(options: {
  product?: ProductKey;
  evidence?: EvidenceReference[];
  facts?: EvidenceFact[];
  financing?: EvidenceBundle['financingRecords'];
  industryLabel?: string | null;
  conflicts?: string[];
} = {}): EvidenceBundle {
  const evidence = options.evidence ?? [];
  const industryLabel = options.industryLabel === undefined
    ? (evidence.length === 0 ? null : '工业自动化装备')
    : options.industryLabel;
  return {
    identity,
    industryLabel,
    industryEvidenceIds: industryLabel === null ? [] : [evidence[0]!.evidenceId],
    evidence,
    facts: options.facts ?? [],
    financingRecords: options.financing ?? [],
    conflicts: options.conflicts ?? [], gaps: [], collectedAt: NOW.toISOString(),
  };
}

function completeHighCase(entry: typeof cases[number]): EvidenceBundle {
  const refs = [
    reference('recruitment', 'jobs.company.example'),
    reference('complexity', 'industry-association.example'),
    reference('decision', 'company.example'),
    reference('financing', 'exchange.example'),
  ];
  return bundle({
    evidence: refs,
    facts: [
      fact('scene', entry.product, `${entry.named}，${entry.method}`, 'recruitment', ['recruitment']),
      fact('complexity', entry.product, entry.complexity, entry.complexityKind, ['complexity']),
      fact('decision', entry.product, '目标法定主体具有独立采购决策权', 'decision_power', ['decision']),
    ],
    financing: [{
      occurredAt: RECENT, typeOrRound: 'A 轮', disclosedAmount: '1 亿元',
      investors: ['测试基金'], evidenceIds: ['financing'],
    }],
  });
}

describe('evaluateOpportunities', () => {
  it.each(cases)('$product: two independent publishers, complexity, recent timing and budget produce 高', entry => {
    const result = evaluateOpportunities(completeHighCase(entry), NOW);
    expect(result.products.find(row => row.product === entry.product)?.level).toBe('高');
  });

  it.each(cases)('$product: financing strengthens an existing complete scene but never creates one', entry => {
    const withFinancing = completeHighCase(entry);
    const withoutFinancing = { ...withFinancing, financingRecords: [] };
    expect(evaluateOpportunities(withoutFinancing, NOW).products
      .find(row => row.product === entry.product)?.level).toBe('中');
    expect(evaluateOpportunities(withFinancing, NOW).products
      .find(row => row.product === entry.product)?.level).toBe('高');

    const financingOnly = bundle({ evidence: withFinancing.evidence, financing: withFinancing.financingRecords });
    expect(evaluateOpportunities(financingOnly, NOW).products
      .find(row => row.product === entry.product)?.level).toBe('低');
  });

  it.each(cases)('$product: duplicate repost domains count once and cannot pass the high threshold', entry => {
    const input = completeHighCase(entry);
    input.evidence = input.evidence.map(item => ({
      ...item,
      originalPublisher: '同一发布方',
      originalDomain: 'same-publisher.example',
    }));
    expect(evaluateOpportunities(input, NOW).products
      .find(row => row.product === entry.product)?.level).toBe('中');
  });

  it.each(cases)('$product: a direct product_scene tag without a keyword or method cannot establish the scene', entry => {
    const refs = [reference('tag-only', 'company.example'), reference('complexity-only', 'association.example')];
    const result = evaluateOpportunities(bundle({ evidence: refs, facts: [
      fact('tag-only', entry.product, '公司开展相关研发活动', 'product_scene', ['tag-only']),
      fact('complexity-only', entry.product, entry.complexity, entry.complexityKind, ['complexity-only']),
    ] }), NOW);
    expect(result.products.find(product => product.product === entry.product)?.level).toBe('低');
  });

  it('keeps a descriptive industry label at 待核实 when no product evidence exists', () => {
    const ev = reference('industry', 'company.example');
    const result = evaluateOpportunities(bundle({ evidence: [ev] }), NOW);
    expect(result.products.every(row => row.level === '待核实')).toBe(true);
  });

  it.each(['机器人智能装备', '消费级电子设备', null] as const)(
    'keeps identical confirmed product evidence at the same level for industryLabel=%s',
    industryLabel => {
      const input = completeHighCase(cases[0]!);
      input.industryLabel = industryLabel;
      input.industryEvidenceIds = industryLabel === null ? [] : ['recruitment'];
      const result = evaluateOpportunities(input, NOW);
      expect(result.products.find(row => row.product === 'windchill')?.level).toBe('高');
    },
  );

  it('does not recommend a product when no product evidence exists, regardless of industry label', () => {
    for (const industryLabel of ['机器人智能装备', '消费级电子设备', null] as const) {
      const evidence = industryLabel === null ? [] : [reference('industry', 'company.example')];
      const result = evaluateOpportunities(bundle({ industryLabel, evidence }), NOW);
      expect(result.products.every(row => row.level === '待核实')).toBe(true);
      expect(result).toMatchObject({ overallOpportunity: '待核实', recommendedProduct: null });
    }
  });

  it('does not change any opportunity result when the descriptive industry label changes', () => {
    const base = completeHighCase(cases[0]!);
    const results = [
      { industryLabel: '机器人智能装备', industryEvidenceIds: ['recruitment'] },
      { industryLabel: '消费级电子设备', industryEvidenceIds: ['recruitment'] },
      { industryLabel: null, industryEvidenceIds: [] },
    ].map(industry => evaluateOpportunities({
      ...base,
      ...industry,
    }, NOW));

    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('allows a confirmed RF engineering scene to make CST the medium-priority product', () => {
    const refs = [reference('rf', 'company.example'), reference('team', 'jobs.example')];
    const result = evaluateOpportunities(bundle({
      industryLabel: '射频通信设备', evidence: refs,
      facts: [
        fact('rf-scene', 'cst', '公司开展射频天线和 EMC/EMI 电磁仿真', 'product_scene', ['rf']),
        fact('rf-team', 'cst', '建有雷达微波研发团队', 'organization', ['team']),
      ],
    }), NOW);
    expect(result.products.find(row => row.product === 'cst')?.level).toBe('中');
    expect(result.recommendedProduct).toBe('cst');
    expect(result.overallOpportunity).toBe('中');
  });

  it('uses an explicit PDM recruitment statement even when Ark omits productTags', () => {
    const recruitment = reference('pdm-role', 'activity.zhipin.com');
    const result = evaluateOpportunities(bundle({
      industryLabel: null,
      evidence: [recruitment],
      facts: [{
        factId: 'pdm-role',
        statement: '招聘机械助理工程师，岗位职责包括执行设计规范和编写技术文档，任职要求包含学过 PDM。',
        kind: 'recruitment',
        productTags: [],
        strength: 'direct',
        evidenceIds: ['pdm-role'],
        entityScope: 'legal_entity',
        entityMatch: 'confirmed',
        matchBasis: ['网页内容提及已确认法定名称'],
      }],
    }), NOW);

    expect(result.products.find(row => row.product === 'windchill')?.level).toBe('中');
    expect(result.overallOpportunity).toBe('中');
    expect(result.recommendedProduct).toBe('windchill');
  });

  it('downgrades a strong incumbent without a replacement signal to 低', () => {
    const refs = [reference('scene', 'company.example'), reference('incumbent', 'jobs.example')];
    const result = evaluateOpportunities(bundle({ evidence: refs, facts: [
      fact('scene', 'creo', '公司开展参数化机械设计', 'product_scene', ['scene']),
      fact('incumbent', 'creo', '公司长期统一使用 Siemens NX 并已锁定集团许可', 'software_ecosystem', ['incumbent']),
    ] }), NOW);
    const creo = result.products.find(row => row.product === 'creo');
    expect(creo?.level).toBe('低');
    expect(creo?.blockers.join('')).toMatch(/NX|替代|锁定/);
  });

  it('does not treat direct competitor evidence as positive evidence in the overall tie-break', () => {
    const incumbent = reference('incumbent-only', 'jobs.example');
    const result = evaluateOpportunities(bundle({ evidence: [incumbent], facts: [
      fact('incumbent-only', 'creo', '招聘 Siemens NX 设计工程师', 'recruitment', ['incumbent-only']),
    ] }), NOW);
    expect(result.products.find(product => product.product === 'creo')?.level).toBe('低');
    expect(result.recommendedProduct).toBeNull();
  });

  it.each([
    { statement: '公司没有预算', kind: 'budget' as const },
    { statement: '公司并非预算充足', kind: 'budget' as const },
    { statement: '公司未获预算批准', kind: 'budget' as const },
    { statement: '公司预算不充足', kind: 'budget' as const },
    { statement: '公司资金不足', kind: 'budget' as const },
    { statement: '目标主体不具备独立采购权', kind: 'decision_power' as const },
    { statement: '目标主体并不拥有独立采购权', kind: 'decision_power' as const },
    { statement: '目标主体不具有独立采购权', kind: 'decision_power' as const },
    { statement: '目标主体未获采购决策权', kind: 'decision_power' as const },
  ])('treats explicit negative support as a blocker: $statement', ({ statement, kind }) => {
    const input = completeHighCase(cases[0]!);
    input.evidence.push(reference('negative', 'company.example'));
    input.facts.push(fact('negative', 'windchill', statement, kind, ['negative']));
    const row = evaluateOpportunities(input, NOW).products.find(product => product.product === 'windchill');
    expect(row?.level).toBe('低');
    expect(row?.blockers.join('')).toContain(kind === 'budget' ? '预算' : '决策');
  });

  it.each([
    { label: 'explicit recent confirmed migration', statement: '公司正在将 Siemens NX 迁移替换为 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '中' },
    { label: 'soon planned migration', statement: '公司不久后计划将 Siemens NX 迁移替换为 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '中' },
    { label: 'proactive decided migration', statement: '公司未雨绸缪后决定将 Siemens NX 迁移替换为 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '中' },
    { label: 'necessary migration', statement: '公司不得不将 Siemens NX 迁移替换为 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '中' },
    { label: 'reverse replacement', statement: '公司将 Creo 替换为 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'migrate from NX to Creo', statement: '公司从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '中' },
    { label: 'replace NX with Creo', statement: '公司用 Creo 替换 NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '中' },
    { label: 'not yet migrate from NX to Creo', statement: '公司尚未从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'will not replace NX with Creo', statement: '公司不会将 NX 替换为 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'did not use Creo to replace NX', statement: '公司并未用 Creo 替换 NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'does not consider migrating from NX to Creo', statement: '公司不考虑从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'migration to Creo incomplete', statement: '公司从 NX 迁移到 Creo 尚未完成', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'does not intend to migrate', statement: '公司并不打算从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'refuses migration', statement: '公司拒绝从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'abandons replacement', statement: '公司放弃将 NX 替换为 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'still not migrated', statement: '公司仍未从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'migration not completed', statement: '公司从 NX 迁移到 Creo，但没有完成', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'cancels migration', statement: '公司取消从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'pauses migration', statement: '公司暂停从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'stops migration', statement: '公司停止从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'terminates migration', statement: '公司终止从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'rejects migration', statement: '公司否决从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'defers migration', statement: '公司暂缓从 NX 迁移到 Creo', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'explicit recent probable migration', statement: '公司正在将 Siemens NX 迁移替换为 Creo', publishedAt: RECENT, match: 'probable' as const, expected: '低' },
    { label: 'generic procurement', statement: '公司发布软件采购招标', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'negated migration', statement: '公司暂无迁移替换计划', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'not migrated', statement: '公司未迁移替换 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'explicitly not migrated', statement: '公司并未迁移替换 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'not migrated yet', statement: '公司尚未迁移替换 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'not decided', statement: '公司未决定是否迁移替换 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'not started migration', statement: '公司尚未开始迁移 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'replacement not launched', statement: '公司并未启动替换 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'replacement not considered', statement: '公司暂不考虑替代 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'migration work incomplete', statement: 'Siemens NX 迁移工作尚未完成', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'ordinary not started migration', statement: '公司未开始迁移 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'ordinary do not launch replacement', statement: '公司不启动替换 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'ordinary not implemented replacement', statement: '公司未实施替代 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'ordinary do not consider migration', statement: '公司不考虑迁移 Siemens NX', publishedAt: RECENT, match: 'confirmed' as const, expected: '低' },
    { label: 'old migration', statement: '公司计划迁移替换 Siemens NX', publishedAt: '2025-08-29T11:59:59.999Z', match: 'confirmed' as const, expected: '低' },
    { label: 'future migration', statement: '公司计划迁移替换 Siemens NX', publishedAt: '2026-08-31T12:00:00.000Z', match: 'confirmed' as const, expected: '低' },
    { label: 'undated migration', statement: '公司计划迁移替换 Siemens NX', publishedAt: null, match: 'confirmed' as const, expected: '低' },
    { label: 'unverified migration', statement: '公司计划迁移替换 Siemens NX', publishedAt: RECENT, match: 'unverified' as const, expected: '低' },
  ])('only an explicit, attributed and recent replacement clears an incumbent: $label', scenario => {
    const refs = [
      reference('scene', 'company.example'), reference('complexity', 'association.example'),
      reference('incumbent', 'jobs.example'),
      reference('replacement', 'notice.example', scenario.publishedAt, scenario.match),
    ];
    const replacement = fact('replacement', 'creo', scenario.statement, 'procurement', ['replacement'], {
      entityMatch: scenario.match,
      entityScope: scenario.match === 'unverified' ? 'unknown' : 'legal_entity',
    });
    if (scenario.match === 'unverified') replacement.matchBasis = ['仅提及简称'];
    const result = evaluateOpportunities(bundle({ evidence: refs, facts: [
      fact('scene', 'creo', '公司开展 Creo 参数化机械设计', 'product_scene', ['scene']),
      fact('complexity', 'creo', '多型号复杂零部件研发', 'organization', ['complexity']),
      fact('incumbent', 'creo', '公司长期使用 Siemens NX', 'software_ecosystem', ['incumbent']),
      replacement,
    ] }), NOW);
    const row = result.products.find(product => product.product === 'creo');
    expect(row?.level).toBe(scenario.expected);
    expect(row?.blockers.some(blocker => blocker.toLowerCase().includes('siemens nx')))
      .toBe(scenario.expected === '低');
  });

  it('does not treat an Abaqus server migration as replacing the confirmed ANSYS incumbent', () => {
    const refs = [
      reference('scene', 'company.example'), reference('complexity', 'association.example'),
      reference('incumbent', 'jobs.example'), reference('replacement', 'notice.example'),
    ];
    const row = evaluateOpportunities(bundle({ evidence: refs, facts: [
      fact('scene', 'abaqus', '公司开展 Abaqus 非线性有限元分析', 'product_scene', ['scene']),
      fact('complexity', 'abaqus', '多材料碰撞仿真研发团队', 'organization', ['complexity']),
      fact('incumbent', 'abaqus', '公司长期使用 ANSYS', 'software_ecosystem', ['incumbent']),
      fact('replacement', 'abaqus', 'Abaqus 迁移到新服务器', 'procurement', ['replacement']),
    ] }), NOW).products.find(product => product.product === 'abaqus');
    expect(row?.level).toBe('低');
    expect(row?.blockers.join('')).toMatch(/ansys/i);
  });

  it.each([
    { product: 'windchill' as const, statement: '公司统一使用 Teamcenter PLM 平台' },
    { product: 'feigenbaum_qms' as const, statement: '公司统一使用 IQS QMS 平台' },
  ])('$product: a competitor plus only a generic category term cannot establish target scene', ({ product, statement }) => {
    const input = bundle({ evidence: [reference('competitor-scene', 'company.example')], facts: [
      fact('competitor-scene', product, statement, 'product_scene', ['competitor-scene']),
    ] });
    const row = evaluateOpportunities(input, NOW).products.find(candidate => candidate.product === product);
    expect(row?.level).toBe('低');
    expect(row?.gaps.join('')).toContain('未发现可归属于目标法定主体的具体产品场景');
  });

  it('keeps a strong Windchill scene when the same fact explicitly migrates from Teamcenter', () => {
    const refs = [reference('migration', 'company.example'), reference('complexity', 'association.example')];
    const row = evaluateOpportunities(bundle({ evidence: refs, facts: [
      fact('migration', 'windchill', '公司从 Teamcenter 迁移到 Windchill', 'product_scene', ['migration']),
      fact('complexity', 'windchill', '多部门 BOM 变更和配置管理', 'organization', ['complexity']),
    ] }), NOW).products.find(product => product.product === 'windchill');
    expect(row?.level).toBe('中');
  });

  it.each([
    { product: 'windchill' as const, statement: '集团统一 PLM 平台' },
    { product: 'feigenbaum_qms' as const, statement: '集团统一 QMS 平台' },
    { product: 'creo' as const, statement: '集团统一 CAD 平台' },
    { product: 'catia' as const, statement: '集团统一 CAD 平台' },
    { product: 'abaqus' as const, statement: '集团统一 CAE 平台' },
    { product: 'cst' as const, statement: '集团统一电磁仿真平台' },
    { product: 'solidworks' as const, statement: '集团统一 CAD 平台' },
  ])('$product: product-specific group standard remains a blocker', ({ product, statement }) => {
    const entry = cases.find(candidate => candidate.product === product)!;
    const input = completeHighCase(entry);
    input.evidence.push(reference('group-standard', 'group.example'));
    input.facts.push(fact('group-standard', product, statement, 'software_ecosystem', ['group-standard']));
    const row = evaluateOpportunities(input, NOW).products.find(candidate => candidate.product === product);
    expect(row?.level).toBe('低');
    expect(row?.blockers.join('')).toContain('已知系统阻碍');
  });

  it('does not mistake a corrected double-negative budget statement for a blocker', () => {
    const input = completeHighCase(cases[0]!);
    input.evidence.push(reference('budget-correction', 'company.example'));
    input.facts.push(fact('budget-correction', 'windchill', '公司并非没有预算', 'budget', ['budget-correction']));
    const row = evaluateOpportunities(input, NOW).products.find(product => product.product === 'windchill');
    expect(row?.level).toBe('高');
    expect(row?.blockers.join('')).not.toContain('预算');
  });

  it('accepts explicit sufficient funds after saying there is no budget problem', () => {
    const input = completeHighCase(cases[0]!);
    input.financingRecords = [];
    input.evidence.push(reference('budget-correction', 'company.example'));
    input.facts.push(fact(
      'budget-correction', 'windchill', '公司没有预算问题，资金充足', 'budget', ['budget-correction'],
    ));
    const row = evaluateOpportunities(input, NOW).products.find(product => product.product === 'windchill');
    expect(row?.level).toBe('高');
    expect(row?.blockers.join('')).not.toContain('预算');
  });

  it('returns all pending for a critical identity conflict', () => {
    const input = bundle({ conflicts: ['法定主体归属冲突'] });
    const result = evaluateOpportunities(input, NOW);
    expect(result.products.every(row => row.level === '待核实')).toBe(true);
    expect(result).toMatchObject({ overallOpportunity: '待核实', recommendedProduct: null });
  });

  it('does not promote evidence whose supporting entity matches are all unverified', () => {
    const ev = reference('unverified', 'unknown.example', RECENT, 'unverified');
    const unsupported = fact('scene', 'windchill', 'Windchill PLM 实施', 'product_scene', ['unverified'], {
      entityMatch: 'unverified', entityScope: 'unknown',
    });
    unsupported.matchBasis = ['仅提及简称'];
    const result = evaluateOpportunities(bundle({ evidence: [ev], facts: [unsupported] }), NOW);
    expect(result.products.find(row => row.product === 'windchill')?.level).toBe('待核实');
    expect(result.recommendedProduct).toBeNull();
  });

  it('applies the unverified-support gate per product instead of letting another product wash it', () => {
    const wind = reference('wind-unverified', 'unknown.example', RECENT, 'unverified');
    const creo = reference('creo-confirmed', 'company.example');
    const windFact = fact('wind-unverified', 'windchill', 'Windchill PLM 实施', 'product_scene', ['wind-unverified'], {
      entityMatch: 'unverified', entityScope: 'unknown',
    });
    windFact.matchBasis = ['仅提及简称'];
    const result = evaluateOpportunities(bundle({ evidence: [wind, creo], facts: [
      windFact,
      fact('creo-confirmed', 'creo', 'Creo 参数化机械设计', 'product_scene', ['creo-confirmed']),
    ] }), NOW);
    expect(result.products.find(product => product.product === 'windchill')?.level).toBe('待核实');
  });

  it('does not promote a confirmed fact whose cited reference is unverified', () => {
    const unverifiedReference = reference('mismatched', 'unknown.example', RECENT, 'unverified');
    const result = evaluateOpportunities(bundle({ evidence: [unverifiedReference], facts: [
      fact('mismatched', 'windchill', 'Windchill PLM 实施和 BOM 变更管理', 'product_scene', ['mismatched']),
    ] }), NOW);
    expect(result.products.find(product => product.product === 'windchill')?.level).toBe('待核实');
  });

  it('keeps the aggregate pending when the only positive product support is probable', () => {
    const ev = reference('probable', 'jobs.example', RECENT, 'probable');
    const probable = fact('scene', 'cst', 'CST Studio Suite 电磁仿真工程师', 'recruitment', ['probable'], {
      entityMatch: 'probable', entityScope: 'legal_entity',
    });
    const result = evaluateOpportunities(bundle({ evidence: [ev], facts: [probable] }), NOW);
    expect(result).toMatchObject({ overallOpportunity: '待核实', recommendedProduct: null });
  });

  it('keeps the aggregate pending when the only positive product support is weak', () => {
    const ev = reference('weak', 'company.example');
    const weak = fact('weak-scene', 'cst', '公司可能存在电磁仿真场景', 'product_scene', ['weak'], {
      strength: 'weak',
    });
    const result = evaluateOpportunities(bundle({ evidence: [ev], facts: [weak] }), NOW);
    expect(result).toMatchObject({ overallOpportunity: '待核实', recommendedProduct: null });
  });

  it('does not use financing whose cited source is not attributed to the legal entity', () => {
    const entry = cases[0]!;
    const input = completeHighCase(entry);
    input.evidence = input.evidence.map(item => item.evidenceId === 'financing'
      ? { ...item, entityScope: 'unknown', entityMatch: 'unverified', matchBasis: ['无法确认融资主体'] }
      : item);
    const row = evaluateOpportunities(input, NOW).products.find(product => product.product === entry.product);
    expect(row?.level).toBe('中');
    expect(row?.evidenceIds).not.toContain('financing');
  });

  it('does not let unrelated risk evidence satisfy the two-publisher high threshold', () => {
    const input = completeHighCase(cases[0]!);
    input.evidence = input.evidence.map(item => ({
      ...item, originalPublisher: '同一发布方', originalDomain: 'same.example',
    }));
    input.evidence.push(reference('unrelated-risk', 'risk-publisher.example'));
    input.facts.push(fact('unrelated-risk', 'creo', '未发现重大经营异常', 'risk', ['unrelated-risk']));
    expect(evaluateOpportunities(input, NOW).products
      .find(product => product.product === 'windchill')?.level).toBe('中');
  });

  it('does not treat untagged generic quality complexity as matching a Windchill scene', () => {
    const refs = [reference('scene', 'company.example'), reference('generic-quality', 'quality.example')];
    const genericQuality = fact('generic-quality', 'windchill', '公司设有质量团队', 'quality', ['generic-quality']);
    genericQuality.productTags = [];
    const result = evaluateOpportunities(bundle({ evidence: refs, facts: [
      fact('scene', 'windchill', '公司开展 Windchill PLM 实施', 'product_scene', ['scene']),
      genericQuality,
    ] }), NOW);
    expect(result.products.find(product => product.product === 'windchill')?.level).toBe('低');
  });

  it('counts only supporting references whose attribution agrees with their facts', () => {
    const input = completeHighCase(cases[0]!);
    input.evidence = input.evidence.map(item => {
      if (item.evidenceId === 'complexity') {
        return {
          ...item, originalPublisher: '行业协会', originalDomain: 'association.example',
          entityScope: 'unknown' as const, entityMatch: 'unverified' as const, matchBasis: ['无法确认主体'],
        };
      }
      return { ...item, originalPublisher: '目标公司', originalDomain: 'same.example' };
    });
    expect(evaluateOpportunities(input, NOW).products
      .find(product => product.product === 'windchill')?.level).toBe('中');
  });

  it('does not treat a generic recent recruitment as product timing', () => {
    const refs = [
      reference('scene', 'company.example'), reference('complexity', 'association.example'),
      reference('generic-job', 'jobs.example'), reference('budget', 'finance.example'),
      reference('decision', 'company.example'),
    ];
    const result = evaluateOpportunities(bundle({ evidence: refs, facts: [
      fact('scene', 'creo', '公司开展参数化机械设计', 'product_scene', ['scene']),
      fact('complexity', 'creo', '多型号复杂零部件研发', 'organization', ['complexity']),
      fact('generic-job', 'creo', '招聘机械工程师', 'recruitment', ['generic-job']),
      fact('budget', 'creo', '公司已批准研发软件预算', 'budget', ['budget']),
      fact('decision', 'creo', '目标法定主体具有独立采购决策权', 'decision_power', ['decision']),
    ] }), NOW);
    expect(result.products.find(product => product.product === 'creo')?.level).toBe('中');
  });

  it('does not mistake unknown budget and decision statements for positive support', () => {
    const input = completeHighCase(cases[0]!);
    input.financingRecords = [];
    input.evidence.push(reference('budget-unknown', 'finance.example'));
    input.facts = [
      ...input.facts.filter(item => item.kind !== 'decision_power'),
      fact('budget-unknown', 'windchill', '项目预算尚未确认，待核实', 'budget', ['budget-unknown']),
      fact('decision-unknown', 'windchill', '独立采购决策权待核实', 'decision_power', ['decision']),
    ];
    expect(evaluateOpportunities(input, NOW).products
      .find(product => product.product === 'windchill')?.level).toBe('中');
  });

  it('returns the schema order and uses direct evidence, blocker count, then fixed order for ties', () => {
    const windchill = completeHighCase(cases[0]!);
    const creo = completeHighCase(cases[2]!);
    const merged: EvidenceBundle = {
      ...windchill,
      evidence: [...windchill.evidence, ...creo.evidence.map(item => ({ ...item, evidenceId: `creo-${item.evidenceId}` }))],
      facts: [...windchill.facts, ...creo.facts.map(item => ({
        ...item, factId: `creo-${item.factId}`, evidenceIds: item.evidenceIds.map(id => `creo-${id}`),
      }))],
      financingRecords: windchill.financingRecords,
    };
    const result = evaluateOpportunities(merged, NOW);
    expect(result.products.map(row => row.product)).toEqual(ProductKeySchema.options);
    expect(result.recommendedProduct).toBe('windchill');
  });

  it('is deterministic for an explicit clock and does not mutate the input', () => {
    const input = completeHighCase(cases[0]!);
    const snapshot = structuredClone(input);
    const first = evaluateOpportunities(input, NOW);
    expect(evaluateOpportunities(input, NOW)).toEqual(first);
    expect(input).toEqual(snapshot);
  });

  it('returns a gaps-only aggregate result for empty evidence', () => {
    const result = evaluateOpportunities(bundle({ industryLabel: null }), NOW);
    expect(result.products).toHaveLength(7);
    expect(result.products.every(row => row.level === '待核实')).toBe(true);
    expect(result).toMatchObject({ overallOpportunity: '待核实', recommendedProduct: null });
  });
});
