import { describe, expect, it } from 'vitest';
import {
  GetContactsOutputSchema,
  type ContactExtractionCandidate,
} from '../src/contracts/index.js';
import { ContactLookupError, ContactService } from '../src/contacts/contact-service.js';
import { UpstreamError } from '../src/orchestration/retry.js';
import { ContactExtractor } from '../src/upstream/ark/contact-extractor.js';
import type { DoubaoWebResult } from '../src/upstream/search/mapper.js';
import { buildContactSearchPlan } from '../src/upstream/search/contact-search-plan.js';

describe('contact contracts and search plan', () => {
  it('builds exactly two bounded public-source queries', () => {
    const plan = buildContactSearchPlan('测试制造', '上海');

    expect(plan).toHaveLength(2);
    expect(plan.every(item => item.Query.includes('测试制造'))).toBe(true);
    expect(plan.every(item => item.Query.includes('上海'))).toBe(true);
    expect(plan.every(item => item.Query.length <= 100)).toBe(true);
    expect(plan.every(item => item.SearchType === 'web')).toBe(true);
    expect(plan.every(item => item.Count === 10)).toBe(true);
    expect(plan.every(item => item.Filter.NeedUrl && item.Filter.NeedContent)).toBe(true);
  });

  it('normalizes optional region and omits it when absent', () => {
    const withRegion = buildContactSearchPlan('  测试制造  ', '  上海  ');
    const withoutRegion = buildContactSearchPlan('测试制造');

    expect(withRegion.every(item => item.Query.includes('测试制造 上海'))).toBe(true);
    expect(withoutRegion.every(item => !item.Query.includes('上海'))).toBe(true);
  });

  it('rejects direct contact details and internal classifications from public output', () => {
    const output = {
      companies: [{
        company_name: '测试制造有限公司',
        contacts: [{
          name: '张三',
          title: '研发总监',
          source_url: 'https://example.cn/a',
          published_at: null,
        }],
      }],
      warnings: [],
      collected_at: '2026-09-04T12:00:00.000Z',
    };

    expect(GetContactsOutputSchema.parse(output)).toEqual(output);
    expect(GetContactsOutputSchema.safeParse({
      ...output,
      companies: [{
        ...output.companies[0],
        contacts: [{ ...output.companies[0].contacts[0], email: 'zhang@example.cn' }],
      }],
    }).success).toBe(false);
    expect(GetContactsOutputSchema.safeParse({
      ...output,
      companies: [{
        ...output.companies[0],
        contacts: [{ ...output.companies[0].contacts[0], name: '张三 １３８００００００００' }],
      }],
    }).success).toBe(false);
    expect(GetContactsOutputSchema.safeParse({
      ...output,
      companies: [{
        ...output.companies[0],
        contacts: [{ ...output.companies[0].contacts[0], title: '研发总监 zhang＠example．cn' }],
      }],
    }).success).toBe(false);
    expect(GetContactsOutputSchema.safeParse({
      ...output,
      companies: [{
        ...output.companies[0],
        contacts: [{ ...output.companies[0].contacts[0], role_category: 'executive' }],
      }],
    }).success).toBe(false);
    expect(GetContactsOutputSchema.safeParse({
      ...output,
      companies: [{
        ...output.companies[0],
        contacts: [{ ...output.companies[0].contacts[0], name: '张三 13800000000' }],
      }],
    }).success).toBe(false);
    expect(GetContactsOutputSchema.safeParse({
      ...output,
      companies: [{
        ...output.companies[0],
        contacts: [{ ...output.companies[0].contacts[0], title: '研发总监 zhang@example.cn' }],
      }],
    }).success).toBe(false);
  });
});

const collectedAt = '2026-09-04T12:00:00.000Z';

function webResult(overrides: Partial<DoubaoWebResult> = {}): DoubaoWebResult {
  return {
    title: '测试制造有限公司研发团队',
    url: 'https://example.cn/team',
    originalPublisher: '测试制造官网',
    originalDomain: 'example.cn',
    summary: '测试制造有限公司研发总监张三介绍研发规划。',
    content: '测试制造有限公司研发总监张三负责技术研发。',
    publishedAt: '2026-08-01T00:00:00.000Z',
    position: 1,
    logId: 'log-1',
    ...overrides,
  };
}

