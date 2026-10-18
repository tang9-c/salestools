import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { ResearchRepository } from '../src/research/repository.js';
import { CompanyResearchService } from '../src/research/service.js';
import { ResearchQueue } from '../src/research/queue.js';
import { registerCompanyResearchTools } from '../src/mcp/company-research-tools.js';
const input = {
  mode: 'initial',
  legal_name: '企业甲',
  credit_code: '91310000123456789X',
  operation_id: 'op1',
  products: ['creo'],
};
async function fixture(
  work: (
    client: Client,
    repo: ResearchRepository,
    db: DatabaseSync,
  ) => Promise<void>,
  actor?: string,
  enabled = true,
  options = {},
) {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  const repo = new ResearchRepository(db, options);
  const service = new CompanyResearchService(repo, {
    identityLookup: () => true,
  });
  const queue = new ResearchQueue(repo, async () => {});
  const server = new McpServer(
    { name: 'research', version: '1' },
    { capabilities: { tools: {} } },
  );
  registerCompanyResearchTools(server, { enabled, service, queue });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  if (actor) {
    const onmessage = b.onmessage!;
    b.onmessage = (message, extra) =>
      onmessage(message, {
        ...extra,
        authInfo: { token: 'synthetic', clientId: actor, scopes: [] },
      });
  }
  await client.connect(a);
  try {
    await work(client, repo, db);
  } finally {
    await client.close();
    await server.close();
    db.close();
  }
}
const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
) => await client.callTool({ name, arguments: args });
it('默认关闭时六工具均不注册', async () =>
  fixture(
    async (c) => {
      expect((await c.listTools()).tools).toHaveLength(0);
    },
    'u',
    false,
  ));
it('未认证用户不能提交或读取，actor参数不能注入', async () =>
  fixture(async (c, repo) => {
    const denied = await call(c, 'start_company_research', input);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('RESEARCH_UNAUTHENTICATED');
    expect(repo.active()).toHaveLength(0);
    const read = await call(c, 'get_company_research_status', {
      run_id: 'any',
    });
    expect(read.structuredContent).toMatchObject({
      error_code: 'RESEARCH_UNAUTHENTICATED',
    });
    const injected = await call(c, 'start_company_research', {
      ...input,
      actor: 'admin',
    });
    expect(injected.isError).toBe(true);
  }));
it('共享写入幂等重放且其他用户取消记录真实actor', async () =>
  fixture(async (c, repo) => {
    const first = await call(c, 'start_company_research', input);
    expect(first.isError).not.toBe(true);
    const started = first.structuredContent as any;
    expect(started).toMatchObject({
      status: 'queued',
      replayed: false,
      template: { id: 'company_research', version: 1 },
    });
    const replay = await call(c, 'start_company_research', input);
    expect(replay.structuredContent).toMatchObject({
      run_id: started.run_id,
      replayed: true,
    });
    const changed = await call(c, 'start_company_research', {
      ...input,
      goal: '变化',
    });
    expect(JSON.stringify(changed)).toContain('RESEARCH_OPERATION_CONFLICT');
    const own = repo.begin(
      { ...input, credit_code: '91310000123456788X', operation_id: 'other' },
      'other',
    );
    const cancelled = await call(c, 'cancel_company_research', {
      run_id: own.run_id,
    });
    expect(cancelled.structuredContent).toMatchObject({
      status: 'cancelled',
      cancelled_by: 'u',
    });
    const again = await call(c, 'cancel_company_research', {
      run_id: own.run_id,
    });
    expect(again.structuredContent).toMatchObject({ cancelled_by: 'u' });
  }, 'u'));
it('队满/用户额度在提交事务内拒绝不留下任务', async () =>
  fixture(
    async (c, repo) => {
      await call(c, 'start_company_research', input);
      const rejected = await call(c, 'start_company_research', {
        ...input,
        credit_code: '91310000123456788X',
        operation_id: 'op2',
      });
      expect(JSON.stringify(rejected)).toContain('RESEARCH_QUEUE_FULL');
      expect(repo.active()).toHaveLength(1);
    },
    'u',
    true,
    { maxQueued: 1 },
  ));
