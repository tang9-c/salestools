import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { IdentityProfile } from '../src/contracts/index.js';
import { UpstreamError } from '../src/orchestration/retry.js';
import { DoubaoSearchClient } from '../src/upstream/search/doubao-client.js';
import { buildSearchPlan, SearchQuerySchema } from '../src/upstream/search/search-plan.js';
import { mapDoubaoSearchResponse } from '../src/upstream/search/mapper.js';

const identity: IdentityProfile = {
  legalName: '测试制造有限公司',
  creditCode: '91310000TEST000001',
  formerNames: ['不应使用的曾用名'],
  aliases: ['测试制造'],
  englishNames: ['Unverified English Name'],
  brands: ['不应使用的品牌'],
  officialDomains: ['example.cn'],
  registeredAddress: null,
  parentLegalName: null,
  subsidiaryLegalNames: [],
};

function fixture(): unknown {
  return JSON.parse(readFileSync(new URL('./fixtures/doubao-search.json', import.meta.url), 'utf8'));
}

function searchPayload(result: Record<string, unknown>, logId?: string): unknown {
  return {
    Code: 0,
    Message: 'success',
    ...(logId === undefined ? {} : { LogId: logId }),
    Result: { WebResults: [{ Title: '网页结果', SortId: 1, ...result }] },
  };
}

describe('buildSearchPlan', () => {
  it('builds eight bounded deterministic web queries from only the confirmed legal name or aliases', () => {
    const first = buildSearchPlan(identity);
    const second = buildSearchPlan(identity);

    expect(second).toEqual(first);
    expect(first).toHaveLength(8);
    for (const query of first) {
      expect(SearchQuerySchema.parse(query)).toEqual(query);
      expect(query.Query.length).toBeGreaterThanOrEqual(1);
      expect(query.Query.length).toBeLessThanOrEqual(100);
      expect(query.SearchType).toBe('web');
      expect(query.Count).toBe(10);
      expect(query.Filter.NeedUrl).toBe(true);
      expect(query.subjectOfficialDomains).toEqual(identity.officialDomains);
      expect([identity.legalName, ...identity.aliases].some(name => query.Query.includes(name))).toBe(true);
      expect(query.Query).not.toContain(identity.formerNames[0]);
      expect(query.Query).not.toContain(identity.englishNames[0]);
      expect(query.Query).not.toContain(identity.brands[0]);
    }
  });

  it('splits all seven product recruitment signals across exactly two one-year content queries', () => {
    const plan = buildSearchPlan(identity);
    const recruitment = plan.filter(query => query.purpose === 'recruitment');

    expect(recruitment).toHaveLength(2);
    expect(recruitment.map(query => query.Query).join(' ')).toMatch(/Windchill/);
    expect(recruitment.map(query => query.Query).join(' ')).toMatch(/PLM/);
    expect(recruitment.map(query => query.Query).join(' ')).toMatch(/QMS/);
    expect(recruitment.map(query => query.Query).join(' ')).toMatch(/Creo/);
    expect(recruitment.map(query => query.Query).join(' ')).toMatch(/CATIA/);
    expect(recruitment.map(query => query.Query).join(' ')).toMatch(/Abaqus/);
    expect(recruitment.map(query => query.Query).join(' ')).toMatch(/CST/);
    expect(recruitment.map(query => query.Query).join(' ')).toMatch(/SolidWorks/);
    for (const query of recruitment) {
      expect(query.Filter).toEqual({ NeedUrl: true, NeedContent: true, TimeRange: 'OneYear' });
    }
  });

  it('omits TimeRange from every ordinary query', () => {
    const ordinary = buildSearchPlan(identity).filter(query => query.purpose !== 'recruitment');
    expect(ordinary).toHaveLength(6);
    for (const query of ordinary) {
      expect(query.Filter).not.toHaveProperty('TimeRange');
    }
  });

  it('requests content for engineering and software-ecosystem evidence without adding a time range', () => {
    const plan = buildSearchPlan(identity);
    expect(plan.find(query => query.purpose === 'engineering')?.Filter).toEqual({
      NeedUrl: true, NeedContent: true,
    });
    expect(plan.find(query => query.purpose === 'software_ecosystem')?.Filter).toEqual({
      NeedUrl: true, NeedContent: true,
    });
  });

  it('defaults Count to 10 and rejects invalid query or Count values', () => {
    const valid = buildSearchPlan(identity)[0];
    const { Count: _count, ...withoutCount } = valid;
    expect(SearchQuerySchema.parse(withoutCount).Count).toBe(10);
    expect(SearchQuerySchema.safeParse({ ...valid, Count: 51 }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ ...valid, Query: '' }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ ...valid, Query: '测'.repeat(101) }).success).toBe(false);
  });
});

