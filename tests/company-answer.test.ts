import { describe, expect, it, vi } from 'vitest';
import { CompanyAnswerClient } from '../src/upstream/ark/company-answer.js';
import type { SnapshotItem } from '../src/contracts/index.js';

const at = '2026-09-24T00:00:00.000Z';
function item(index: number): SnapshotItem {
  return {
    evidenceId: `web-${index}`, source: 'doubao_search', sourceKind: 'web',
    title: `测试公司招聘 ${index}`, url: `https://example.cn/${index}`,
    originalPublisher: '官网', originalDomain: 'example.cn', publishedAt: at,
    collectedAt: at, mentionedName: '测试公司有限公司', entityScope: 'legal_entity',
    entityMatch: 'confirmed', matchBasis: ['法定名称一致'],
    excerpt: 'SolidWorks 工程师岗位要求'.repeat(16), excerptTruncated: false,
  };
}

describe('CompanyAnswerClient', () => {
  it('makes one bounded Ark request, reports omitted evidence, and returns only parsed claims', async () => {
    let bytes = 0;
    let requestBody = '';
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      requestBody = String(init?.body);
      bytes = Buffer.byteLength(requestBody, 'utf8');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        claims: [{ category: 'supported', text: '岗位要求 SolidWorks', evidenceIds: ['web-1'] }],
      }) } }] }), { status: 200 });
    });
    const client = new CompanyAnswerClient({
      url: 'https://ark.example.cn/chat/completions', model: 'test-model', credential: 'secret',
      requestMaxBytes: 2_200, fetchFn,
    });
    const answer = await client.answer({
      legalName: '测试公司有限公司', question: 'SolidWorks 招聘是什么？',
      items: Array.from({ length: 10 }, (_, index) => item(index + 1)), facts: [{
        factId: 'cross-source', statement: 'UNSEEN_CROSS_SOURCE_FACT', kind: 'recruitment',
        productTags: ['solidworks'], strength: 'direct', evidenceIds: ['web-1', 'web-10'],
        entityScope: 'legal_entity', entityMatch: 'confirmed', matchBasis: ['法定名称一致'],
      }],
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(bytes).toBeLessThanOrEqual(2_200);
    expect(answer.omittedCount).toBeGreaterThan(0);
    expect(answer.includedEvidenceIds).toContain('web-1');
    expect(answer.includedEvidenceIds).not.toContain('web-10');
    expect(requestBody).not.toContain('UNSEEN_CROSS_SOURCE_FACT');
    expect(answer.claims).toEqual([{ category: 'supported', text: '岗位要求 SolidWorks', evidenceIds: ['web-1'] }]);
  });

  it('rejects invalid Ark claims instead of rendering them', async () => {
    const client = new CompanyAnswerClient({
      url: 'https://ark.example.cn/chat/completions', model: 'test', credential: 'secret',
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        choices: [{ message: { content: '{"claims":[{"text":"无证据"}]}' } }],
      }), { status: 200 })),
    });
    await expect(client.answer({ legalName: '测试公司有限公司', question: '招聘？', items: [item(1)], facts: [] }))
      .rejects.toMatchObject({ code: 'INVALID_CLAIMS' });
  });
});