it('用户额度与其它用户无关，未来模板拒绝且不写入', async () =>
  fixture(
    async (c, repo) => {
      const future = await call(c, 'start_company_research', {
        ...input,
        template_id: 'product_sales_scenario',
        products: undefined,
      });
      expect(JSON.stringify(future)).toContain('RESEARCH_PRODUCTS_REQUIRED');
      expect(repo.active()).toHaveLength(0);
      await call(c, 'start_company_research', input);
      const rejected = await call(c, 'start_company_research', {
        ...input,
        credit_code: '91310000123456788X',
        operation_id: 'op2',
      });
      expect(JSON.stringify(rejected)).toContain('RESEARCH_USER_LIMIT');
    },
    'u',
    true,
    { maxPerActor: 1 },
  ));
it('status未知模板恢复可诊断，list不解码未来snapshot', async () =>
  fixture(async (c, repo, db) => {
    const run = repo.begin(input, 'other');
    db.prepare(
      "UPDATE company_research_runs SET request_json=json_set(request_json,'$.template.id','future') WHERE run_id=?",
    ).run(run.run_id);
    repo.recover();
    const status = await call(c, 'get_company_research_status', {
      run_id: run.run_id,
    });
    expect(status.structuredContent).toMatchObject({
      status: 'failed',
      error_code: 'PROCESS_RESTARTED',
      template: { id: 'future' },
    });
    db.prepare(
      'INSERT INTO company_research_versions VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      'future-version',
      run.dossier_id,
      run.run_id,
      1,
      null,
      '["creo"]',
      'completed',
      JSON.stringify({
        schema_version: 99,
        template: { id: 'future', version: 2 },
      }),
      '2026-10-17T00:00:00.000Z',
    );
    const list = await call(c, 'list_company_research_versions', {
      dossier_id: run.dossier_id,
    });
    expect(list.isError).not.toBe(true);
    expect((list.structuredContent as any).items[0]).toMatchObject({
      schema_version: 99,
      template: { id: 'future', version: 2 },
    });
    const read = await call(c, 'get_company_research', {
      dossier_id: run.dossier_id,
    });
    expect(JSON.stringify(read)).toContain('RESEARCH_VERSION_UNSUPPORTED');
    const blocked = await call(c, 'start_company_research', {
      ...input,
      credit_code: '91310000123456788X',
      operation_id: 'new',
    });
    expect(JSON.stringify(blocked)).toContain('RESEARCH_VERSION_UNSUPPORTED');
  }, 'u'));