describe('DoubaoSearchClient', () => {
  it('performs one POST attempt and maps the official response fields into ResearchItem', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new DoubaoSearchClient({
      url: 'https://open.feedcoopapi.com/search_api/web_search',
      apiKey: 'test-search-key',
      fetchFn,
      now: () => new Date('2026-08-29T12:00:00.000Z'),
    });
    const query = buildSearchPlan(identity)[4];

    const items = await client.search(query);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://open.feedcoopapi.com/search_api/web_search');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer test-search-key', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      Query: query.Query,
      SearchType: 'web',
      Count: 10,
      Filter: { NeedUrl: true, NeedContent: true, TimeRange: 'OneYear' },
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      evidenceId: 'doubao-doubao-log-123-1',
      source: 'doubao_search',
      sourceKind: 'web',
      title: '测试制造有限公司招聘 Creo 机械设计工程师',
      url: 'https://jobs.example.cn/positions/creo-engineer',
      originalPublisher: '测试制造招聘官网',
      originalDomain: 'jobs.example.cn',
      summary: '岗位负责参数化机械设计。',
      content: '测试制造有限公司正在招聘 Creo 机械设计工程师。',
      publishedAt: '2026-08-28T09:30:00.000Z',
      collectedAt: '2026-08-29T12:00:00.000Z',
      mentionedName: identity.legalName,
      entityScope: 'legal_entity',
      entityMatch: 'confirmed',
      matchBasis: ['网页内容提及已确认法定名称'],
      query: query.Query,
      position: 1,
      logId: 'doubao-log-123',
    });
    expect(items[1]).toMatchObject({
      originalPublisher: null,
      originalDomain: 'news.example.net',
      summary: null,
      content: null,
      publishedAt: null,
      position: 2,
      logId: 'doubao-log-123',
    });
    expect(client.search.length).toBe(1);
  });

  it('uses a stable Query-and-URL hash when LogId is absent without embedding source content', () => {
    const [firstQuery, secondQuery] = buildSearchPlan(identity);
    const firstPayload = searchPayload({ Url: 'https://news.example.net/item' });
    const otherUrlPayload = searchPayload({ Url: 'https://news.example.net/other-item' });
    const now = new Date('2026-08-29T12:00:00.000Z');

    const first = mapDoubaoSearchResponse(firstPayload, firstQuery, now)[0].evidenceId;
    const repeat = mapDoubaoSearchResponse(firstPayload, firstQuery, now)[0].evidenceId;
    const otherQuery = mapDoubaoSearchResponse(firstPayload, secondQuery, now)[0].evidenceId;
    const otherUrl = mapDoubaoSearchResponse(otherUrlPayload, firstQuery, now)[0].evidenceId;

    expect(first).toBe(repeat);
    expect(new Set([first, otherQuery, otherUrl])).toHaveLength(3);
    expect(first).toMatch(/^doubao-sha256-[0-9a-f]{24}$/);
    expect(first).not.toContain(firstQuery.Query);
    expect(first).not.toContain('news.example.net');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/plain,company',
    'mailto:sales@example.cn',
    'https://user:password@example.cn/private',
  ])('rejects unsafe result URL %s as a typed invalid response', url => {
    expect(() => mapDoubaoSearchResponse(
      searchPayload({ Url: url }),
      buildSearchPlan(identity)[0],
      new Date('2026-08-29T12:00:00.000Z'),
    )).toThrow(expect.objectContaining({
      name: 'UpstreamError', source: 'doubao_search', code: 'INVALID_RESPONSE',
    }));
  });

  it('confirms a result on an official domain even when the page omits the company name', () => {
    const item = mapDoubaoSearchResponse(
      searchPayload({ Url: 'https://www.example.cn/products', Content: '产品与技术中心' }),
      buildSearchPlan(identity)[0],
      new Date('2026-08-29T12:00:00.000Z'),
    )[0];

    expect(item).toMatchObject({
      entityScope: 'legal_entity', entityMatch: 'confirmed',
      matchBasis: ['URL 域名匹配已确认官网域名'],
    });
  });

  it('keeps a verified alias alone unverified', () => {
    const item = mapDoubaoSearchResponse(
      searchPayload({ Url: 'https://news.example.net/item', Title: '测试制造发布新产品' }),
      buildSearchPlan(identity)[0],
      new Date('2026-08-29T12:00:00.000Z'),
    )[0];

    expect(item).toMatchObject({
      mentionedName: '测试制造', entityScope: 'unknown', entityMatch: 'unverified',
      matchBasis: ['网页仅提及已验证简称，缺少额外身份依据'],
    });
  });

  it('marks an alias probable only with the exact confirmed registered address', () => {
    const identityWithAddress = { ...identity, registeredAddress: '上海市浦东新区测试路1号' };
    const item = mapDoubaoSearchResponse(
      searchPayload({
        Url: 'https://news.example.net/item',
        Title: '测试制造招聘公告',
        Content: '办公地址：上海市浦东新区测试路1号',
      }),
      buildSearchPlan(identityWithAddress)[0],
      new Date('2026-08-29T12:00:00.000Z'),
    )[0];

    expect(item).toMatchObject({
      mentionedName: '测试制造', entityScope: 'legal_entity', entityMatch: 'probable',
      matchBasis: ['网页提及已验证简称', '网页同时包含已确认注册地址'],
    });
  });

  it('keeps a result with no known name or official domain unverified', () => {
    const item = mapDoubaoSearchResponse(
      searchPayload({ Url: 'https://unrelated.example.net/item', Content: '某制造企业动态' }),
      buildSearchPlan(identity)[0],
      new Date('2026-08-29T12:00:00.000Z'),
    )[0];

    expect(item).toMatchObject({ entityScope: 'unknown', entityMatch: 'unverified' });
  });

  it.each([
    [401, 'AUTHENTICATION_ERROR'],
    [403, 'AUTHENTICATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [503, 'REMOTE_SERVER_ERROR'],
  ] as const)('maps HTTP %s to typed %s without retrying', async (status, code) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }));
    const client = new DoubaoSearchClient({
      url: 'https://open.feedcoopapi.com/search_api/web_search', apiKey: 'test-key', fetchFn,
    });

    await expect(client.search(buildSearchPlan(identity)[0])).rejects.toEqual(
      expect.objectContaining<Partial<UpstreamError>>({ source: 'doubao_search', code }),
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ Code: 1001, Message: 'QPS limit exceeded', Result: null }, 'RATE_LIMITED'],
    [{ Code: 1002, Message: 'quota exhausted', Result: null }, 'QUOTA_EXCEEDED'],
    [{ Code: 1003, Message: 'invalid api key', Result: null }, 'AUTHENTICATION_ERROR'],
    [{ Code: 1999, Message: 'bad parameter', Result: null }, 'REMOTE_BUSINESS_ERROR'],
  ] as const)('maps business errors to typed errors without retrying', async (payload, code) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    const client = new DoubaoSearchClient({
      url: 'https://open.feedcoopapi.com/search_api/web_search', apiKey: 'test-key', fetchFn,
    });

    await expect(client.search(buildSearchPlan(identity)[0])).rejects.toMatchObject({
      name: 'UpstreamError', source: 'doubao_search', code,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('turns network and malformed responses into typed one-attempt failures', async () => {
    const networkFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket reset'));
    const malformedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('{bad json', { status: 200 }));
    const query = buildSearchPlan(identity)[0];

    await expect(new DoubaoSearchClient({
      url: 'https://open.feedcoopapi.com/search_api/web_search', apiKey: 'test-key', fetchFn: networkFetch,
    }).search(query)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(new DoubaoSearchClient({
      url: 'https://open.feedcoopapi.com/search_api/web_search', apiKey: 'test-key', fetchFn: malformedFetch,
    }).search(query)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(networkFetch).toHaveBeenCalledTimes(1);
    expect(malformedFetch).toHaveBeenCalledTimes(1);
  });
});
