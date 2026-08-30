import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnection, type Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { IdentityProfile } from '../src/contracts/index.js';
import { AssessmentRepository } from '../src/db/assessment-repository.js';
import { initializeDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { createApplication, type RunningApplication } from '../src/index.js';
import { ActivityTracker } from '../src/orchestration/activity-tracker.js';

const FIRST: IdentityProfile = {
  legalName: '甲机器人有限公司', creditCode: '91310000TEST000001',
  formerNames: [], aliases: [], englishNames: [], brands: [], officialDomains: ['a.example.cn'],
  registeredAddress: '上海', parentLegalName: null, subsidiaryLegalNames: [],
};
const SECOND: IdentityProfile = {
  ...FIRST, legalName: '乙机器人有限公司', creditCode: '91310000TEST000002',
  officialDomains: ['b.example.cn'],
};

const config = loadConfig({
  PORT: '3000', PUBLIC_MCP_HOST: '127.0.0.1', ALLOWED_ORIGINS: 'https://codex.example.cn',
  SQLITE_PATH: ':memory:',
  QCC_MCP_COMPANY_URL: 'https://agent.qcc.com/mcp/company/stream',
  QCC_MCP_RISK_URL: 'https://agent.qcc.com/mcp/risk/stream',
  QCC_MCP_IPR_URL: 'https://agent.qcc.com/mcp/ipr/stream',
  QCC_MCP_OPERATION_URL: 'https://agent.qcc.com/mcp/operation/stream', QCC_API_KEY: 'fake-qcc',
  DOUBAO_SEARCH_API_URL: 'https://search.example.cn/search', DOUBAO_SEARCH_API_KEY: 'fake-search',
  ARK_API_URL: 'https://ark.example.cn/chat', ARK_MODEL: 'fake-model', ARK_CREDENTIAL: 'fake-ark',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { assertion(); return; } catch { await new Promise(resolve => setTimeout(resolve, 1)); }
  }
  assertion();
}

function profilePayload(tool: string, identity = FIRST): unknown {
  if (tool === 'get_company_by_query') return { Data: [{
    Name: identity.legalName, CreditCode: identity.creditCode, Status: '存续',
    Address: identity.registeredAddress, MatchReason: '名称完全匹配',
  }] };
  if (tool === 'get_company_registration_info') return { Data: {
    Name: identity.legalName, CreditCode: identity.creditCode, Status: '存续',
    Address: identity.registeredAddress, Province: '上海', EconKind: '有限责任公司',
    StartDate: '2020-01-01', RegistCapi: null, OperName: null, Industry: '机器人',
    FormerNames: [], EnglishNames: [], ParentLegalName: null, SubsidiaryLegalNames: [],
  } };
  if (tool === 'get_company_profile') return { Data: {
    Name: identity.legalName, ShortNames: [], Brands: [], Industry: '机器人',
    EmployeeRange: null, Website: `https://${identity.officialDomains[0]}`,
  } };
  if (tool === 'get_contact_info') return { Data: { Website: `https://${identity.officialDomains[0]}` } };
  if (tool === 'get_company_risk_scan') return { Data: { Summary: null } };
  return { Data: [] };
}

function seedProfile(database: DatabaseSync, identity: IdentityProfile): void {
  const now = new Date().toISOString();
  new ProfileRepository(database).upsert({
    identity,
    normalizedLegalName: identity.legalName,
    basicProfile: {
      industry: '机器人', region: '上海', company_type: '有限责任公司', founded_year: 2020,
      registered_capital: null, legal_representative: null,
      website: `https://${identity.officialDomains[0]}`, employee_range: null,
      risk_summary: null, collected_at: now,
    },
    collectedAt: now,
  });
}

async function connect(runtime: RunningApplication, token: string): Promise<Client> {
  const listener = await runtime.listen(0, '127.0.0.1');
  const endpoint = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`;
  const client = new Client({ name: 'lifecycle', version: '1.0.0' }, {
    versionNegotiation: { mode: 'auto' },
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as Record<string, unknown>;
}

describe('ActivityTracker', () => {
  it('does not become idle until every tracked business promise settles', async () => {
    const tracker = new ActivityTracker();
    const first = deferred<void>();
    const second = deferred<void>();
    void tracker.track(first.promise);
    void tracker.track(second.promise);
    let idle = false;
    void tracker.whenIdle().then(() => { idle = true; });

    first.resolve();
    await Promise.resolve();
    expect(idle).toBe(false);
    second.resolve();
    await tracker.whenIdle();
    expect(idle).toBe(true);
  });
});

describe('application shutdown lifecycle', () => {
  const runtimes: RunningApplication[] = [];
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map(client => client.close()));
    await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close(5)));
  });

  it('keeps upstream and SQLite open until an in-flight profile request finishes normally', async () => {
    const lookup = deferred<unknown>();
    let lookupStarted = false;
    let profileSettled = false;
    let qccClosed = false;
    let databaseClosed = false;
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    const originalClose = database.close.bind(database);
    vi.spyOn(database, 'close').mockImplementation(() => { databaseClosed = true; originalClose(); });
    const runtime = createApplication(config, {
      database,
      qccGateway: {
        call: async (_server, tool) => {
          if (tool === 'get_company_by_query') {
            lookupStarted = true;
            return lookup.promise;
          }
          return profilePayload(tool);
        },
        close: async () => { qccClosed = true; },
      },
      searchClient: { search: async () => [] },
      ark: { extract: async () => { throw new Error('unused'); } },
      logSink: { write: () => undefined },
    });
    runtimes.push(runtime);
    const client = await connect(runtime, runtime.tokenService.create('sales-a'));
    clients.push(client);
    const profile = call(client, 'get_company_profile', { query: FIRST.legalName })
      .finally(() => { profileSettled = true; });
    await eventually(() => expect(lookupStarted).toBe(true));

    const shutdown = runtime.close(1_000);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect({ qccClosed, databaseClosed }).toEqual({ qccClosed: false, databaseClosed: false });

    lookup.resolve(profilePayload('get_company_by_query'));
    await expect(profile).resolves.toMatchObject({ source_status: 'completed' });
    await client.close();
    await shutdown;
    expect(profileSettled).toBe(true);
    expect({ qccClosed, databaseClosed }).toEqual({ qccClosed: true, databaseClosed: true });
  });

  it('aborts timed-out active work, fails it before closing SQLite, and never starts pending work', async () => {
    const events: string[] = [];
    let searchClosed = false;
    const blockedSearches: Array<ReturnType<typeof deferred<never>>> = [];
    const searchedNames: string[] = [];
    let firstId = '';
    let secondId = '';
    let statesAtDatabaseClose: Array<string | null> = [];
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    seedProfile(database, FIRST);
    seedProfile(database, SECOND);
    const assessments = new AssessmentRepository(database);
    const originalClose = database.close.bind(database);
    vi.spyOn(database, 'close').mockImplementation(() => {
      statesAtDatabaseClose = [assessments.get(firstId)?.status ?? null, assessments.get(secondId)?.status ?? null];
      events.push('database-close');
      originalClose();
    });
    const runtime = createApplication(config, {
      database,
      qccGateway: {
        call: async (_server, tool) => profilePayload(tool),
        close: async () => { events.push('qcc-close'); },
      },
      searchClient: {
        search: async query => {
          searchedNames.push(query.subjectLegalName);
          if (searchClosed) throw new Error('search aborted');
          const blocked = deferred<never>();
          blockedSearches.push(blocked);
          return blocked.promise;
        },
        close: async () => {
          searchClosed = true;
          events.push('search-close');
          blockedSearches.splice(0).forEach(blocked => blocked.reject(new Error('search aborted')));
        },
      },
      ark: { extract: async () => { throw new Error('Ark must not start after shutdown abort'); } },
      logSink: { write: () => undefined },
    });
    runtimes.push(runtime);
    const client = await connect(runtime, runtime.tokenService.create('sales-a'));
    clients.push(client);
    const first = await call(client, 'submit_assessment', {
      legal_name: FIRST.legalName, credit_code: FIRST.creditCode,
    });
    const second = await call(client, 'submit_assessment', {
      legal_name: SECOND.legalName, credit_code: SECOND.creditCode,
    });
    firstId = String(first.assessment_id);
    secondId = String(second.assessment_id);
    await eventually(() => expect(blockedSearches).toHaveLength(1));

    const shutdown = runtime.close(5);
    await client.close();
    await shutdown;

    expect(statesAtDatabaseClose).toEqual(['failed', 'processing']);
    expect(searchedNames.every(name => name === FIRST.legalName)).toBe(true);
    expect(events).toContain('search-close');
    expect(events.at(-1)).toBe('database-close');
  });

  it('tracks profile business work after the HTTP client disconnects and closes SQLite only after retry settles', async () => {
    let rejectLookup!: (error: unknown) => void;
    let attempts = 0;
    let closed = false;
    let attemptsAtDatabaseClose = 0;
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    const originalClose = database.close.bind(database);
    vi.spyOn(database, 'close').mockImplementation(() => {
      attemptsAtDatabaseClose = attempts;
      originalClose();
    });
    const runtime = createApplication(config, {
      database,
      qccGateway: {
        call: async () => {
          attempts += 1;
          if (closed) throw new Error('transport already closed');
          return new Promise((_resolve, reject) => { rejectLookup = reject; });
        },
        close: async () => {
          closed = true;
          setTimeout(() => rejectLookup(new Error('transport closed')), 10);
        },
      },
      searchClient: { search: async () => [] },
      ark: { extract: async () => { throw new Error('unused'); } },
      logSink: { write: () => undefined },
    });
    runtimes.push(runtime);
    const token = runtime.tokenService.create('sales-a');
    const listener = await runtime.listen(0, '127.0.0.1');
    const port = (listener.address() as AddressInfo).port;
    const request = httpRequest({
      hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        Host: '127.0.0.1', Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      },
    });
    request.on('error', () => undefined);
    request.end(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_company_profile', arguments: { query: FIRST.legalName } },
    }));
    await eventually(() => expect(attempts).toBe(1));
    request.destroy();

    await runtime.close(5);

    expect(attempts).toBe(2);
    expect(attemptsAtDatabaseClose).toBe(2);
  });

  it('forces a half-open HTTP connection closed after timeout without waiting on listener forever', async () => {
    const events: string[] = [];
    let databaseCloses = 0;
    const database = initializeDatabase(new DatabaseSync(':memory:'));
    const originalClose = database.close.bind(database);
    vi.spyOn(database, 'close').mockImplementation(() => {
      databaseCloses += 1;
      events.push('database-close');
      originalClose();
    });
    const runtime = createApplication(config, {
      database,
      qccGateway: { call: async () => ({ Data: [] }), close: async () => { events.push('qcc-close'); } },
      searchClient: { search: async () => [] },
      ark: { extract: async () => { throw new Error('unused'); } },
      logSink: { write: () => undefined },
    });
    runtimes.push(runtime);
    const listener = await runtime.listen(0, '127.0.0.1');
    const port = (listener.address() as AddressInfo).port;
    let socket: Socket | undefined;
    socket = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      socket!.once('connect', resolve);
      socket!.once('error', reject);
    });
    socket.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 999\r\n\r\n{');

    const shutdown = runtime.close(5);
    const outcome = await Promise.race([
      shutdown.then(() => 'closed'),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 100)),
    ]);
    if (outcome === 'timeout') socket.destroy();
    await shutdown;

    expect(outcome).toBe('closed');
    await eventually(() => expect(socket.destroyed).toBe(true));
    expect(databaseCloses).toBe(1);
    expect(events.at(-1)).toBe('database-close');
    await runtime.close(5);
    expect(databaseCloses).toBe(1);
  });
});