function candidate(overrides: Partial<ContactExtractionCandidate> = {}): ContactExtractionCandidate {
  return {
    companyName: '测试制造有限公司',
    name: '张三',
    title: '研发总监',
    roleCategory: 'research_and_development',
    sourceType: 'official_website',
    sourceUrl: 'https://example.cn/team',
    ...overrides,
  };
}

function service(options: {
  searches: Array<DoubaoWebResult[] | Error>;
  extracted?: ContactExtractionCandidate[] | Error;
}) {
  let searchIndex = 0;
  return new ContactService({
    searchClient: {
      searchWeb: async () => {
        const value = options.searches[searchIndex++] ?? [];
        if (value instanceof Error) throw value;
        return value;
      },
    },
    extractor: {
      extract: async () => {
        const value = options.extracted ?? [];
        if (value instanceof Error) throw value;
        return {
          contacts: value,
          selection: { totalPages: 0, includedPages: 0, textTruncated: false },
        };
      },
    },
    now: () => new Date(collectedAt),
  });
}

describe('ContactService', () => {
  it('returns only candidates supported by the same searched page', async () => {
    const thirdParty = webResult({
      title: '测试制造有限公司人员信息',
      url: 'https://jobs.example.net/person',
      originalPublisher: '第三方招聘平台',
      originalDomain: 'jobs.example.net',
      summary: '测试制造有限公司研发总监王五负责技术研发。',
      content: null,
      position: 2,
    });
    const ordinaryEngineer = webResult({
      title: '测试制造有限公司官网技术团队',
      url: 'https://example.cn/engineer',
      summary: '测试制造有限公司技术工程师赵六参与研发。',
      content: null,
      position: 3,
    });
    const embeddedPhone = webResult({
      title: '测试制造有限公司官网管理团队',
      url: 'https://example.cn/leak',
      summary: '测试制造有限公司研发总监王七 13800000000负责研发。',
      content: null,
      position: 4,
    });
    const result = await service({
      searches: [[webResult(), thirdParty, ordinaryEngineer, embeddedPhone], []],
      extracted: [
        candidate(),
        candidate({ name: '李四' }),
        candidate({ sourceUrl: 'https://invented.example/contact' }),
        candidate({ name: '王五', sourceUrl: thirdParty.url }),
        candidate({ name: '赵六', title: '技术工程师', sourceUrl: ordinaryEngineer.url }),
        candidate({ name: '王七 13800000000', sourceUrl: embeddedPhone.url }),
      ],
    }).get({ query: '测试制造' });

    expect(result).toEqual({
      companies: [{
        companyName: '测试制造有限公司',
        contacts: [{
          name: '张三', title: '研发总监', sourceUrl: 'https://example.cn/team',
          publishedAt: '2026-08-01T00:00:00.000Z',
        }],
      }],
      warnings: [],
      collectedAt,
    });
  });

  it('returns partial results with a safe warning when one search fails', async () => {
    const result = await service({
      searches: [
        [webResult()],
        new UpstreamError('doubao_search', 'AUTHENTICATION_ERROR', 'secret upstream detail'),
      ],
      extracted: [candidate()],
    }).get({ query: '测试制造' });

    expect(result.companies).toHaveLength(1);
    expect(result.warnings).toEqual(['部分公开网页搜索失败，结果可能不完整']);
    expect(JSON.stringify(result)).not.toContain('secret upstream detail');
  });

  it('fails safely when all searches fail or extraction fails', async () => {
    const failedSearch = new UpstreamError('doubao_search', 'AUTHENTICATION_ERROR', 'private detail');
    await expect(service({ searches: [failedSearch, failedSearch] }).get({ query: '测试制造' }))
      .rejects.toEqual(expect.objectContaining({
        name: 'ContactLookupError', message: '公开联系人查询暂不可用，请稍后重试',
      }));

    await expect(service({
      searches: [[webResult()], []],
      extracted: new UpstreamError('ark', 'INVALID_JSON', 'raw model output'),
    }).get({ query: '测试制造' })).rejects.toBeInstanceOf(ContactLookupError);
  });

  it('deduplicates normalized contacts and enforces company and contact limits', async () => {
    const pages = Array.from({ length: 35 }, (_, index) => webResult({
      title: `公司${Math.floor(index / 11)} 技术总监 人员${index}`,
      url: `https://example.cn/${index}`,
      originalPublisher: `公司${Math.floor(index / 11)}官网`,
      summary: `公司${Math.floor(index / 11)} 技术总监 人员${index}`,
      content: null,
      position: index + 1,
    }));
    const extracted = pages.map((page, index) => candidate({
      companyName: `公司${Math.floor(index / 11)}`,
      name: `人员${index}`,
      title: '技术总监',
      sourceUrl: page.url,
    }));
    extracted.unshift(candidate(), candidate({ companyName: ' 测试制造有限公司 ', name: ' 张三 ' }));

    const result = await service({ searches: [pages.concat(webResult()), []], extracted })
      .get({ query: '公司' });

    expect(result.companies).toHaveLength(3);
    expect(result.companies.every(company => company.contacts.length <= 10)).toBe(true);
    expect(result.companies.flatMap(company => company.contacts)
      .filter(contact => contact.name.trim() === '张三')).toHaveLength(1);
  });

  it('returns a normal empty result when searches succeed without qualified contacts', async () => {
    const result = await service({ searches: [[], []], extracted: [] }).get({ query: '测试制造' });

    expect(result).toEqual({
      companies: [],
      warnings: ['未发现满足证据要求的关键岗位人员'],
      collectedAt,
    });
  });

  it('warns when the extractor must truncate searched page material', async () => {
    const result = await new ContactService({
      searchClient: { searchWeb: async () => [webResult()] },
      extractor: {
        extract: async () => ({
          contacts: [candidate()],
          selection: { totalPages: 2, includedPages: 2, textTruncated: true },
        }),
      },
      now: () => new Date(collectedAt),
    }).get({ query: '测试制造' });

    expect(result.warnings).toContain('部分搜索页面或正文因模型输入容量限制未进入抽取');
  });

  it('allows four search attempts without consuming two reserved Ark attempts', async () => {
    const searchAttempts = new Map<string, number>();
    let arkAttempts = 0;
    const result = await new ContactService({
      searchClient: {
        searchWeb: async query => {
          const intent = query.Query.includes('招投标') ? 'documents' : 'official';
          const attempts = (searchAttempts.get(intent) ?? 0) + 1;
          searchAttempts.set(intent, attempts);
          if (attempts === 1) {
            throw new UpstreamError('doubao_search', 'REMOTE_SERVER_ERROR', 'retry');
          }
          return intent === 'official' ? [webResult()] : [];
        },
      },
      extractor: {
        extract: async () => {
          arkAttempts += 1;
          if (arkAttempts === 1) throw new UpstreamError('ark', 'NETWORK_ERROR', 'retry');
          return {
            contacts: [candidate()],
            selection: { totalPages: 1, includedPages: 1, textTruncated: false },
          };
        },
      },
      now: () => new Date(collectedAt),
    }).get({ query: '测试制造' });

    expect([...searchAttempts.values()].reduce((sum, attempts) => sum + attempts, 0)).toBe(4);
    expect(arkAttempts).toBe(2);
    expect(result.companies).toHaveLength(1);
  });

  it('accepts a published CTO as a technology leader', async () => {
    const page = webResult({
      title: '测试制造有限公司官网管理团队',
      summary: '测试制造有限公司CTO李四负责技术研发。',
    });
    const result = await service({
      searches: [[page], []],
      extracted: [candidate({ name: '李四', title: 'CTO' })],
    }).get({ query: '测试制造' });

    expect(result.companies[0]?.contacts[0]?.title).toBe('CTO');
  });

  it.each([
    ['official_website', 'example.cn', '测试制造官网', '测试制造有限公司研发总监张三负责研发。'],
    ['official_news', 'example.cn', '测试制造官方', '测试制造有限公司新闻：研发总监张三发布规划。'],
    ['official_wechat', 'mp.weixin.qq.com', '微信公众平台', '测试制造有限公司研发总监张三负责研发。'],
    ['tender', 'tender.example.cn', '采购公告平台', '招标公告：测试制造有限公司研发总监张三负责项目。'],
    ['patent', 'patent.example.cn', '专利平台', '专利文件记载测试制造有限公司研发总监张三。'],
    ['conference', 'conference.example.cn', '行业会议', '峰会嘉宾：测试制造有限公司研发总监张三。'],
  ] as const)('accepts supported %s evidence', async (sourceType, domain, publisher, summary) => {
    const page = webResult({
      url: `https://${domain}/source`, originalDomain: domain,
      originalPublisher: publisher, summary, content: null,
    });
    const result = await service({
      searches: [[page], []],
      extracted: [candidate({ sourceType, sourceUrl: page.url })],
    }).get({ query: '测试制造' });

    expect(result.companies[0]?.contacts).toHaveLength(1);
  });

  it('accepts a known official-news publisher without treating its domain as a company website', async () => {
    const page = webResult({
      url: 'https://www.jwview.com/story', originalDomain: 'www.jwview.com',
      originalPublisher: '中新经纬',
      summary: '测试制造有限公司创始人、CEO张三介绍产品研发规划。', content: null,
    });
    const result = await service({
      searches: [[page], []],
      extracted: [candidate({
        title: '创始人、CEO', roleCategory: 'executive', sourceType: 'official_news', sourceUrl: page.url,
      })],
    }).get({ query: '测试制造' });

    expect(result.companies[0]?.contacts).toHaveLength(1);
  });

  it('accepts an approved official-news publisher on one of its subdomains', async () => {
    const page = webResult({
      url: 'https://m.jwview.com/story', originalDomain: 'm.jwview.com',
      originalPublisher: '中新经纬',
      summary: '测试制造有限公司创始人、CEO张三介绍产品研发规划。', content: null,
    });
    const result = await service({
      searches: [[page], []],
      extracted: [candidate({
        title: '创始人、CEO', roleCategory: 'executive', sourceType: 'official_news', sourceUrl: page.url,
      })],
    }).get({ query: '测试制造' });

    expect(result.companies[0]?.contacts).toHaveLength(1);
  });

  it('rejects a lookalike domain for an official-news publisher', async () => {
    const page = webResult({
      url: 'https://jwview.com.example.net/story', originalDomain: 'jwview.com.example.net',
      originalPublisher: '中新经纬',
      summary: '测试制造有限公司创始人、CEO张三介绍产品研发规划。', content: null,
    });
    const result = await service({
      searches: [[page], []],
      extracted: [candidate({
        title: '创始人、CEO', roleCategory: 'executive', sourceType: 'official_news', sourceUrl: page.url,
      })],
    }).get({ query: '测试制造' });

    expect(result.companies).toEqual([]);
  });

  it('determines an allowed source from page metadata instead of trusting the model label', async () => {
    const page = webResult();
    const result = await service({
      searches: [[page], []],
      extracted: [candidate({ sourceType: 'patent' })],
    }).get({ query: '测试制造' });

    expect(result.companies[0]?.contacts).toHaveLength(1);
  });

  it('rejects patent inventors and tender contacts without a published title', async () => {
    const patent = webResult({
      url: 'https://patent.example.cn/a', originalDomain: 'patent.example.cn',
      originalPublisher: '专利平台', summary: '测试制造有限公司专利发明人张三。', content: null,
    });
    const tender = webResult({
      url: 'https://tender.example.cn/a', originalDomain: 'tender.example.cn',
      originalPublisher: '招标平台', summary: '测试制造有限公司招标联系人张三。', content: null,
    });
    const result = await service({
      searches: [[patent, tender], []],
      extracted: [
        candidate({ sourceType: 'patent', sourceUrl: patent.url }),
        candidate({ sourceType: 'tender', sourceUrl: tender.url }),
      ],
    }).get({ query: '测试制造' });

    expect(result.companies).toEqual([]);
  });

  it.each([
    ['executive', '总经理助理'],
    ['research_and_development', '技术总监助理'],
    ['digital_and_it', '信息化经理助理'],
    ['procurement', '采购经理助理'],
    ['quality', '质量经理秘书'],
    ['executive', '总经理办公室主任'],
    ['executive', '总裁办主任'],
  ] as const)('rejects subordinate %s title %s', async (roleCategory, title) => {
    const page = webResult({ summary: `测试制造有限公司${title}张三负责支持工作。`, content: null });
    const result = await service({
      searches: [[page], []],
      extracted: [candidate({ title, roleCategory })],
    }).get({ query: '测试制造' });

    expect(result.companies).toEqual([]);
  });
});

