import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { ResearchBundle, ResearchItem } from '../src/contracts/index.js';
import { AssessmentRepository } from '../src/db/assessment-repository.js';
import { initializeDatabase } from '../src/db/database.js';
import { createApplication, type RunningApplication } from '../src/index.js';
import type { SearchQuery } from '../src/upstream/search/search-plan.js';

const LEGAL_NAME = '测试机器人有限公司';
const CREDIT_CODE = '91310000TEST000001';

const env = {
  PORT: '3000',
  PUBLIC_MCP_HOST: '127.0.0.1',
  ALLOWED_ORIGINS: 'https://codex.example.cn:8443',
  SQLITE_PATH: ':memory:',
  QCC_MCP_COMPANY_URL: 'https://agent.qcc.com/mcp/company/stream',
  QCC_MCP_RISK_URL: 'https://agent.qcc.com/mcp/risk/stream',
  QCC_MCP_IPR_URL: 'https://agent.qcc.com/mcp/ipr/stream',
  QCC_MCP_OPERATION_URL: 'https://agent.qcc.com/mcp/operation/stream',
  QCC_API_KEY: 'fake-qcc-key',
  DOUBAO_SEARCH_API_URL: 'https://search.example.cn/web_search',
  DOUBAO_SEARCH_API_KEY: 'fake-search-key',
  ARK_API_URL: 'https://ark.example.cn/chat/completions',
  ARK_MODEL: 'fake-model',
  ARK_CREDENTIAL: 'fake-ark-key',
};

function fakeQccPayload(tool: string): unknown {
  if (tool === 'get_company_by_query') {
    return { Data: [{
      Name: LEGAL_NAME,
      CreditCode: CREDIT_CODE,
      Status: '存续',
      Address: '上海市浦东新区测试路 1 号',
      MatchReason: '名称完全匹配',
    }] };
  }
  if (tool === 'get_company_registration_info') {
    return { Data: {
      Name: LEGAL_NAME,
      CreditCode: CREDIT_CODE,
      Status: '存续',
      Address: '上海市浦东新区测试路 1 号',
      Province: '上海',
      EconKind: '有限责任公司',
      StartDate: '2020-03-04',
      RegistCapi: '5000 万元人民币',
      OperName: '张三',
      Industry: '机器人',
      FormerNames: [],
      EnglishNames: [],
      ParentLegalName: null,
      SubsidiaryLegalNames: [],
    } };
  }
  if (tool === 'get_company_profile') {
    return { Data: {
      Name: LEGAL_NAME,
      ShortNames: ['测试机器人'],
      Brands: [],
      Industry: '机器人',
      EmployeeRange: '100-499',
      Website: 'https://robot.example.cn',
    } };
  }
  if (tool === 'get_contact_info') return { Data: { Website: 'https://robot.example.cn' } };
  if (tool === 'get_company_risk_scan') return { Data: { Summary: '未发现明显经营异常' } };
  return { Data: [] };
}

function fakeSearchItem(query: SearchQuery): ResearchItem {
  const collectedAt = new Date().toISOString();
  return {
    evidenceId: `search-${query.purpose}`,
    source: 'doubao_search',
    sourceKind: 'web',
    title: `${LEGAL_NAME}官方资料`,
    url: `https://robot.example.cn/${query.purpose}`,
    originalPublisher: `${LEGAL_NAME}官网`,
    originalDomain: 'robot.example.cn',
    summary: `${LEGAL_NAME}官方资料待进一步核实`,
    content: null,
    publishedAt: null,
    collectedAt,
    mentionedName: LEGAL_NAME,
    entityScope: 'legal_entity',
    entityMatch: 'confirmed',
    matchBasis: ['法定名称一致', '官方域名一致'],
    query: query.Query,
    position: 1,
    logId: null,
  };
}

function fakeArkEvidence(bundle: ResearchBundle) {
  return {
    identity: bundle.identity,
    industryClassification: 'unverified' as const,
    industryEvidenceIds: [],
    evidence: [],
    facts: [],
    financingRecords: [],
    conflicts: [],
    gaps: ['产品技术场景待核实'],
    collectedAt: bundle.collectedAt,
  };
}

async function connect(endpoint: string, token: string, name: string): Promise<Client> {
  const client = new Client(
    { name, version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function call(client: Client, name: string, arguments_: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: arguments_ });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeTypeOf('object');
  return result.structuredContent as Record<string, unknown>;
}

describe('MCP HTTP simulated end-to-end', () => {
  let runtime: RunningApplication | undefined;
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map(client => client.close()));
    await runtime?.close();
    runtime = undefined;
  });

  it('runs profile, assessment, polling and cross-user report reads over modern MCP', async () => {
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    runtime = createApplication(loadConfig(env), {
      database,
      qccGateway: {
        call: async (_server, tool) => fakeQccPayload(tool),
        close: async () => undefined,
      },
      searchClient: { search: async query => [fakeSearchItem(query)] },
      ark: { extract: async bundle => fakeArkEvidence(bundle) },
      logSink: { write: () => undefined },
    });
    const firstToken = runtime.tokenService.create('sales-a');
    const secondToken = runtime.tokenService.create('sales-b');
    const listener = await runtime.listen(0, '127.0.0.1');
    const port = (listener.address() as AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}/mcp`;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const firstClient = await connect(endpoint, firstToken, 'e2e-user-a');
    clients.push(firstClient);
    expect(firstClient.getProtocolEra()).toBe('modern');

    const profile = await call(firstClient, 'get_company_profile', { query: LEGAL_NAME });
    expect(firstClient.getProtocolEra()).toBe('modern');
    expect(profile).toMatchObject({ source_status: 'completed', cache_hit: false });
    expect(profile).toHaveProperty('cache_hit');

    const submitted = await call(firstClient, 'submit_assessment', {
      legal_name: LEGAL_NAME,
      credit_code: CREDIT_CODE,
    });
    expect(submitted).toMatchObject({ status: 'processing', cache_hit: false });
    const assessmentId = String(submitted.assessment_id);

    let status: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = await call(firstClient, 'get_assessment_status', { assessment_id: assessmentId });
      if (status.status !== 'processing') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(status).toMatchObject({ status: 'completed' });
    expect(status).not.toHaveProperty('cache_hit');
    expect(status).not.toHaveProperty('cached_at');

    const secondClient = await connect(endpoint, secondToken, 'e2e-user-b');
    clients.push(secondClient);
    expect(secondClient.getProtocolEra()).toBe('modern');
    const report = await call(secondClient, 'get_assessment_report', { assessment_id: assessmentId });
    expect(secondClient.getProtocolEra()).toBe('modern');
    expect(report).toMatchObject({
      assessment_id: assessmentId,
      status: 'completed',
      legal_name: LEGAL_NAME,
      overall_opportunity: '待核实',
      recommended_product: null,
      source_status: { qcc: 'completed', doubao_search: 'completed', ark: 'completed' },
    });
    expect(String(report.markdown)).toContain('产品技术场景待核实');
    expect(report).not.toHaveProperty('cache_hit');
    expect(report).not.toHaveProperty('cached_at');

    const cached = await call(secondClient, 'submit_assessment', {
      legal_name: LEGAL_NAME,
      credit_code: CREDIT_CODE,
    });
    const stored = new AssessmentRepository(database).get(assessmentId);
    expect(stored?.requestedBy).toBe('sales-a');
    expect(cached).toEqual({
      assessment_id: assessmentId,
      status: 'completed',
      cache_hit: true,
      cached_at: stored?.completedAt,
    });
  });
});
