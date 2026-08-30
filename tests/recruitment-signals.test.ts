import { describe, expect, it } from 'vitest';
import type { EvidenceBundle, EvidenceFact, EvidenceReference, ProductKey } from '../src/contracts/index.js';
import { evaluateOpportunities } from '../src/opportunity/evaluate-all.js';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const recent = '2026-08-01T12:00:00.000Z';
const old = '2025-08-29T11:59:59.999Z';
const exactly365Days = '2025-08-30T12:00:00.000Z';
const olderByOneMillisecond = '2025-08-30T11:59:59.999Z';
const identity = {
  legalName: '测试制造有限公司', creditCode: '91310000TEST000001',
  formerNames: [], aliases: [], englishNames: [], brands: [], officialDomains: [],
  registeredAddress: null, parentLegalName: null, subsidiaryLegalNames: [],
};

const products: ReadonlyArray<{
  product: ProductKey;
  keyword: string;
  named: string;
  method: string;
  competitor: string;
  generic: string;
}> = [
  { product: 'windchill', keyword: 'Windchill', named: 'Windchill PLM 管理员', method: 'BOM 变更和配置管理', competitor: 'Teamcenter PLM 管理员', generic: '研发工程师' },
  { product: 'feigenbaum_qms', keyword: 'Feigenbaum QMS', named: 'Feigenbaum QMS 实施顾问', method: 'CAPA 与质量追溯', competitor: 'SAP QM 系统管理员', generic: '质量工程师' },
  { product: 'creo', keyword: 'Creo', named: 'Creo 机械设计工程师', method: '参数化建模', competitor: 'Siemens NX 设计工程师', generic: '机械工程师' },
  { product: 'catia', keyword: 'CATIA', named: 'CATIA 设计工程师', method: '复杂曲面与大型装配', competitor: 'Siemens NX 曲面设计工程师', generic: '三维设计工程师' },
  { product: 'abaqus', keyword: 'Abaqus', named: 'Abaqus 仿真工程师', method: '非线性有限元分析', competitor: 'ANSYS 仿真工程师', generic: '仿真工程师' },
  { product: 'cst', keyword: 'CST Studio Suite', named: 'CST Studio Suite 电磁仿真工程师', method: '射频天线 EMC/EMI 仿真', competitor: 'HFSS 电磁仿真工程师', generic: '电子工程师' },
  { product: 'solidworks', keyword: 'SolidWorks', named: 'SolidWorks 机械设计工程师', method: '通用设备三维建模', competitor: 'Autodesk Inventor 机械设计工程师', generic: '机械设计工程师' },
];

function recruitmentBundle(
  entry: typeof products[number],
  statement: string,
  publishedAt: string,
  strength: EvidenceFact['strength'] = 'direct',
): EvidenceBundle {
  const evidence: EvidenceReference = {
    evidenceId: 'job', title: statement, url: 'https://jobs.company.example/job',
    originalPublisher: '公司招聘官网', originalDomain: 'jobs.company.example', publishedAt,
    collectedAt: NOW.toISOString(), mentionedName: identity.legalName,
    entityScope: 'legal_entity', entityMatch: 'confirmed', matchBasis: ['官方域名与全称一致'],
  };
  return {
    identity, industryClassification: 'P1', industryEvidenceIds: ['job'], evidence: [evidence],
    facts: [{
      factId: 'job-fact', statement, kind: 'recruitment', productTags: [entry.product], strength,
      evidenceIds: ['job'], entityScope: 'legal_entity', entityMatch: 'confirmed',
      matchBasis: ['官方域名与全称一致'],
    }],
    financingRecords: [], conflicts: [], gaps: [], collectedAt: NOW.toISOString(),
  };
}

