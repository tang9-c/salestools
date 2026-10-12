import { describe, expect, it, vi } from 'vitest';
import { CompanyAnswerClient } from '../src/upstream/ark/company-answer.js';
import { validateContextRefs } from '../src/companies/company-evidence.js';
import type { ContextMaterial } from '../src/companies/company-context-types.js';
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
  it('keeps both evidence themes inside a bounded request when source excerpts are long', async () => {
    let selected: Array<{ source: string; title: string }> = [];
    let bytes = 0;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const body = String(init?.body);
      bytes = Buffer.byteLength(body, 'utf8');
      selected = JSON.parse(JSON.parse(body).messages[1].content).items;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"claims":[]}' } }] }), { status: 200 });
    });
    const client = new CompanyAnswerClient({
      url: 'https://ark.example.cn/chat/completions', model: 'test-model', credential: 'secret',
      requestMaxBytes: 6_144, fetchFn,
    });
    const items = Array.from({ length: 20 }, (_, index) => ({
      ...item(index + 1), source: index % 2 === 0 ? 'qcc' as const : 'doubao_search' as const,
      title: index % 2 === 0 ? `测试公司招聘 ${index + 1}` : `测试公司产品发布 ${index + 1}`,
      excerpt: index % 2 === 0 ? '机器人工程师岗位要求'.repeat(50) : '机器人新品发布技术资料'.repeat(50),
    }));
    await client.answer({ legalName: '测试公司有限公司', question: '产品发布和招聘？', items, facts: [] });
    expect(bytes).toBeLessThanOrEqual(6_144);
    expect(selected.filter(entry => entry.source === 'qcc').length).toBeGreaterThanOrEqual(2);
    expect(selected.filter(entry => entry.source === 'doubao_search').length).toBeGreaterThanOrEqual(2);
    expect(selected.some(entry => entry.title.includes('招聘'))).toBe(true);
    expect(selected.some(entry => entry.title.includes('产品发布'))).toBe(true);
  });
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
    expect(requestBody).not.toContain('库内 context');
    expect(answer.claims).toEqual([{ category: 'supported', text: '岗位要求 SolidWorks', evidenceIds: ['web-1'] }]);
  });

  it.each([false, true])('keeps public themes and an atomic context path with longClient=%s', async (longClient) => {
    let requestBody = '';
    const context: ContextMaterial[] = [
      { citation: { ref: 'contact:client', source_type: 'contact', subject_id: 'project',
        quote: longClient ? '项目客户证据'.repeat(1000) : '项目客户为测试公司' },
        statement: '项目服务测试公司', source_key: 'file:one', predicate: 'clientOrganization', object: '测试公司' },
      { citation: { ref: 'contact:member', source_type: 'contact', subject_id: 'person', quote: '测试人是项目成员' },
        statement: '测试人参与项目', source_key: 'file:two', predicate: 'memberOf', object: '项目', required_context_refs: ['contact:client'] },
    ];
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      requestBody = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"claims":[]}' } }] }));
    });
    const client = new CompanyAnswerClient({ url: 'https://ark.example.cn/chat/completions', model: 'test-model',
      credential: 'secret', requestMaxBytes: 6_144, fetchFn });
    const result = await client.answer({ legalName: '测试公司有限公司', question: '招聘、产品发布和客户项目参与人', facts: [],
      items: [{ ...item(1), source: 'qcc', title: '测试公司招聘' }, { ...item(2), title: '测试公司产品发布' }], context });
    expect(Buffer.byteLength(requestBody, 'utf8')).toBeLessThanOrEqual(6_144);
    const parsed = JSON.parse(requestBody);
    expect(parsed.messages[0].content).toContain('人物经客户项目关联企业需同时引用成员与客户依据');
    const payload = JSON.parse(parsed.messages[1].content);
    expect(payload.items.map((value: SnapshotItem) => value.evidenceId)).toEqual(['web-1', 'web-2']);
    const expected = longClient ? [] : ['contact:client', 'contact:member'];
    expect(payload.context.map((value: ContextMaterial) => value.citation.ref)).toEqual(expected);
    expect(result.includedContextRefs).toEqual(expected);
    if (!longClient) {
      expect(validateContextRefs(expected, context)).toHaveLength(2);
      expect(() => validateContextRefs(['contact:member'], context)).toThrow();
    }
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
