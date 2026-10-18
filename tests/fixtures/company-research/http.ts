// Controlled test boundary: real HTTP MCP, file SQLite, production Runner/buildResult;
// no native graph, browser, page bundle, production credentials or external network.
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  createApplication,
  type ApplicationOverrides,
} from '../../../src/index.js';
import { loadConfig } from '../../../src/config.js';
import { initializeDatabase } from '../../../src/db/database.js';
import { ProfileRepository } from '../../../src/db/profile-repository.js';
import { ResearchRepository } from '../../../src/research/repository.js';
import { createTestToken } from '../../helpers/token.js';
import { TestClock } from '../../company-research-test-clock.js';
import { PROFILE } from '../company-context.js';
export const AT = '2026-10-17T00:00:00.000Z';
export const NAME = '企业甲';
export const CODE = '91310000123456789X';
export const initial = {
  mode: 'initial',
  legal_name: NAME,
  credit_code: CODE,
  products: ['creo'],
  operation_id: 'initial',
};
export const env = {
  PUBLIC_MCP_HOST: '127.0.0.1',
  ALLOWED_ORIGINS: 'https://codex.example.cn',
  SQLITE_PATH: ':memory:',
  QCC_MCP_COMPANY_URL: 'https://qcc.invalid/company',
  QCC_MCP_RISK_URL: 'https://qcc.invalid/risk',
  QCC_MCP_IPR_URL: 'https://qcc.invalid/ipr',
  QCC_MCP_OPERATION_URL: 'https://qcc.invalid/operation',
  QCC_API_KEY: 'synthetic',
  DOUBAO_SEARCH_API_URL: 'https://search.invalid/',
  DOUBAO_SEARCH_API_KEY: 'synthetic',
  ARK_API_URL: 'https://ark.invalid/',
  ARK_MODEL: 'synthetic',
  ARK_CREDENTIAL: 'synthetic',
  COMPANY_RESEARCH_ENABLED: 'true',
  COMPANY_RESEARCH_TIMEOUT_MS: '60000',
};
export function seed(db: DatabaseSync, empty = false) {
  new ProfileRepository(db).upsert({
    ...PROFILE,
    identity: { ...PROFILE.identity, legalName: NAME, creditCode: CODE },
    normalizedLegalName: NAME,
    collectedAt: AT,
    basicProfile: {
      ...PROFILE.basicProfile,
      industry: empty ? null : '机械制造',
      collected_at: AT,
    },
  });
}
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export async function until(predicate: () => boolean, label = 'condition') {
  for (let n = 0; n < 1000; n++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
export const emptyBatch = () => ({
  evidence: [],
  checks: [],
  source_status: [],
  warnings: [],
});
export async function fixture(
  options: {
    research?: ApplicationOverrides['research'];
    config?: Record<string, string>;
    emptyProfile?: boolean;
    logSink?: ApplicationOverrides['logSink'];
    setup?: (repo: ResearchRepository) => void;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'research-http-'));
  const path = join(directory, 'service.sqlite');
  let db = initializeDatabase(new DatabaseSync(path));
  seed(db, options.emptyProfile);
  options.setup?.(new ResearchRepository(db));
  if (options.setup) {
    db.close();
    db = initializeDatabase(new DatabaseSync(path));
  }
  const clock = new TestClock();
  const requests: Array<{
    source: 'qcc' | 'search' | 'ark';
    body: any;
    at: number;
  }> = [];
  let modelOutput: (body: any) => unknown = () => ({
    claims: [],
    gaps: [],
    queries: [],
  });
  let sourceText = `${NAME}使用Creo进行产品设计。`;
  const research: ApplicationOverrides['research'] = {
    clock,
    sourceDependencies: {
      qccFactory: {
        async create() {
          return {
            async callTool(tool, input) {
              requests.push({
                source: 'qcc',
                body: { tool, input },
                at: clock.time,
              });
              return { content: [{ type: 'text', text: sourceText }] };
            },
            async close() {},
          };
        },
      },
      fetchFn: async (_url, init) => {
        requests.push({
          source: 'search',
          body: JSON.parse(String(init!.body)),
          at: clock.time,
        });
        return Response.json({
          Code: 0,
          Result: {
            WebResults: [
              {
                Title: `${NAME}软件使用`,
                Url: 'https://example.com/software',
                SiteName: NAME,
                Content: sourceText,
                Summary: sourceText,
                PublishTime: '2026-10-01',
                SortId: 1,
              },
            ],
          },
        });
      },
    },
    modelFetch: async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      requests.push({ source: 'ark', body, at: clock.time });
      return Response.json({
        choices: [{ message: { content: JSON.stringify(modelOutput(body)) } }],
      });
    },
    ...options.research,
  };
  const app = createApplication(loadConfig({ ...env, ...options.config }), {
    database: db,
    now: clock.wall,
    research,
    logSink: options.logSink,
  });
  const repo = new ResearchRepository(db, { now: clock.wall });
  const server = await app.listen(0, '127.0.0.1');
  const clients: Client[] = [];
  async function client(actor: string) {
    const token = createTestToken(app.tokenService, actor);
    const c = new Client({ name: 'controlled-research', version: '1' });
    await c.connect(
      new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
        ),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
      ),
    );
    clients.push(c);
    return c;
  }
  const c = await client('owner');
  async function call(name: string, args: Record<string, unknown>, who = c) {
    const result = await who.callTool({ name, arguments: args });
    return result.structuredContent as Record<string, any>;
  }
  async function start(args: Record<string, unknown> = initial) {
    const run = await call('start_company_research', args);
    if (!run.run_id) throw Error(JSON.stringify(run));
    await until(
      () => !['queued', 'running'].includes(repo.getRun(run.run_id)!.status),
      'terminal run',
    );
    // Let the runner finally persist diagnostics before asserting counts.
    await new Promise((r) => setTimeout(r, 1));
    return repo.getRun(run.run_id)!;
  }
  return {
    app,
    db,
    repo,
    clock,
    requests,
    call,
    start,
    client,
    path,
    directory,
    text: (text: string) => {
      sourceText = text;
    },
    output: (fn: typeof modelOutput) => {
      modelOutput = fn;
    },
    async close() {
      await Promise.all(clients.map((c) => c.close()));
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