describe('ContactExtractor', () => {
  it('requests strict JSON and extracts only the internal contact fields', async () => {
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      expect(request.messages[0]?.content).toContain('不得输出邮箱、电话');
      expect(request.messages[0]?.content).toContain('没有明确职位');
      expect(request.messages[0]?.content).toContain('专利');
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ contacts: [candidate()] }) } }],
      }), { status: 200 });
    };
    const extractor = new ContactExtractor({
      url: 'https://ark.example.cn/chat', model: 'test-model', credential: 'secret', fetchFn,
    });

    await expect(extractor.extract([{ ...webResult(), queryIndex: 0 }])).resolves.toMatchObject({
      contacts: [candidate()],
      selection: { totalPages: 1, includedPages: 1, textTruncated: false },
    });
  });

  it('rejects model output containing direct contact details', async () => {
    const fetchFn = async (): Promise<Response> => new Response(JSON.stringify({
      choices: [{
        message: { content: JSON.stringify({ contacts: [{ ...candidate(), phone: '13800000000' }] }) },
      }],
    }), { status: 200 });
    const extractor = new ContactExtractor({
      url: 'https://ark.example.cn/chat', model: 'test-model', credential: 'secret', fetchFn,
    });

    await expect(extractor.extract([{ ...webResult(), queryIndex: 0 }])).rejects.toMatchObject({
      source: 'ark', code: 'INVALID_CONTACTS',
    });
  });

  it('keeps the serialized request within the configured byte budget', async () => {
    let observedBytes = 0;
    let observedBody = '';
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      observedBody = String(init?.body);
      observedBytes = Buffer.byteLength(observedBody, 'utf8');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"contacts":[]}' } }],
      }), { status: 200 });
    };
    const extractor = new ContactExtractor({
      url: 'https://ark.example.cn/chat', model: 'test-model', credential: 'secret',
      requestMaxBytes: 6_144, fetchFn,
    });
    const large = Array.from({ length: 20 }, (_, index) => ({
      ...webResult({ url: `https://example.cn/${index}`, content: '技术负责人'.repeat(1_000) }),
      queryIndex: index % 2,
    }));

    const result = await extractor.extract(large);
    const request = JSON.parse(observedBody) as { messages: Array<{ content: string }> };
    const user = JSON.parse(request.messages[1]?.content ?? '{}') as { pages: unknown[] };

    expect(observedBytes).toBeLessThanOrEqual(6_144);
    expect(observedBytes).toBeGreaterThan(0);
    expect(user.pages.length).toBeLessThan(20);
    expect(result.selection).toEqual({
      totalPages: 20,
      includedPages: user.pages.length,
      textTruncated: true,
    });
  });

  it('reserves useful body context for selected high-ranked pages instead of thinning every page', async () => {
    let observedBody = '';
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      observedBody = String(init?.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"contacts":[]}' } }],
      }), { status: 200 });
    };
    const extractor = new ContactExtractor({
      url: 'https://ark.example.cn/chat', model: 'test-model', credential: 'secret',
      requestMaxBytes: 12_288, fetchFn,
    });
    const pages = Array.from({ length: 20 }, (_, index) => ({
      ...webResult({
        title: '测试制造有限公司关键岗位公开资料页面'.repeat(2),
        url: `https://example.cn/very-long-source-path/${'a'.repeat(70)}/${index}`,
        originalPublisher: '测试制造有限公司官方新闻发布',
        summary: '测试制造有限公司研发总监张三负责技术研发。'.repeat(100),
        content: '测试制造有限公司研发总监张三负责技术研发。'.repeat(200),
      }),
      queryIndex: index < 10 ? 0 : 1,
      position: (index % 10) + 1,
    }));

    const result = await extractor.extract(pages);
    const request = JSON.parse(observedBody) as { messages: Array<{ content: string }> };
    const sent = JSON.parse(request.messages[1]?.content ?? '{}') as {
      pages: Array<{ queryIndex: number; position: number; text: string }>;
    };

    expect(result.selection).toMatchObject({ totalPages: 20, textTruncated: true });
    expect(sent.pages.length).toBeLessThan(20);
    expect(sent.pages.map(page => page.queryIndex)).toEqual(expect.arrayContaining([0, 1]));
    expect(sent.pages.filter(page => page.position === 1)).toHaveLength(2);
    expect(sent.pages.every(page => Buffer.byteLength(page.text, 'utf8') >= 768)).toBe(true);
  });

  it('skips an oversized page metadata record and retains a later useful page', async () => {
    let observedBody = '';
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      observedBody = String(init?.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"contacts":[]}' } }],
      }), { status: 200 });
    };
    const extractor = new ContactExtractor({
      url: 'https://ark.example.cn/chat', model: 'test-model', credential: 'secret',
      requestMaxBytes: 6_144, fetchFn,
    });
    const oversized = {
      ...webResult({
        url: `https://example.cn/${'a'.repeat(5_000)}`,
        content: '测试制造有限公司研发总监张三负责技术研发。'.repeat(100),
      }),
      queryIndex: 0,
    };
    const useful = {
      ...webResult({
        url: 'https://example.cn/useful',
        content: '测试制造有限公司研发总监张三负责技术研发。'.repeat(100),
      }),
      queryIndex: 1,
    };

    const result = await extractor.extract([oversized, useful]);
    const request = JSON.parse(observedBody) as { messages: Array<{ content: string }> };
    const sent = JSON.parse(request.messages[1]?.content ?? '{}') as { pages: Array<{ url: string }> };

    expect(result.selection).toEqual({ totalPages: 2, includedPages: 1, textTruncated: true });
    expect(sent.pages.map(page => page.url)).toEqual([useful.url]);
  });

  it('orders each query bucket by search rank before interleaving them', async () => {
    let observedBody = '';
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      observedBody = String(init?.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"contacts":[]}' } }],
      }), { status: 200 });
    };
    const extractor = new ContactExtractor({
      url: 'https://ark.example.cn/chat', model: 'test-model', credential: 'secret',
      requestMaxBytes: 6_144, fetchFn,
    });
    const pages = [
      { ...webResult({ url: 'https://example.cn/1-2', content: '研发负责人'.repeat(200), position: 2 }), queryIndex: 1 },
      { ...webResult({ url: 'https://example.cn/0-2', content: '研发负责人'.repeat(200), position: 2 }), queryIndex: 0 },
      { ...webResult({ url: 'https://example.cn/1-1', content: '研发负责人'.repeat(200), position: 1 }), queryIndex: 1 },
      { ...webResult({ url: 'https://example.cn/0-1', content: '研发负责人'.repeat(200), position: 1 }), queryIndex: 0 },
    ];

    await extractor.extract(pages);
    const request = JSON.parse(observedBody) as { messages: Array<{ content: string }> };
    const sent = JSON.parse(request.messages[1]?.content ?? '{}') as {
      pages: Array<{ queryIndex: number; position: number }>;
    };

    expect(sent.pages.map(page => [page.queryIndex, page.position])).toEqual([
      [0, 1], [1, 1], [0, 2], [1, 2],
    ]);
  });

  it.each([6_144, 12_288])('reports excluded pages for long metadata at %i bytes', async requestMaxBytes => {
    const fetchFn = async (): Promise<Response> => new Response(JSON.stringify({
      choices: [{ message: { content: '{"contacts":[]}' } }],
    }), { status: 200 });
    const extractor = new ContactExtractor({
      url: 'https://ark.example.cn/chat', model: 'test-model', credential: 'secret',
      requestMaxBytes, fetchFn,
    });
    const pages = Array.from({ length: 20 }, (_, index) => ({
      ...webResult({
        title: `测试制造有限公司超长页面标题${'研发负责人'.repeat(80)}${index}`,
        url: `https://example.cn/very-long-source-path/${index}`,
        originalPublisher: `测试制造有限公司${'官方发布'.repeat(40)}`,
        content: '技术负责人'.repeat(1_000),
      }),
      queryIndex: index % 2,
    }));

    const result = await extractor.extract(pages);

    expect(result.selection.totalPages).toBe(20);
    expect(result.selection.includedPages).toBeLessThan(20);
    expect(result.selection.textTruncated).toBe(true);
  });
});
