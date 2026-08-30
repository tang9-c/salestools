import { describe, expect, it } from 'vitest';
import type { EvidenceBundle, EvidenceFact, EvidenceReference, ProductKey } from '../src/contracts/index.js';
import { evaluateOpportunities } from '../src/opportunity/evaluate-all.js';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const recent = '2026-08-01T12:00:00.000Z';
const old = '2025-08-29T11:59:59.999Z';
const identity = {
  legalName: '测试制造有限公司', creditCode: '91310000TEST000001',
  formerNames: [], aliases: [], englishNames: [], brands: [], officialDomains: [],
  registeredAddress: null, parentLegalName: null, subsidiaryLegalNames: [],
};

const products: ReadonlyArray<{
  product: ProductKey;
  named: string;
  method: string;
  competitor: string;
  generic: string;
}> = [
  { product: 'windchill', named: 'Windchill PLM 管理员', method: 'BOM 变更和配置管理', competitor: 'Teamcenter PLM 管理员', generic: '研发工程师' },
  { product: 'feigenbaum_qms', named: 'Feigenbaum QMS 实施顾问', method: 'CAPA 与质量追溯', competitor: 'SAP QM 系统管理员', generic: '质量工程师' },
  { product: 'creo', named: 'Creo 机械设计工程师', method: '参数化建模', competitor: 'Siemens NX 设计工程师', generic: '机械工程师' },
  { product: 'catia', named: 'CATIA 设计工程师', method: '复杂曲面与大型装配', competitor: 'Siemens NX 曲面设计工程师', generic: '三维设计工程师' },
  { product: 'abaqus', named: 'Abaqus 仿真工程师', method: '非线性有限元分析', competitor: 'ANSYS 仿真工程师', generic: '仿真工程师' },
  { product: 'cst', named: 'CST Studio Suite 电磁仿真工程师', method: '射频天线 EMC/EMI 仿真', competitor: 'HFSS 电磁仿真工程师', generic: '电子工程师' },
  { product: 'solidworks', named: 'SolidWorks 机械设计工程师', method: '通用设备三维建模', competitor: 'Autodesk Inventor 机械设计工程师', generic: '机械设计工程师' },
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
});