import { ingestEvidence } from '../src/research/evidence.js';
import type {
  ResearchRun,
  ResearchSnapshot,
} from '../src/research/contracts.js';
function complete(repo: ResearchRepository, run: ResearchRun) {
  const quote = '企业甲招聘要求熟练使用Creo进行机械设计。';
  const evidence = ingestEvidence(
    {
      source_type: 'web',
      url: 'https://example.com/job',
      publisher: '企业甲',
      content: quote,
      published_at: '2026-10-17T00:00:00.000Z',
      collected_at: '2026-10-17T00:00:00.000Z',
      company_scope: 'confirmed',
    },
    {
      title: '机械设计招聘',
      quote,
      product_keys: ['creo'],
      signal_kind: 'job_requirement',
    },
  )!;
  const s: ResearchSnapshot = {
    schema_version: 1,
    template: run.request.template,
    method_version: run.request.method_version,
    evaluator_version: 'opportunity@1',
    dossier_id: run.dossier_id,
    run_id: run.run_id,
    credit_code: input.credit_code,
    legal_name: input.legal_name,
    effective_goal: run.request.effective_goal,
    product_keys: run.request.product_keys,
    product_goals: run.request.product_goals,
    parent_version_id: run.base_version_id,
    evidence_base_version_ids: [
      ...new Set(
        Object.values(run.request.product_base_versions).filter(
          (v): v is string => v !== null,
        ),
      ),
    ],
    template_result: { kind: 'company_research' },
    summary: '招聘显示Creo技能需求，部署范围未知',
    evidence: [evidence],
    facts: [],
    claims: [],
    gaps: [],
    product_assessments: [],
    coverage: [
      {
        product: 'creo',
        scope_complete: true,
        technical_gap_ids: [],
        knowledge_gap_ids: [],
        blocking_conflict_ids: [],
      },
    ],
    changes: { business_changes: [], method_changes: [], analysis_changes: [] },
    source_status: [],
    budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
    evidence_checks: [],
  };
  repo.claim(run.run_id);
  return repo.finish(run.run_id, s);
}
it.each(['continue', 'refresh'])(
  '其它认证用户可%s，共享读取原版本，过期基线冲突不创建run',
  async (mode) =>
    fixture(async (c, repo) => {
      const first = repo.begin(input, 'owner');
      const v1 = complete(repo, first);
      for (const [name, args] of [
        ['get_company_research', { credit_code: input.credit_code }],
        ['list_company_research_versions', { dossier_id: first.dossier_id }],
        ['get_company_research_evidence', { version_id: v1.version_id }],
      ] as const) {
        const result = await call(c, name, args);
        expect(result.isError).not.toBe(true);
      }
      const read = await call(c, 'get_company_research', {
        dossier_id: first.dossier_id,
      });
      expect(read.structuredContent).toMatchObject({
        template: { id: 'company_research', version: 1 },
        schema_version: 1,
        coverage: [{ version_id: v1.version_id }],
      });
      const evidence = await call(c, 'get_company_research_evidence', {
        version_id: v1.version_id,
        product: 'creo',
        limit: 1,
      });
      expect((evidence.structuredContent as any).items[0]).toMatchObject({
        quote: '企业甲招聘要求熟练使用Creo进行机械设计。',
        published_at: '2026-10-17T00:00:00.000Z',
      });
      expect(repo.active()).toHaveLength(0);
      const next = await call(c, 'start_company_research', {
        mode,
        dossier_id: first.dossier_id,
        base_version_id: v1.version_id,
        operation_id: 'shared',
      });
      expect(next.isError).not.toBe(true);
      const run = repo.getRun((next.structuredContent as any).run_id)!;
      expect(run.actor).toBe('reader');
      const v2 = complete(repo, run);
      const conflict = await call(c, 'start_company_research', {
        mode,
        dossier_id: first.dossier_id,
        base_version_id: v1.version_id,
        operation_id: 'stale',
      });
      expect(conflict.structuredContent).toMatchObject({
        error_code: 'RESEARCH_VERSION_CONFLICT',
        latest_version_id: v2.version_id,
      });
      expect(repo.active()).toHaveLength(0);
      const invalid = await call(c, 'get_company_research_evidence', {
        version_id: v1.version_id,
        claim_id: 'missing',
      });
      expect(invalid.structuredContent).toMatchObject({
        error_code: 'RESEARCH_CLAIM_NOT_FOUND',
      });
    }, 'reader'),
);
it('非法范围/分页与双标识被严格拒绝，不能夹带服务端字段', async () =>
  fixture(async (c, repo) => {
    for (const products of [[], ['creo', 'creo'], ['unknown']])
      expect(
        (await call(c, 'start_company_research', { ...input, products }))
          .isError,
      ).toBe(true);
    for (const args of [
      { ...input, product_base_versions: { creo: null } },
      { ...input, template_version: 2 },
    ])
      expect((await call(c, 'start_company_research', args)).isError).toBe(
        true,
      );
    expect(
      (
        await call(c, 'get_company_research', {
          dossier_id: 'one',
          credit_code: input.credit_code,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call(c, 'get_company_research_evidence', {
          version_id: 'one',
          claim_id: 'x',
          product: 'creo',
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call(c, 'list_company_research_versions', {
          dossier_id: 'one',
          limit: 51,
        })
      ).isError,
    ).toBe(true);
    expect(repo.active()).toHaveLength(0);
  }, 'u'));

it('六工具公布严格输入/输出契约并且不向输入公开actor', async () =>
  fixture(async (c) => {
    const tools = (await c.listTools()).tools;
    expect(tools).toHaveLength(6);
    for (const tool of tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty('actor');
    }
  }, 'u'));


it('returns the complete bounded saved summary as MCP text without a second arbitrary cutoff', async () =>
  fixture(async (client, repo, db) => {
    const run = repo.begin(input, 'u');
    const version = complete(repo, run);
    const summary = '产品机会与引用'.repeat(320) + '关键技术缺口：web来源处理未完成';
    db.prepare('UPDATE company_research_versions SET snapshot_json = json_set(snapshot_json, \'$.summary\', ?) WHERE version_id = ?').run(summary, version.version_id);
    const response = await call(client, 'get_company_research', { dossier_id: run.dossier_id });
    expect(response.isError).not.toBe(true);
    const text = response.content as Array<{ type: string; text: string }>;
    expect(text[0].text).toBe(summary);
    expect(text[0].text).toContain('web来源处理未完成');
  }, 'u'));