describe('招聘信号', () => {
  it.each(products.flatMap(entry => [
    { entry, label: '不使用产品', statement: `岗位明确不使用 ${entry.keyword}` },
    { entry, label: '无需产品经验', statement: `岗位无需 ${entry.keyword} 经验` },
    { entry, label: '产品已停用', statement: `${entry.keyword} 已停用` },
    { entry, label: '未开展工程方法', statement: `公司未开展 ${entry.method}` },
    { entry, label: '暂不建设产品系统', statement: `公司暂不建设 ${entry.keyword} 系统` },
  ]))('$entry.product: $label cannot establish a positive recruitment scene', ({ entry, statement }) => {
    const row = evaluateOpportunities(recruitmentBundle(entry, statement, recent), NOW)
      .products.find(product => product.product === entry.product);
    expect(row?.level).toBe('低');
  });

  it('keeps an affirmative product clause when a different product is negated', () => {
    const entry = products.find(product => product.product === 'creo')!;
    const input = recruitmentBundle(entry, '岗位不使用 Siemens NX，而使用 Creo 开展参数化建模', recent);
    expect(evaluateOpportunities(input, NOW).products
      .find(product => product.product === entry.product)?.level).toBe('中');
  });

  it.each([
    { product: 'creo' as const, statement: 'Creo无需出差' },
    { product: 'catia' as const, statement: 'CATIA不需要五年经验' },
    { product: 'creo' as const, statement: '停用旧系统后部署Creo' },
    { product: 'creo' as const, statement: '未开展旧项目后招聘Creo' },
  ])('$product: unrelated negation does not cancel an affirmative target-product signal', ({ product, statement }) => {
    const entry = products.find(candidate => candidate.product === product)!;
    const row = evaluateOpportunities(recruitmentBundle(entry, statement, recent), NOW)
      .products.find(candidate => candidate.product === product);
    expect(row?.level).toBe('中');
  });

  it('treats Siemens NX as an affirmative competitor when only night shifts are unnecessary', () => {
    const entry = products.find(product => product.product === 'creo')!;
    const row = evaluateOpportunities(recruitmentBundle(entry, 'Siemens NX无需夜班', recent), NOW)
      .products.find(product => product.product === entry.product);
    expect(row?.level).toBe('低');
    expect(row?.blockers.join('')).toMatch(/siemens nx/i);
  });

  it.each([
    { product: 'creo' as const, statement: '无需Pro/E但要求Creo' },
    { product: 'windchill' as const, statement: '不使用旧版PLM但招聘Windchill管理员' },
  ])('$product: a negative alias does not contaminate a later affirmative alias', ({ product, statement }) => {
    const entry = products.find(candidate => candidate.product === product)!;
    const row = evaluateOpportunities(recruitmentBundle(entry, statement, recent), NOW)
      .products.find(candidate => candidate.product === product);
    expect(row?.level).toBe('中');
  });

  it.each([
    { product: 'creo' as const, statement: '停止使用Creo' },
    { product: 'creo' as const, statement: 'Creo计划停用' },
    { product: 'catia' as const, statement: 'CATIA后续不再使用' },
  ])('$product: controlled pre/post action explicitly stops product use', ({ product, statement }) => {
    const entry = products.find(candidate => candidate.product === product)!;
    const row = evaluateOpportunities(recruitmentBundle(entry, statement, recent), NOW)
      .products.find(candidate => candidate.product === product);
    expect(row?.level).toBe('低');
  });

  it.each([
    { product: 'creo' as const, statement: '不使用Creo和Pro/E' },
    { product: 'catia' as const, statement: '无需CATIA及3DEXPERIENCE经验' },
    { product: 'cst' as const, statement: '未开展射频或天线仿真' },
    { product: 'windchill' as const, statement: '暂不建设PLM、Windchill以及BOM管理系统' },
  ])('$product: a controlled enumeration keeps all listed product signals negated', ({ product, statement }) => {
    const entry = products.find(candidate => candidate.product === product)!;
    const row = evaluateOpportunities(recruitmentBundle(entry, statement, recent), NOW)
      .products.find(candidate => candidate.product === product);
    expect(row?.level).toBe('低');
  });

  it.each(products)('$product: recent direct product naming is a strong scene signal but one publisher is only 中', entry => {
    const result = evaluateOpportunities(recruitmentBundle(entry, `${entry.named}，${entry.method}`, recent), NOW);
    const row = result.products.find(product => product.product === entry.product);
    expect(row?.level).toBe('中');
    expect(row?.evidenceIds).toEqual(['job']);
  });

  it.each(products)('$product: a competitor-only job is ecosystem evidence, not a target-product scene', entry => {
    const result = evaluateOpportunities(recruitmentBundle(entry, entry.competitor, recent), NOW);
    const row = result.products.find(product => product.product === entry.product);
    expect(row?.level).toBe('低');
    expect(row?.blockers.length).toBeGreaterThan(0);
  });

  it.each(products)('$product: a generic role cannot establish a product scene', entry => {
    const result = evaluateOpportunities(recruitmentBundle(entry, entry.generic, recent, 'weak'), NOW);
    expect(result.products.find(product => product.product === entry.product)?.level).toBe('低');
  });

  it.each(products)('$product: a generic role cannot supply ecosystem support even if the model marked it direct', entry => {
    const input = recruitmentBundle(entry, entry.generic, recent, 'direct');
    input.evidence.push({
      ...input.evidence[0]!, evidenceId: 'scene', title: '已确认产品场景',
      url: 'https://company.example/scene', originalPublisher: '公司官网', originalDomain: 'company.example',
    });
    input.facts.push({
      ...input.facts[0]!, factId: 'scene-fact', statement: '已确认一个具体产品场景',
      kind: 'product_scene', evidenceIds: ['scene'],
    });
    expect(evaluateOpportunities(input, NOW).products
      .find(product => product.product === entry.product)?.level).toBe('低');
  });

  it.each(products)('$product: a recruitment older than 365 days is historical ecosystem only', entry => {
    const result = evaluateOpportunities(recruitmentBundle(entry, `${entry.named}，${entry.method}`, old), NOW);
    const row = result.products.find(product => product.product === entry.product);
    expect(row?.level).toBe('低');
    expect(row?.gaps.join('')).toMatch(/365|历史|过期/);
  });

  it.each(products)('$product: unverified direct recruitment remains pending even when another product is confirmed', entry => {
    const input = recruitmentBundle(entry, `${entry.named}，${entry.method}`, recent);
    const otherProduct = entry.product === 'creo' ? 'windchill' : 'creo';
    const otherStatement = otherProduct === 'creo'
      ? 'Creo 参数化机械设计'
      : 'Windchill PLM BOM 变更管理';
    input.evidence[0] = {
      ...input.evidence[0]!, entityScope: 'unknown', entityMatch: 'unverified', matchBasis: ['仅提及简称'],
    };
    input.facts[0] = {
      ...input.facts[0]!, entityScope: 'unknown', entityMatch: 'unverified', matchBasis: ['仅提及简称'],
    };
    input.evidence.push({
      ...input.evidence[0]!, evidenceId: 'other-product', url: 'https://company.example/creo',
      entityScope: 'legal_entity', entityMatch: 'confirmed', matchBasis: ['官方域名与全称一致'],
    });
    input.facts.push({
      ...input.facts[0]!, factId: 'other-product', statement: otherStatement,
      productTags: [otherProduct], evidenceIds: ['other-product'], entityScope: 'legal_entity', entityMatch: 'confirmed',
      matchBasis: ['官方域名与全称一致'],
    });
    expect(evaluateOpportunities(input, NOW).products
      .find(product => product.product === entry.product)?.level).toBe('待核实');
  });

  it.each(products)('$product: exactly 365 days is recent, while one millisecond older is historical', entry => {
    const boundary = evaluateOpportunities(recruitmentBundle(entry, `${entry.named}，${entry.method}`, exactly365Days), NOW);
    expect(boundary.products.find(product => product.product === entry.product)?.level).toBe('中');

    const expired = evaluateOpportunities(recruitmentBundle(entry, `${entry.named}，${entry.method}`, olderByOneMillisecond), NOW);
    expect(expired.products.find(product => product.product === entry.product)?.level).toBe('低');
    expect(expired.products.find(product => product.product === entry.product)?.gaps.join('')).toMatch(/365|历史|过期/);
  });

  it.each([
    { label: 'missing', publishedAt: null, expectedGap: /缺失|无日期/ },
    { label: 'future', publishedAt: '2026-08-31T12:00:00.000Z', expectedGap: /晚于|未来/ },
  ])('does not call a $label recruitment older than 365 days', ({ publishedAt, expectedGap }) => {
    const entry = products[0]!;
    const input = recruitmentBundle(entry, `${entry.named}，${entry.method}`, recent);
    input.evidence[0] = { ...input.evidence[0]!, publishedAt };
    const row = evaluateOpportunities(input, NOW).products.find(product => product.product === entry.product);
    expect(row?.level).toBe('低');
    expect(row?.gaps.join('')).toMatch(expectedGap);
    expect(row?.gaps.join('')).not.toContain('超过 365 天');
  });

  it.each([
    { label: 'missing', publishedAt: null, expectedGap: /缺失|无日期/ },
    { label: 'future', publishedAt: '2026-08-31T12:00:00.000Z', expectedGap: /晚于|未来/ },
  ])('keeps positive $label recruitment as historical ecosystem, never recent timing', ({ publishedAt, expectedGap }) => {
    const entry = products[0]!;
    const input = recruitmentBundle(entry, `${entry.named}，${entry.method}`, recent);
    input.evidence[0] = { ...input.evidence[0]!, publishedAt };
    input.evidence.push({
      ...input.evidence[0]!, evidenceId: 'scene', title: '公司已实施 Windchill PLM',
      url: 'https://company.example/plm', originalPublisher: '公司官网', originalDomain: 'company.example',
      publishedAt: recent,
    });
    input.facts.push({
      ...input.facts[0]!, factId: 'scene-fact', statement: '公司已实施 Windchill PLM 管理 BOM 变更',
      kind: 'product_scene', evidenceIds: ['scene'],
    });
    const row = evaluateOpportunities(input, NOW).products.find(product => product.product === entry.product);
    expect(row?.level).toBe('中');
    expect(row?.gaps.join('')).toMatch(expectedGap);
    expect(row?.gaps.join('')).toMatch(/近期|365/);
  });
});
