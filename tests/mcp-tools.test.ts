import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ContactService } from '../src/contacts/contact-service.js';
import {
  AssessmentIdInputSchema,
  AssessmentReportInputSchema,
  AskCompanyInputSchema,
  CompanyProfileInputSchema,
  GetContactsInputSchema,
  SubmitAssessmentInputSchema,
} from '../src/mcp/tool-schemas.js';
import {
  buildMcpServer,
  type AssessmentReportServiceOutput,
  type AssessmentStatusServiceOutput,
  type CompanyProfileServiceOutput,
  type ContactServiceOutput,
  type McpServices,
  type SubmitAssessmentServiceOutput,
} from '../src/mcp/tools.js';

const assessmentId = '10bd94c4-724a-4ca9-87fb-f474f563d475';
const collectedAt = '2026-08-29T12:00:00.000Z';
const profile: CompanyProfileServiceOutput = {
  sourceStatus: 'completed',
  candidates: [{
    legalName: '测试制造有限公司', creditCode: '91310000TEST000001', status: null,
    registeredAddress: null, matchReason: '统一社会信用代码匹配',
  }],
  basicProfile: {
    industry: '制造业', region: '上海', companyType: null, foundedYear: 2020,
    registeredCapital: null, legalRepresentative: null, website: null,
    employeeRange: null, riskSummary: null, collectedAt,
  },
  cacheHit: false,
};
const expectedProfile = {
  source_status: 'completed',
  candidates: [{
    legal_name: '测试制造有限公司', credit_code: '91310000TEST000001', status: null,
    registered_address: null, match_reason: '统一社会信用代码匹配',
  }],
  basic_profile: {
    industry: '制造业', region: '上海', company_type: null, founded_year: 2020,
    registered_capital: null, legal_representative: null, website: null,
    employee_range: null, risk_summary: null, collected_at: collectedAt,
  },
  cache_hit: false,
};
const submit: SubmitAssessmentServiceOutput = {
  assessmentId, status: 'processing', estimatedMinutes: '5-40', cacheHit: false,
};
const expectedSubmit = {
  assessment_id: assessmentId, status: 'processing', estimated_minutes: '5-40', cache_hit: false,
};
const status: AssessmentStatusServiceOutput = {
  assessmentId, status: 'processing', message: '正在处理',
};
const expectedStatus = {
  assessment_id: assessmentId, status: 'processing', message: '正在处理',
};
const report: AssessmentReportServiceOutput = {
  assessmentId, status: 'completed', legalName: '测试制造有限公司',
  overallOpportunity: '中', recommendedProduct: null, collectedAt,
  dynamicSignalFreshness: 'current',
  sourceStatus: { qcc: 'completed', doubaoSearch: 'partial', ark: 'completed' },
  markdown: '# 报告',
};
const expectedReport = {
  assessment_id: assessmentId, status: 'completed', legal_name: '测试制造有限公司',
  overall_opportunity: '中', recommended_product: null, collected_at: collectedAt,
  dynamic_signal_freshness: 'current',
  source_status: { qcc: 'completed', doubao_search: 'partial', ark: 'completed' },
  markdown: '# 报告',
};
const contacts: ContactServiceOutput = {
  webPage: { snapshotId: 7, offset: 0, limit: 50, total: 2, nextOffset: null },
  webCoverage: null,
  companies: [{
    companyName: '测试制造有限公司',
    contacts: [{
      name: '张三', title: '研发总监', sourceUrl: 'https://example.cn/team',
      publishedAt: collectedAt,
    }],
    historicalContacts: [{
      name: '李四', title: '技术总监', sourceUrl: 'https://example.cn/old-team',
      publishedAt: null, firstSeenAt: '2025-01-01T00:00:00.000Z',
      lastSeenAt: '2025-06-01T00:00:00.000Z', status: 'historical_evidence',
    }],
  }],
  warnings: [],
  collectedAt,
};
const expectedContacts = {
  web_page: { snapshot_id: 7, offset: 0, limit: 50, total: 2, next_offset: null },
  web_coverage: null,
  companies: [{
    company_name: '测试制造有限公司',
    contacts: [{
      name: '张三', title: '研发总监', source_url: 'https://example.cn/team',
      published_at: collectedAt,
    }],
    historical_contacts: [{
      name: '李四', title: '技术总监', source_url: 'https://example.cn/old-team',
      published_at: null, first_seen_at: '2025-01-01T00:00:00.000Z',
      last_seen_at: '2025-06-01T00:00:00.000Z', status: 'historical_evidence',
    }],
  }],
  warnings: [],
  collected_at: collectedAt,
};
const companyAnswer = {
  status: 'answered' as const, legalName: '测试制造有限公司',
  markdown: '# 招聘证据说明', usedFreshResearch: false, collectedAt,
  sources: [{ title: '招聘信息', source: 'qcc' as const, url: null, publishedAt: null }],
};
const expectedCompanyAnswer = {
  status: 'answered', legal_name: '测试制造有限公司', markdown: '# 招聘证据说明',
  used_fresh_research: false, collected_at: collectedAt,
  sources: [{ title: '招聘信息', source: 'qcc', url: null, published_at: null }],
};

