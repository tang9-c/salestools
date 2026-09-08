import { describe, expect, it } from 'vitest';
import type { IdentityProfile, ResearchBundle, ResearchItem } from '../src/contracts/index.js';
import { buildArkMessages } from '../src/upstream/ark/prompt.js';
import { planArkBatches } from '../src/upstream/ark/batch-plan.js';

const NOW = '2026-09-06T00:00:00.000Z';
const IDENTITY: IdentityProfile = {
  legalName: '测试装备有限公司',
  creditCode: '91440000TEST000001',
  formerNames: [], aliases: ['测试装备'], englishNames: [], brands: [],
  officialDomains: ['test.example.cn'], registeredAddress: '广东省东莞市',
  parentLegalName: null, subsidiaryLegalNames: [],
};

function item(
  evidenceId: string,
  overrides: Partial<ResearchItem> = {},
): ResearchItem {
  return {
    evidenceId,
    source: 'doubao_search',
    sourceKind: 'web',
    title: `测试装备产品资料 ${evidenceId}`,
    url: `https://publisher.example/${evidenceId}`,
    originalPublisher: '测试发布方',
    originalDomain: 'publisher.example',
    summary: '测试装备有限公司研发工业自动化设备',
    content: '产品采用三维设计、有限元分析和质量追溯方法。',
    publishedAt: NOW,
    collectedAt: NOW,
    mentionedName: IDENTITY.legalName,
    entityScope: 'legal_entity',
    entityMatch: 'confirmed',
    matchBasis: ['网页内容提及已确认法定名称'],
    query: '测试装备 官网 产品 技术',
    position: 1,
    logId: null,
    ...overrides,
  };
}

function bundle(items: ResearchItem[]): ResearchBundle {
  return {
    identity: IDENTITY,
    items,
    sourceStatus: {
      qcc: { status: 'completed', error: null },
      doubaoSearch: { status: 'completed', error: null },
    },
    gaps: [],
    collectedAt: NOW,
  };
}

function serializedBytes(candidate: ResearchBundle): number {
  return Buffer.byteLength(JSON.stringify({
    model: 'ep-test',
    messages: buildArkMessages(candidate),
    response_format: { type: 'json_object' },
    temperature: 0,
  }), 'utf8');
}

describe('planArkBatches', () => {
  it('keeps the richer duplicate web result without deduplicating QCC records that lack URLs', () => {
    const qcc = (evidenceId: string): ResearchItem => item(evidenceId, {
      source: 'qcc', sourceKind: 'operation', url: null,
      originalPublisher: null, originalDomain: null, query: null,
    });
    const input = bundle([
      item('same-url-short', {
        url: 'HTTPS://Publisher.Example:443/article#first',
        content: null,
      }),
      item('same-url-with-longer-content', {
        url: 'https://publisher.example/article#second',
        content: '测试装备有限公司正在招聘使用 SolidWorks 的机械设计工程师，包含完整岗位职责。',
      }),
      qcc('qcc-no-url-1'),
      qcc('qcc-no-url-2'),
    ]);

    const plan = planArkBatches(input, 30_000, serializedBytes);
    const planned = plan.batches.flatMap(batch => batch.bundle.items);

    expect(plan.originalCount).toBe(4);
    expect(plan.candidateCount).toBe(3);
    expect(plan.deduplicatedCount).toBe(1);
    expect(planned).toContainEqual(expect.objectContaining({
      evidenceId: 'same-url-with-longer-content',
    }));
    expect(planned).not.toContainEqual(expect.objectContaining({ evidenceId: 'same-url-short' }));
    expect(planned.filter(entry => entry.source === 'qcc')).toHaveLength(2);
  });

  it('plans all ninety-two eligible items even when they require more than eight byte-bounded requests', () => {
    const input = bundle(Array.from({ length: 92 }, (_, index) => item(`e-${index + 1}`, {
      title: `资料 e-${index + 1}`,
      url: `https://publisher-${index + 1}.example/article`,
      originalDomain: `publisher-${index + 1}.example`,
      summary: null,
      matchBasis: ['法定名称'],
      content: index % 3 === 0 ? '招聘机械工程师，要求使用 Creo 进行参数化建模。' : null,
    })));

    const first = planArkBatches(input, 12_288, serializedBytes);
    const second = planArkBatches(input, 12_288, serializedBytes);
    const plannedIds = first.batches.flatMap(batch => batch.bundle.items.map(entry => entry.evidenceId));

    expect(first.batches.length).toBeGreaterThan(8);
    expect(new Set(plannedIds).size).toBe(first.candidateCount);
    expect(first.unplannedItems).toEqual([]);
    expect(first.batches.map(batch => batch.bundle.items.map(entry => entry.evidenceId)))
      .toEqual(second.batches.map(batch => batch.bundle.items.map(entry => entry.evidenceId)));
    for (const batch of first.batches) {
      expect(serializedBytes(batch.bundle)).toBe(batch.requestBytes);
      expect(batch.requestBytes).toBeLessThanOrEqual(12_288);
    }
  });

  it('moves an individually unfit item aside and continues without an empty batch or loop', () => {
    const tooLarge = item('too-large', {
      title: `测试装备有限公司${'不可截断标题'.repeat(2_000)}`,
      summary: null,
      content: null,
    });
    const fitting = item('fitting');

    const plan = planArkBatches(bundle([tooLarge, fitting]), 12_288, serializedBytes);

    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.bundle.items.map(entry => entry.evidenceId)).toEqual(['fitting']);
    expect(plan.unplannedItems.map(entry => entry.evidenceId)).toEqual(['too-large']);
  });

  it('does not repeat source gaps in Ark batches', () => {
    const input = {
      ...bundle([item('evidence-1')]),
      gaps: ['年报信息获取失败', '融资信息获取失败'],
    };

    const plan = planArkBatches(input, 12_288, serializedBytes);

    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.bundle.gaps).toEqual([]);
  });
});
