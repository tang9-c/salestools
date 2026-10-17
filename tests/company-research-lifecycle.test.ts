import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { ResearchRepository } from '../src/research/repository.js';
import { ResearchQueue } from '../src/research/queue.js';
const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
const initial = (n: number) => ({
  mode: 'initial',
  legal_name: `企业${n}`,
  credit_code: `9131000012345678${n}X`,
  operation_id: `op${n}`,
  products: ['creo'],
});
function fixture() {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  dbs.push(db);
  return { db, repo: new ResearchRepository(db) };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
it('调度只从数据库FIFO领取，全局一个运行，释放后才开始下一个', async () => {
  const { repo } = fixture();
  const first = repo.begin(initial(1), 'u');
  const second = repo.begin(initial(2), 'u');
  const blocked = gate();
  const events: string[] = [];
  const queue = new ResearchQueue(repo, async (id) => {
    events.push(id);
    if (id === first.run_id) await blocked.promise;
    repo.fail(id, 'TEST_DONE');
  });
  queue.start();
  queue.enqueue();
  await Promise.resolve();
  expect(events).toEqual([first.run_id]);
  expect(repo.getRun(second.run_id)?.status).toBe('queued');
  blocked.resolve();
  await queue.waitForActive();
  expect(events).toEqual([first.run_id, second.run_id]);
  queue.stopAccepting();
});
it('关闭标记未执行任务失败，活动取消等待连接释放才完成', async () => {
  const { repo } = fixture();
  const first = repo.begin(initial(1), 'u');
  const second = repo.begin(initial(2), 'u');
  const released = gate();
  let signal!: AbortSignal;
  const queue = new ResearchQueue(repo, async (_id, s) => {
    signal = s;
    await new Promise<void>((r) =>
      s.addEventListener('abort', () => r(), { once: true }),
    );
    await released.promise;
  });
  queue.start();
  await Promise.resolve();
  queue.stopAccepting();
  expect(repo.getRun(second.run_id)?.error_code).toBe('SERVICE_SHUTDOWN');
  expect(() => queue.enqueue()).toThrow('RESEARCH_SHUTTING_DOWN');
  queue.cancel(first.run_id, 'other');
  expect(signal.aborted).toBe(true);
  expect(repo.getRun(first.run_id)?.cancelled_by).toBe('other');
  let settled = false;
  const waiting = queue.waitForActive().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  released.resolve();
  await waiting;
});
it('未知模板遗留任务恢复后可安全诊断且不执行付费恢复', () => {
  const { db, repo } = fixture();
  const run = repo.begin(initial(1), 'u');
  db.prepare(
    "UPDATE company_research_runs SET request_json=json_set(request_json,'$.template.id','future') WHERE run_id=?",
  ).run(run.run_id);
  expect(repo.recover()).toBe(1);
  expect(repo.runMetadata(run.run_id)).toMatchObject({
    status: 'failed',
    error_code: 'PROCESS_RESTARTED',
    template: { id: 'future' },
    schema_version: 1,
  });
});

import { createApplication } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { AddressInfo } from 'node:net';
import { createTestToken } from './helpers/token.js';
const env = {
  PUBLIC_MCP_HOST: '127.0.0.1',
  ALLOWED_ORIGINS: 'https://codex.example.cn',
  SQLITE_PATH: ':memory:',
  QCC_MCP_COMPANY_URL: 'https://qcc.example/company',
  QCC_MCP_RISK_URL: 'https://qcc.example/risk',
  QCC_MCP_IPR_URL: 'https://qcc.example/ipr',
  QCC_MCP_OPERATION_URL: 'https://qcc.example/operation',
  QCC_API_KEY: 'synthetic',
  DOUBAO_SEARCH_API_URL: 'https://search.example/',
  DOUBAO_SEARCH_API_KEY: 'synthetic',
  ARK_API_URL: 'https://ark.example/',
  ARK_MODEL: 'synthetic',
  ARK_CREDENTIAL: 'synthetic',
  COMPANY_RESEARCH_ENABLED: 'true',
};
const at = '2026-10-17T00:00:00.000Z';
function seed(db: DatabaseSync) {
  new ProfileRepository(db).upsert({
    identity: {
      legalName: '企业甲',
      creditCode: '91310000123456789X',
      formerNames: [],
      aliases: [],
      englishNames: [],
      brands: [],
      officialDomains: [],
      registeredAddress: null,
      parentLegalName: null,
      subsidiaryLegalNames: [],
    },
    normalizedLegalName: '企业甲',
    basicProfile: {
      industry: '机械制造',
      region: null,
      company_type: null,
      founded_year: null,
      registered_capital: null,
      legal_representative: null,
      website: null,
      employee_range: null,
      risk_summary: null,
      collected_at: at,
    },
    collectedAt: at,
  });
}
it('应用关闭超时中止研究，等待连接释放后才关闭SQLite', async () => {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  seed(db);
  const release = gate();
  const started = gate();
  const events: string[] = [];
  const originalClose = db.close.bind(db);
  db.close = () => {
    events.push('db.close');
    originalClose();
  };
  const app = createApplication(loadConfig(env), {
    database: db,
    now: () => new Date(at),
    research: {
      sources: () => ({
        async collectQcc(_work, signal) {
          started.resolve();
          await new Promise<void>((r) =>
            signal.addEventListener('abort', () => r(), { once: true }),
          );
          events.push('aborted');
          throw Error('aborted');
        },
        async search() {
          throw Error('unexpected');
        },
        async collectGraph() {
          throw Error('unexpected');
        },
        async close() {
          await release.promise;
          events.push('research.finished');
        },
      }),
    },
  });
  const token = await createTestToken(app.tokenService, 'u');
  const server = await app.listen(0, '127.0.0.1');
  const client = new Client({ name: 'research-lifecycle', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    ),
  );
  const result = await client.callTool({
    name: 'start_company_research',
    arguments: {
      mode: 'initial',
      legal_name: '企业甲',
      credit_code: '91310000123456789X',
      operation_id: 'op',
      products: ['creo'],
    },
  });
  expect(result.isError).not.toBe(true);
  await started.promise;
  await client.close();
  const closing = app.close(1);
  for (let i = 0; i < 100 && !events.includes('aborted'); i++)
    await new Promise((r) => setTimeout(r, 1));
  expect(events).toContain('aborted');
  expect(events).not.toContain('db.close');
  expect(
    new ResearchRepository(db).runMetadata(
      (result.structuredContent as any).run_id,
    ),
  ).toMatchObject({ status: 'failed', error_code: 'SERVICE_SHUTDOWN' });
  release.resolve();
  await closing;
  expect(events.indexOf('db.close')).toBeGreaterThan(
    events.indexOf('research.finished'),
  );
});

import { ingestEvidence } from '../src/research/evidence.js';
import { AssessmentRepository } from '../src/db/assessment-repository.js';
import type { ResearchSourceBatch } from '../src/research/sources.js';
async function httpClient(app: ReturnType<typeof createApplication>) {
  const token = createTestToken(app.tokenService, 'reader');
  const server = await app.listen(0, '127.0.0.1');
  const client = new Client({ name: 'research-reader', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    ),
  );
  return client;
}
it('真实runner使用生产builder保存结果后HTTP读路由没有新增来源/模型调用', async () => {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  seed(db);
  const oldAssessment = new AssessmentRepository(db).createOrReuseAssessment(
    {
      requestedBy: 'owner',
      legalName: '企业甲',
      creditCode: '91310000123456789X',
    },
    false,
    new Date(at),
    30,
  ).record;
  const originalDate = '2024-01-01T00:00:00.000Z';
  db.prepare(
    "UPDATE assessments SET status='completed',completed_at=?,collected_at=?,report_markdown=?,evidence_snapshot_json=? WHERE assessment_id=?",
  ).run(
    at,
    originalDate,
    '报告正文伪造企业部署全部软件',
    JSON.stringify({
      collectedAt: originalDate,
      items: [
        {
          evidenceId: 'original-assessment-evidence',
          title: '历史招聘',
          url: 'https://example.com/old',
          originalPublisher: '企业甲',
          originalDomain: 'example.com',
          publishedAt: originalDate,
          collectedAt: originalDate,
          mentionedName: '企业甲',
          entityScope: 'legal_entity',
          entityMatch: 'confirmed',
          matchBasis: ['名称'],
          source: 'doubao_search',
          sourceKind: 'web',
          excerpt: '企业甲历史招聘要求Creo技能。',
          excerptTruncated: false,
        },
      ],
      facts: [],
    }),
    oldAssessment.assessmentId,
  );
  const previousSnapshot = JSON.parse(
    String(
      (
        db
          .prepare(
            'SELECT evidence_snapshot_json FROM assessments WHERE assessment_id=?',
          )
          .get(oldAssessment.assessmentId) as { evidence_snapshot_json: string }
      ).evidence_snapshot_json,
    ),
  );
  previousSnapshot.items.push({
    ...previousSnapshot.items[0],
    evidenceId: 'catia-only',
    url: 'https://example.com/catia',
    excerpt: '企业甲招聘要求CATIA技能。',
  });
  previousSnapshot.facts.push({
    factId: 'catia-fact',
    statement: '企业甲招聘要求CATIA技能。',
    kind: 'recruitment',
    productTags: ['catia'],
    strength: 'supporting',
    evidenceIds: ['catia-only'],
    entityScope: 'legal_entity',
    entityMatch: 'confirmed',
    matchBasis: ['名称'],
  });
  db.prepare(
    'UPDATE assessments SET evidence_snapshot_json=? WHERE assessment_id=?',
  ).run(JSON.stringify(previousSnapshot), oldAssessment.assessmentId);
  let upstream = 0;
  let prior: import('../src/research/contracts.js').ResearchEvidence[] = [];
  const empty = (): ResearchSourceBatch => ({
    evidence: [],
    checks: [],
    warnings: [],
    source_status: [],
  });
  const quote = '企业甲招聘要求熟练使用Creo进行机械设计。';
  const evidence = ingestEvidence(
    {
      source_type: 'web',
      url: 'https://example.com/recruit',
      publisher: '企业甲',
      content: quote,
      collected_at: at,
      published_at: at,
      company_scope: 'confirmed',
    },
    {
      title: '机械设计招聘',
      quote,
      product_keys: ['creo'],
      signal_kind: 'job_requirement',
    },
  )!;
  const app = createApplication(loadConfig(env), {
    database: db,
    now: () => new Date(at),
    research: {
      sources: (context) => {
        prior = context.prior;
        return {
          async collectQcc() {
            upstream++;
            return { ...empty(), evidence: [evidence] };
          },
          async search() {
            upstream++;
            return empty();
          },
          async collectGraph() {
            return empty();
          },
          async close() {},
        };
      },
      model: () => ({
        async analyze() {
          upstream++;
          return { claims: [], gaps: [], queries: [] };
        },
        async close() {},
      }),
    },
  });
  const c = await httpClient(app);
  try {
    const start = await c.callTool({
      name: 'start_company_research',
      arguments: {
        mode: 'initial',
        legal_name: '企业甲',
        credit_code: '91310000123456789X',
        operation_id: 'read-zero',
        products: ['creo'],
      },
    });
    expect(start.isError).not.toBe(true);
    const runId = (start.structuredContent as any).run_id;
    const repo = new ResearchRepository(db);
    for (
      let i = 0;
      i < 100 && ['queued', 'running'].includes(repo.getRun(runId)!.status);
      i++
    )
      await new Promise((r) => setTimeout(r, 1));
    const run = repo.getRun(runId)!;
    expect(['completed', 'partial']).toContain(run.status);
    expect(run.version_id).toBeTruthy();
    const count = upstream;
    expect(count).toBeGreaterThan(0);
    expect(prior).toContainEqual(
      expect.objectContaining({
        source_type: 'assessment',
        quote: '企业甲历史招聘要求Creo技能。',
        collected_at: originalDate,
        published_at: originalDate,
        locator: {
          assessment_id: oldAssessment.assessmentId,
          evidence_id: 'original-assessment-evidence',
        },
      }),
    );
    expect(JSON.stringify(prior)).not.toContain('报告正文伪造');
    expect(JSON.stringify(prior)).not.toContain('catia-only');
    expect(prior).toContainEqual(
      expect.objectContaining({
        source_type: 'qcc',
        title: '已确认企业基础画像',
        collected_at: at,
      }),
    );
    for (const [name, args] of [
      ['get_company_research_status', { run_id: runId }],
      ['get_company_research', { dossier_id: run.dossier_id }],
      ['list_company_research_versions', { dossier_id: run.dossier_id }],
      ['get_company_research_evidence', { version_id: run.version_id! }],
    ] as const) {
      const result = await c.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
    }
    expect(upstream).toBe(count);
    expect(repo.getVersion(run.version_id!)!.snapshot.evidence).toContainEqual(
      expect.objectContaining({
        evidence_id: evidence.evidence_id,
        quote,
        published_at: at,
        collected_at: at,
      }),
    );
    const future = repo.begin(
      {
        mode: 'continue',
        dossier_id: run.dossier_id,
        base_version_id: run.version_id!,
        operation_id: 'future',
      },
      'other',
    );
    repo.fail(future.run_id, 'TEST_DONE');
    db.prepare(
      'INSERT INTO company_research_versions VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      'future',
      run.dossier_id,
      future.run_id,
      2,
      run.version_id!,
      '["creo"]',
      'completed',
      JSON.stringify({
        schema_version: 99,
        template: { id: 'future', version: 2 },
      }),
      at,
    );
    const history = await c.callTool({
      name: 'get_company_research',
      arguments: { dossier_id: run.dossier_id, version_id: run.version_id! },
    });
    expect(history.isError).not.toBe(true);
    const blocked = await c.callTool({
      name: 'start_company_research',
      arguments: {
        mode: 'continue',
        dossier_id: run.dossier_id,
        base_version_id: run.version_id!,
        operation_id: 'blocked',
      },
    });
    expect(blocked.structuredContent).toMatchObject({
      error_code: 'RESEARCH_VERSION_UNSUPPORTED',
    });
    const legacy = await c.callTool({
      name: 'get_company_profile',
      arguments: { query: '企业甲' },
    });
    expect(legacy.isError).not.toBe(true);
    expect(upstream).toBe(count);
  } finally {
    await c.close();
    await app.close();
  }
});
it.each(['expired', 'wrong-name'])(
  'HTTP研究缺少可靠画像(%s)不暗中解析或调用来源',
  async (reason) => {
    const db = initializeDatabase(new DatabaseSync(':memory:'));
    seed(db);
    if (reason === 'expired')
      db.prepare(
        "UPDATE company_profiles SET collected_at='2020-01-01T00:00:00.000Z'",
      ).run();
    let calls = 0;
    const app = createApplication(loadConfig(env), {
      database: db,
      now: () => new Date(at),
      qccGateway: {
        async call() {
          calls++;
          throw Error('unexpected');
        },
        async close() {},
      },
      research: {
        sources: () => {
          calls++;
          throw Error('unexpected');
        },
      },
    });
    const c = await httpClient(app);
    try {
      const result = await c.callTool({
        name: 'start_company_research',
        arguments: {
          mode: 'initial',
          legal_name: reason === 'wrong-name' ? '别的企业' : '企业甲',
          credit_code: '91310000123456789X',
          operation_id: 'invalid',
          products: ['creo'],
        },
      });
      expect(result.structuredContent).toMatchObject({
        error_code: 'RESEARCH_IDENTITY_REQUIRED',
      });
      expect(calls).toBe(0);
      expect(new ResearchRepository(db).active()).toHaveLength(0);
    } finally {
      await c.close();
      await app.close();
    }
  },
);

it.each(['cancel', 'shutdown'])(
  '首个真实QCC业务请求%s后仍保存预算和终态，释放连接后才关闭数据库',
  async (action) => {
    const db = initializeDatabase(new DatabaseSync(':memory:'));
    seed(db);
    const dispatched = gate(),
      release = gate();
    let actualCalls = 0,
      closed = false,
      runId = '';
    let finalRow: ReturnType<ResearchRepository['getRun']> = null;
    const repo = new ResearchRepository(db);
    const dbClose = db.close.bind(db);
    db.close = () => {
      finalRow = repo.getRun(runId);
      expect(closed).toBe(true);
      dbClose();
    };
    const app = createApplication(loadConfig(env), {
      database: db,
      now: () => new Date(at),
      research: {
        sourceDependencies: {
          qccFactory: {
            async create(_server, _url, _key, signal) {
              return {
                async callTool() {
                  actualCalls++;
                  dispatched.resolve();
                  await new Promise<void>((r) =>
                    signal!.addEventListener('abort', () => r(), {
                      once: true,
                    }),
                  );
                  throw Error('aborted request');
                },
                async close() {
                  await release.promise;
                  closed = true;
                },
              };
            },
          },
        },
      },
    });
    const c = await httpClient(app);
    try {
      const result = await c.callTool({
        name: 'start_company_research',
        arguments: {
          mode: 'initial',
          legal_name: '企业甲',
          credit_code: '91310000123456789X',
          operation_id: 'actual-cancel',
          products: ['creo'],
        },
      });
      runId = (result.structuredContent as { run_id: string }).run_id;
      await dispatched.promise;
      const expected =
        action === 'cancel'
          ? {
              status: 'cancelled',
              cancelled_by: 'reader',
              stop_reason: 'USER_CANCELLED',
            }
          : {
              status: 'failed',
              cancelled_by: null,
              stop_reason: 'SERVICE_SHUTDOWN',
            };
      let closing: Promise<void> | undefined;
      if (action === 'cancel') {
        const cancelled = await c.callTool({
          name: 'cancel_company_research',
          arguments: { run_id: runId },
        });
        expect(cancelled.structuredContent).toMatchObject(expected);
      } else {
        await c.close();
        closing = app.close(1);
        for (let i = 0; i < 100 && repo.getRun(runId)!.status !== 'failed'; i++)
          await new Promise((r) => setTimeout(r, 1));
        expect(repo.getRun(runId)).toMatchObject(expected);
      }
      expect(actualCalls).toBe(1);
      expect(closed).toBe(false);
      expect(finalRow).toBeNull();
      release.resolve();
      if (closing) {
        await closing;
      } else {
        for (
          let i = 0;
          i < 100 && (repo.getRun(runId)!.budget_usage.qcc !== 1 || !closed);
          i++
        )
          await new Promise((r) => setTimeout(r, 1));
        expect(repo.getRun(runId)).toMatchObject({
          ...expected,
          version_id: null,
          budget_usage: { qcc: 1, total: 1 },
          source_status: [
            { source: 'qcc', status: 'failed', error_code: 'RESEARCH_ABORTED' },
          ],
        });
        expect(
          repo.versions(
            (result.structuredContent as { dossier_id: string }).dossier_id,
          ),
        ).toHaveLength(0);
        await c.close();
        await app.close();
      }
      expect(finalRow).toMatchObject({
        ...expected,
        version_id: null,
        budget_usage: { qcc: 1, total: 1 },
      });
    } finally {
      release.resolve();
      await c.close();
      await app.close();
    }
  },
);