function services(overrides: Partial<McpServices> = {}): McpServices {
  return {
    getCompanyProfile: async () => profile,
    submitAssessment: async () => submit,
    getAssessmentStatus: async () => status,
    getAssessmentReport: async () => report,
    getContacts: async () => contacts,
    askCompany: async () => companyAnswer,
    ...overrides,
  };
}

async function connectedClient(toolServices: McpServices) {
  const server = buildMcpServer(toolServices);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('MCP tool schemas', () => {
  it('shows a safe bound-page recovery error in all while retaining every Zoho contact', async () => {
    let calls = 0;
    const subject = new ContactService({ snapshots: { append: () => undefined, findFresh: () => null,
      findLatest: () => null, findAll: () => [], findThroughSnapshot: () => null },
      searchClient: { searchWeb: async () => { calls++; throw new Error('private upstream'); } },
      extractor: { extract: async () => { calls++; throw new Error('private model'); } } });
    const zoho = { status: 'completed' as const, complete: true, connections: [], warnings: [], collected_at: collectedAt,
      companies: [{ connection_id: 'crm_a', account_id: 'account', company_name: '另一公司', account_owner: null,
        contacts: Array.from({ length: 63 }, (_, i) => ({ record_id: String(i), name: `人物${i}`, title: null, contact_owner: null, modified_at: null })) }] };
    const connection = await connectedClient(services({ getContacts: input => subject.get(input),
      zohoContacts: { connectionIds: ['crm_a'], get: async () => zoho } }));
    try {
      const result = await connection.client.callTool({ name: 'discover_contacts', arguments: { query: '另一公司', source: 'all', web_snapshot_id: 7, web_offset: 50 } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ zoho });
      expect(JSON.stringify(result.content)).toContain('查询/地域不匹配');
      expect(JSON.stringify(result.content)).toContain('第 0 页重新发起');
      expect(JSON.stringify(result)).not.toMatch(/private upstream|private model/);
      expect(calls).toBe(0);
    } finally { await connection.client.close(); await connection.server.close(); }
  });
  it.each([false, true])('keeps all 63 Zoho contacts independent of web pagination (web fails: %s)', async fails => {
    const zoho = { status: 'completed' as const, complete: true, connections: [], warnings: [], collected_at: collectedAt,
      companies: [{ connection_id: 'crm_a', account_id: 'account', company_name: '示例公司', account_owner: null,
        contacts: Array.from({ length: 63 }, (_, i) => ({ record_id: String(i), name: `人物${i}`, title: null, contact_owner: null, modified_at: null })) }] };
    const connection = await connectedClient(services({ getContacts: async () => { if (fails) throw new Error('private'); return { ...contacts, webPage: { snapshotId: 7, offset: 50, limit: 1, total: 63, nextOffset: 51 } }; },
      zohoContacts: { connectionIds: ['crm_a'], get: async () => zoho } }));
    try {
      const result = await connection.client.callTool({ name: 'discover_contacts', arguments: { query: '示例公司', source: 'all', web_snapshot_id: 7, web_offset: 50, web_limit: 1 } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ zoho });
      if (fails) {
        expect(result.structuredContent).toMatchObject({ warnings: ['WEB_SOURCE_FAILED'], companies: [] });
        expect(JSON.stringify(result)).not.toContain('private');
      }
      expect(JSON.stringify(result.content)).toContain('公开网页联系人');
      expect(JSON.stringify(result.content)).toContain('Zoho');
    } finally { await connection.client.close(); await connection.server.close(); }
  });
  it('passes the bound continuation through MCP with readable observations and coverage', async () => {
    let observed: unknown;
    const connection = await connectedClient(services({ getContacts: async input => {
      observed = input;
      return { companies: [{ companyName: '示例公司', contacts: Array.from({ length: 13 }, (_, i) => ({
        name: `人物${i}`, title: null, sourceUrl: 'https://example.cn/team', publishedAt: null,
        affiliationStatus: 'unverified', evidenceQuote: '示例公司活动记录',
      })), historicalContacts: [] }], warnings: [], collectedAt,
      webPage: { snapshotId: 7, offset: 50, limit: 50, total: 63, nextOffset: null },
      webCoverage: { version: 2, total_pages: 4, total_chunks: 4, processed_chunks: 4, pending_pages: [], complete: true } };
    } }));
    try {
      const result = await connection.client.callTool({ name: 'discover_contacts', arguments: { query: '示例公司', source: 'web', web_snapshot_id: 7, web_offset: 50, web_limit: 50 } });
      expect(observed).toEqual({ query: '示例公司', webSnapshotId: 7, webOffset: 50, webLimit: 50 });
      expect(result.structuredContent).toMatchObject({ web_page: { snapshot_id: 7, offset: 50, limit: 50, total: 63, next_offset: null }, web_coverage: { version: 2, complete: true } });
      expect((result.structuredContent as { companies: Array<{ contacts: unknown[] }> }).companies[0]!.contacts).toHaveLength(13);
      const text = JSON.stringify(result.content);
      expect(text).toContain('观察记录共 63 条');
      expect(text).toContain('归属待核实');
      expect(text).toContain('职位未知');
      expect(text).toContain('依据');
    } finally { await connection.client.close(); await connection.server.close(); }
  });

  it.each([{ web_offset: 0 }, { web_limit: 50 }, { web_snapshot_id: 7 }])('rejects explicit web pagination for Zoho %j', page => {
    expect(GetContactsInputSchema.safeParse({ query: '公司', source: 'zoho', ...page }).success).toBe(false);
    expect(GetContactsInputSchema.safeParse({ query: '公司', source: 'zoho' }).success).toBe(true);
  });
  it('returns nullable titles and observation evidence through MCP', async () => {
    const connection = await connectedClient(services({ getContacts: async () => ({
      companies: [{ companyName: '示例公司', contacts: [{ name: '林知远', title: null,
        sourceUrl: 'https://example.test/team', publishedAt: null,
        affiliationStatus: 'unverified', evidenceQuote: '示例公司的林知远参加活动。' }],
      historicalContacts: [] }], warnings: [], collectedAt,
    }) }));
    try {
      const result = await connection.client.callTool({ name: 'discover_contacts', arguments: { query: '示例公司', source: 'all' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ companies: [{ contacts: [{
        name: '林知远', title: null, affiliation_status: 'unverified', evidence_quote: '示例公司的林知远参加活动。',
      }] }] });
      expect(JSON.stringify(result.content)).toContain('职位未知');
    } finally { await connection.client.close(); await connection.server.close(); }
  });
  it('uses strict bounded input schemas and defaults force_refresh to false', () => {
    expect(CompanyProfileInputSchema.parse({ query: '测试公司' })).toEqual({ query: '测试公司', include_company_context: false });
    expect(CompanyProfileInputSchema.safeParse({ query: '', unknown: true }).success).toBe(false);
    expect(CompanyProfileInputSchema.safeParse({ query: 'x', region_hint: '' }).success).toBe(false);
    expect(CompanyProfileInputSchema.safeParse({ query: 'x'.repeat(257) }).success).toBe(false);

    expect(SubmitAssessmentInputSchema.parse({
      legal_name: '测试制造有限公司', credit_code: '91310000TEST000001',
    })).toEqual({ legal_name: '测试制造有限公司', credit_code: '91310000TEST000001', force_refresh: false });
    expect(SubmitAssessmentInputSchema.safeParse({
      legal_name: '测试制造有限公司', credit_code: 'lowercase0000000000',
    }).success).toBe(false);
    expect(SubmitAssessmentInputSchema.safeParse({
      legal_name: '测试制造有限公司', credit_code: '91310000TEST000001', extra: true,
    }).success).toBe(false);

    expect(AssessmentReportInputSchema.parse({ assessment_id: assessmentId })).toEqual({ assessment_id: assessmentId, include_related_updates: false });
    expect(AssessmentIdInputSchema.safeParse({ assessment_id: assessmentId, include_related_updates: true }).success).toBe(false);
    expect(AssessmentIdInputSchema.safeParse({ assessment_id: assessmentId }).success).toBe(true);
    expect(AssessmentIdInputSchema.safeParse({ assessment_id: 'not-uuid' }).success).toBe(false);
    expect(AssessmentIdInputSchema.safeParse({ assessment_id: assessmentId, user_id: 'other' }).success).toBe(false);

    expect(GetContactsInputSchema.parse({ query: '测试公司', region_hint: '上海' }))
      .toEqual({ query: '测试公司', region_hint: '上海', source: 'web' });
    expect(GetContactsInputSchema.safeParse({ query: '' }).success).toBe(false);
    expect(GetContactsInputSchema.safeParse({ query: 'x'.repeat(49) }).success).toBe(false);
    expect(GetContactsInputSchema.safeParse({ query: '测试', region_hint: 'x'.repeat(17) }).success).toBe(false);
    expect(GetContactsInputSchema.safeParse({ query: '测试', force_refresh: true }).success).toBe(false);
    expect(AskCompanyInputSchema.safeParse({ legal_name: '测试制造有限公司', credit_code: '91310000TEST000001', question: 'SolidWorks 招聘说明什么？' }).success).toBe(true);
    expect(AskCompanyInputSchema.safeParse({ legal_name: '测试制造有限公司', credit_code: '91310000TEST000001', question: '', extra: true }).success).toBe(false);
    expect(AskCompanyInputSchema.safeParse({ legal_name: '测试制造有限公司', credit_code: '91310000TEST000001', question: 'x', assessment_id: 'bad' }).success).toBe(false);
  });

  it('registers exactly six tools with selection rules and cache metadata only where allowed', async () => {
    const connection = await connectedClient(services());
    const listed = await connection.client.listTools();
    const byName = new Map(listed.tools.map(tool => [tool.name, tool]));

    expect([...byName.keys()].sort()).toEqual([
      'ask_company', 'discover_contacts', 'get_assessment_report', 'get_assessment_status', 'get_company_profile', 'submit_assessment',
    ]);
    expect(byName.get('get_company_profile')?.description).toMatch(/default|默认|ambiguous|模糊/i);
    expect(byName.get('submit_assessment')?.description).toMatch(/explicit|明确|formal|正式/i);
    expect(byName.get('submit_assessment')?.description).toMatch(/confirm|确认/i);
    expect(byName.get('submit_assessment')?.description).toContain('legal_name');
    expect(byName.get('submit_assessment')?.description).toContain('credit_code');
    expect(byName.get('discover_contacts')?.description).toMatch(/公开|public/i);
    expect(byName.get('discover_contacts')?.description).toMatch(/不.*邮箱|without.*email/i);

    const profileOutput = JSON.stringify(byName.get('get_company_profile')?.outputSchema);
    const submitOutput = JSON.stringify(byName.get('submit_assessment')?.outputSchema);
    const statusOutput = JSON.stringify(byName.get('get_assessment_status')?.outputSchema);
    const reportOutput = JSON.stringify(byName.get('get_assessment_report')?.outputSchema);
    const contactsOutput = JSON.stringify(byName.get('discover_contacts')?.outputSchema);
    expect(profileOutput).toContain('cache_hit');
    expect(submitOutput).toContain('cache_hit');
    expect(submitOutput).toContain('cached_at');
    expect(statusOutput).not.toContain('cache_hit');
    expect(statusOutput).not.toContain('cached_at');
    expect(reportOutput).not.toContain('cache_hit');
    expect(reportOutput).not.toContain('cached_at');
    expect(contactsOutput).toContain('historical_contacts');
    expect(contactsOutput).not.toContain('cache_hit');
    expect(contactsOutput).not.toContain('cached_at');

    await connection.client.close();
    await connection.server.close();
  });

  it('returns matching text and structured content for all six output contracts', async () => {
    const observedInputs: unknown[] = [];
    const connection = await connectedClient(services({
      getCompanyProfile: async input => {
        observedInputs.push(input);
        return profile;
      },
      submitAssessment: async (input, userId) => {
        observedInputs.push(input, userId);
        return submit;
      },
      getAssessmentStatus: async input => {
        observedInputs.push(input);
        return status;
      },
      getAssessmentReport: async input => {
        observedInputs.push(input);
        return report;
      },
      getContacts: async input => {
        observedInputs.push(input);
        return contacts;
      },
      askCompany: async input => {
        observedInputs.push(input);
        return companyAnswer;
      },
    }));
    const calls = [
      ['get_company_profile', { query: '测试公司', region_hint: '上海' }, expectedProfile],
      ['submit_assessment', { legal_name: '测试制造有限公司', credit_code: '91310000TEST000001' }, expectedSubmit],
      ['get_assessment_status', { assessment_id: assessmentId }, expectedStatus],
      ['get_assessment_report', { assessment_id: assessmentId }, expectedReport],
      ['discover_contacts', { query: '测试制造', region_hint: '上海' }, expectedContacts],
      ['ask_company', { legal_name: '测试制造有限公司', credit_code: '91310000TEST000001', question: 'SolidWorks 招聘说明什么？', assessment_id: assessmentId }, expectedCompanyAnswer],
    ] as const;

    for (const [name, args, expected] of calls) {
      const result = await connection.client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(expected);
      if (name === 'discover_contacts') expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('公开网页联系人') }]);
      else expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);
    }
    expect(observedInputs).toEqual([
      { query: '测试公司', regionHint: '上海' },
      { legalName: '测试制造有限公司', creditCode: '91310000TEST000001', forceRefresh: false },
      '',
      { assessmentId },
      { assessmentId, includeRelatedUpdates: false },
      { query: '测试制造', regionHint: '上海', webOffset: 0, webLimit: 50 },
      { legalName: '测试制造有限公司', creditCode: '91310000TEST000001', question: 'SolidWorks 招聘说明什么？', assessmentId },
    ]);

    await connection.client.close();
    await connection.server.close();
  });

  it('rejects unknown fields before invoking a service', async () => {
    let calls = 0;
    const connection = await connectedClient(services({
      getCompanyProfile: async () => {
        calls += 1;
        return profile;
      },
    }));

    const result = await connection.client.callTool({
      name: 'get_company_profile', arguments: { query: '测试公司', unknown: true },
    });
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);

    await connection.client.close();
    await connection.server.close();
  });

  it('returns normal structured results for insufficient and failed follow-ups', async () => {
    let calls = 0;
    const connection = await connectedClient(services({
      askCompany: async () => {
        calls += 1;
        return { status: calls === 1 ? 'insufficient' : 'failed',
          legalName: '测试制造有限公司', markdown: calls === 1 ? '证据不足' : '追问失败',
          usedFreshResearch: true, collectedAt: null, sources: [] };
      },
    }));
    const args = { legal_name: '测试制造有限公司', credit_code: '91310000TEST000001', question: '最近有何扩张？' };
    for (const status of ['insufficient', 'failed']) {
      const result = await connection.client.callTool({ name: 'ask_company', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status, legal_name: '测试制造有限公司' });
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
    }
    const invalid = await connection.client.callTool({ name: 'ask_company', arguments: { ...args, extra: true } });
    expect(invalid.isError).toBe(true);
    expect(calls).toBe(2);
    await connection.client.close();
    await connection.server.close();
  });

  it('allows cross-user report reads without passing a user filter to the report service', async () => {
    const observedIds: string[] = [];
    const reportsCreatedByOtherUsers = new Map([[assessmentId, report]]);
    const connection = await connectedClient(services({
      getAssessmentReport: async input => {
        observedIds.push(input.assessmentId);
        return reportsCreatedByOtherUsers.get(input.assessmentId) ?? {
          assessmentId: input.assessmentId, status: 'failed', message: '不存在',
        };
      },
    }));

    const result = await connection.client.callTool({
      name: 'get_assessment_report', arguments: { assessment_id: assessmentId },
    });

    expect(observedIds).toEqual([assessmentId]);
    expect(result.structuredContent).toEqual(expectedReport);

    await connection.client.close();
    await connection.server.close();
  });

  it('maps every non-default business-state union branch to snake_case contracts', async () => {
    let statusCalls = 0;
    let reportCalls = 0;
    const connection = await connectedClient(services({
      getCompanyProfile: async () => ({
        sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false, message: '上游失败',
      }),
      submitAssessment: async () => ({
        assessmentId, status: 'completed', cacheHit: true, cachedAt: collectedAt,
      }),
      getAssessmentStatus: async () => {
        statusCalls += 1;
        return {
          assessmentId,
          status: statusCalls === 1 ? 'completed' : 'failed',
          message: statusCalls === 1 ? '已完成' : '处理失败',
        };
      },
      getAssessmentReport: async () => {
        reportCalls += 1;
        return {
          assessmentId,
          status: reportCalls === 1 ? 'processing' : 'failed',
          message: reportCalls === 1 ? '正在处理' : '处理失败',
        };
      },
    }));

    const calls = [
      ['get_company_profile', { query: '测试公司' }, {
        source_status: 'failed', candidates: [], basic_profile: null, cache_hit: false, message: '上游失败',
      }],
      ['submit_assessment', { legal_name: '测试制造有限公司', credit_code: '91310000TEST000001' }, {
        assessment_id: assessmentId, status: 'completed', cache_hit: true, cached_at: collectedAt,
      }],
      ['get_assessment_status', { assessment_id: assessmentId }, {
        assessment_id: assessmentId, status: 'completed', message: '已完成',
      }],
      ['get_assessment_status', { assessment_id: assessmentId }, {
        assessment_id: assessmentId, status: 'failed', message: '处理失败',
      }],
      ['get_assessment_report', { assessment_id: assessmentId }, {
        assessment_id: assessmentId, status: 'processing', message: '正在处理',
      }],
      ['get_assessment_report', { assessment_id: assessmentId }, {
        assessment_id: assessmentId, status: 'failed', message: '处理失败',
      }],
    ] as const;

    for (const [name, args, expected] of calls) {
      const result = await connection.client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(expected);
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);
    }

    await connection.client.close();
    await connection.server.close();
  });
});
