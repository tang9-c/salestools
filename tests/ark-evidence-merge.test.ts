import { describe, expect, it } from 'vitest';
import type {
  EvidenceBundle,
  EvidenceFact,
  EvidenceReference,
  IdentityProfile,
  ResearchBundle,
  ResearchItem,
} from '../src/contracts/index.js';
import { mergeArkEvidence } from '../src/upstream/ark/merge-evidence.js';

const NOW = '2026-09-06T00:00:00.000Z';
const IDENTITY: IdentityProfile = {
  legalName: '测试装备有限公司', creditCode: '91440000TEST000001', formerNames: [],
  aliases: ['测试装备'], englishNames: [], brands: [], officialDomains: [],
  registeredAddress: '广东省东莞市', parentLegalName: null, subsidiaryLegalNames: [],
};

function item(evidenceId: string): ResearchItem {
  return {
    evidenceId, source: 'qcc', sourceKind: 'operation', title: `材料 ${evidenceId}`,
    url: null, originalPublisher: null, originalDomain: null,
    summary: '招聘材料（企查查材料，待模型整理）', content: '{"material":"SolidWorks 招聘"}',
    publishedAt: NOW, collectedAt: NOW, mentionedName: IDENTITY.legalName,
    entityScope: 'legal_entity', entityMatch: 'confirmed', matchBasis: ['法定名称'],
    query: null, position: null, logId: null,
  };
}

function research(items: ResearchItem[], gaps: string[] = []): ResearchBundle {
  return {
    identity: IDENTITY, items, gaps, collectedAt: NOW,
    sourceStatus: {
      qcc: { status: 'partial', error: '部分工具未提供直接来源链接' },
      doubaoSearch: { status: 'completed', error: null },
    },
  };
}

function reference(source: ResearchItem): EvidenceReference {
  const { evidenceId, title, url, originalPublisher, originalDomain, publishedAt, collectedAt,
    mentionedName, entityScope, entityMatch, matchBasis } = source;
  return { evidenceId, title, url, originalPublisher, originalDomain, publishedAt, collectedAt,
    mentionedName, entityScope, entityMatch, matchBasis };
}

function fact(factId: string, evidenceId: string, strength: EvidenceFact['strength'] = 'direct'): EvidenceFact {
  return {
    factId, statement: '岗位明确使用 SolidWorks 进行机械设计', kind: 'recruitment',
    productTags: ['solidworks'], strength, evidenceIds: [evidenceId],
    entityScope: 'legal_entity', entityMatch: 'confirmed', matchBasis: ['法定名称'],
  };
}

function evidence(input: ResearchBundle, overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    identity: IDENTITY, industryLabel: null, industryEvidenceIds: [], evidence: [], facts: [],
    financingRecords: [], conflicts: [], gaps: [], collectedAt: NOW, ...overrides,
  };
}

describe('mergeArkEvidence', () => {
  it('merges exactly equivalent facts without promoting their strength or attribution', () => {
    const e1 = item('e-1');
    const e2 = item('e-2');
    const original = research([e1, e2]);
    const direct = mergeArkEvidence({
      original,
      successful: [
        { input: research([e1]), evidence: evidence(original, { evidence: [reference(e1)], facts: [fact('f-1', 'e-1')] }) },
        { input: research([e2]), evidence: evidence(original, { evidence: [reference(e2)], facts: [fact('f-2', 'e-2')] }) },
      ],
      failedEvidenceIds: [], unplannedEvidenceIds: [],
    });

    expect(direct.evidence.map(entry => entry.evidenceId)).toEqual(['e-1', 'e-2']);
    expect(direct.facts).toHaveLength(1);
    expect(direct.facts[0]).toMatchObject({ strength: 'direct', evidenceIds: ['e-1', 'e-2'] });

    const mixed = mergeArkEvidence({
      original,
      successful: [
        { input: research([e1]), evidence: evidence(original, { evidence: [reference(e1)], facts: [fact('f-1', 'e-1')] }) },
        { input: research([e2]), evidence: evidence(original, { evidence: [reference(e2)], facts: [fact('f-2', 'e-2', 'supporting')] }) },
      ],
      failedEvidenceIds: [], unplannedEvidenceIds: [],
    });
    expect(mixed.facts.map(entry => entry.strength)).toEqual(['direct', 'supporting']);
  });

  it('merges identical financing summaries and reports conflicting confirmed industry labels', () => {
    const e1 = item('e-1');
    const e2 = item('e-2');
    const original = research([e1, e2]);
    const record = (id: string) => ({
      occurredAt: null, typeOrRound: null, disclosedAmount: null, investors: [],
      summary: '公司完成新一轮融资', evidenceIds: [id],
    });
    const merged = mergeArkEvidence({
      original,
      successful: [
        { input: research([e1]), evidence: evidence(original, {
          evidence: [reference(e1)], industryLabel: '机器人仓储设备', industryEvidenceIds: ['e-1'],
          financingRecords: [record('e-1')],
        }) },
        { input: research([e2]), evidence: evidence(original, {
          evidence: [reference(e2)], industryLabel: '智能物流装备', industryEvidenceIds: ['e-2'],
          financingRecords: [record('e-2')],
        }) },
      ],
      failedEvidenceIds: [], unplannedEvidenceIds: [],
    });

    expect(merged.industryLabel).toBe('机器人仓储设备');
    expect(merged.industryEvidenceIds).toEqual(['e-1']);
    expect(merged.conflicts).toContain('多批次行业标签冲突：机器人仓储设备 / 智能物流装备');
    expect(merged.financingRecords).toHaveLength(1);
    expect(merged.financingRecords[0]?.evidenceIds).toEqual(['e-1', 'e-2']);
  });

  it('resolves transient material states while preserving QCC link audit gaps', () => {
    const cited = item('cited');
    const uncited = item('uncited');
    const failed = item('failed');
    const unplanned = item('unplanned');
    const linkGap = '企查查未提供可验证直接来源链接：get_recruitment_info';
    const transient = '招聘使用非结构化材料整理';
    const original = research([cited, uncited, failed, unplanned], [transient, linkGap]);
    const merged = mergeArkEvidence({
      original,
      successful: [{
        input: research([cited, uncited], [transient, linkGap]),
        evidence: evidence(original, {
          evidence: [reference(cited)], facts: [fact('f-cited', 'cited')], gaps: [transient, linkGap],
        }),
      }],
      failedEvidenceIds: ['failed'], unplannedEvidenceIds: ['unplanned'],
    });

    expect(merged.gaps.join('\n')).not.toContain('待模型整理');
    expect(merged.gaps).toContain(linkGap);
    expect(merged.gaps).toContain('模型未从该材料提炼出可采信事实：uncited');
    expect(merged.gaps).toContain('材料未完成模型整理（批次失败）：failed');
    expect(merged.gaps).toContain('材料未完成模型整理（容量上限）：unplanned');
    expect(merged.gaps.some(gap => gap.endsWith('：cited'))).toBe(false);
  });

  it('does not treat an ordinary structured QCC record as pending material', () => {
    const structured = item('structured');
    structured.summary = '企业风险扫描结果';
    structured.content = '{"riskCount":2,"status":"正常"}';
    const original = research([structured]);

    const merged = mergeArkEvidence({
      original,
      successful: [{ input: original, evidence: evidence(original) }],
      failedEvidenceIds: [], unplannedEvidenceIds: [],
    });

    expect(merged.gaps).not.toContain('模型未从该材料提炼出可采信事实：structured');
  });
});
