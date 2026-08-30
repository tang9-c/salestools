import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AssessmentIdInputSchema,
  CompanyProfileInputSchema,
  SubmitAssessmentInputSchema,
} from '../src/mcp/tool-schemas.js';
import {
  buildMcpServer,
  type AssessmentReportServiceOutput,
  type AssessmentStatusServiceOutput,
  type CompanyProfileServiceOutput,
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
  assessmentId, status: 'processing', estimatedMinutes: '5-10', cacheHit: false,
};
const expectedSubmit = {
  assessment_id: assessmentId, status: 'processing', estimated_minutes: '5-10', cache_hit: false,
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

function services(overrides: Partial<McpServices> = {}): McpServices {
  return {
    getCompanyProfile: async () => profile,
    submitAssessment: async () => submit,
    getAssessmentStatus: async () => status,
    getAssessmentReport: async () => report,
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
  it('uses strict bounded input schemas and defaults force_refresh to false', () => {
    expect(CompanyProfileInputSchema.parse({ query: '测试公司' })).toEqual({ query: '测试公司' });
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

    expect(AssessmentIdInputSchema.safeParse({ assessment_id: assessmentId }).success).toBe(true);
    expect(AssessmentIdInputSchema.safeParse({ assessment_id: 'not-uuid' }).success).toBe(false);
    expect(AssessmentIdInputSchema.safeParse({ assessment_id: assessmentId, user_id: 'other' }).success).toBe(false);
  });

  it('registers exactly four tools with selection rules and cache metadata only where allowed', async () => {
    const connection = await connectedClient(services());
    const listed = await connection.client.listTools();
    const byName = new Map(listed.tools.map(tool => [tool.name, tool]));

    expect([...byName.keys()].sort()).toEqual([
      'get_assessment_report', 'get_assessment_status', 'get_company_profile', 'submit_assessment',
    ]);
    expect(byName.get('get_company_profile')?.description).toMatch(/default|默认|ambiguous|模糊/i);
    expect(byName.get('submit_assessment')?.description).toMatch(/explicit|明确|formal|正式/i);
    expect(byName.get('submit_assessment')?.description).toMatch(/confirm|确认/i);
    expect(byName.get('submit_assessment')?.description).toContain('legal_name');
    expect(byName.get('submit_assessment')?.description).toContain('credit_code');

    const profileOutput = JSON.stringify(byName.get('get_company_profile')?.outputSchema);
    const submitOutput = JSON.stringify(byName.get('submit_assessment')?.outputSchema);
    const statusOutput = JSON.stringify(byName.get('get_assessment_status')?.outputSchema);
    const reportOutput = JSON.stringify(byName.get('get_assessment_report')?.outputSchema);
    expect(profileOutput).toContain('cache_hit');
    expect(submitOutput).toContain('cache_hit');
    expect(submitOutput).toContain('cached_at');
    expect(statusOutput).not.toContain('cache_hit');
    expect(statusOutput).not.toContain('cached_at');
    expect(reportOutput).not.toContain('cache_hit');
    expect(reportOutput).not.toContain('cached_at');

    await connection.client.close();
    await connection.server.close();
  });

  it('returns matching text and structured content for all four Task 2 output contracts', async () => {
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
    }));
    const calls = [
      ['get_company_profile', { query: '测试公司', region_hint: '上海' }, expectedProfile],
      ['submit_assessment', { legal_name: '测试制造有限公司', credit_code: '91310000TEST000001' }, expectedSubmit],
      ['get_assessment_status', { assessment_id: assessmentId }, expectedStatus],
      ['get_assessment_report', { assessment_id: assessmentId }, expectedReport],
    ] as const;

    for (const [name, args, expected] of calls) {
      const result = await connection.client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(expected);
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);
    }
    expect(observedInputs).toEqual([
      { query: '测试公司', regionHint: '上海' },
      { legalName: '测试制造有限公司', creditCode: '91310000TEST000001', forceRefresh: false },
      '',
      { assessmentId },
      { assessmentId },
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
