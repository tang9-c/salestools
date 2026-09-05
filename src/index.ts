import { type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { TokenService } from './auth/token-service.js';
import { loadConfig, type AppConfig } from './config.js';
import { AssessmentRepository } from './db/assessment-repository.js';
import { initializeDatabase, openDatabase } from './db/database.js';
import { ProfileRepository } from './db/profile-repository.js';
import { TokenRepository } from './db/token-repository.js';
import { ContactSnapshotRepository } from './db/contact-snapshot-repository.js';
import { JsonlLogger, type LogSink } from './logging/logger.js';
import { ContactService, type ContactExtractorDependency } from './contacts/contact-service.js';
import { createHttpApp } from './mcp/http-app.js';
import type { McpServices } from './mcp/tools.js';
import { AssessmentRunner } from './orchestration/assessment-runner.js';
import { AssessmentService } from './orchestration/assessment-service.js';
import { ActivityTracker } from './orchestration/activity-tracker.js';
import { AssessmentQueue } from './orchestration/fifo-queue.js';
import { ArkEvidenceService } from './upstream/ark/client.js';
import { ContactExtractor } from './upstream/ark/contact-extractor.js';
import { QccResearchCollector } from './upstream/qcc/assessment-research.js';
import { QccGateway } from './upstream/qcc/client.js';
import { CompanyProfileService } from './upstream/qcc/profile-service.js';
import { DoubaoSearchClient } from './upstream/search/doubao-client.js';
import { UpstreamError } from './orchestration/retry.js';

type QccDependency = Pick<QccGateway, 'call' | 'close'>;
type SearchDependency = Pick<DoubaoSearchClient, 'search'>
  & Partial<Pick<DoubaoSearchClient, 'searchWeb'>>
  & { close?: () => Promise<void> };
type ArkDependency = Pick<ArkEvidenceService, 'extractWithAudit'> & { close?: () => Promise<void> };

export interface ApplicationOverrides {
  database?: DatabaseSync;
  qccGateway?: QccDependency;
  searchClient?: SearchDependency;
  ark?: ArkDependency;
  contactExtractor?: ContactExtractorDependency;
  logSink?: LogSink;
  now?: () => Date;
}

export interface RunningApplication {
  readonly tokenService: TokenService;
  listen(port?: number, host?: string): Promise<Server>;
  close(timeoutMs?: number): Promise<void>;
}

const stdoutSink: LogSink = {
  write: line => process.stdout.write(line),
};

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error));
  });
}

async function waitAtMost(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    promise.then(() => true),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return completed;
}

export function createApplication(
  config: AppConfig,
  overrides: ApplicationOverrides = {},
): RunningApplication {
  const database = overrides.database === undefined
    ? openDatabase(config.sqlitePath)
    : initializeDatabase(overrides.database);
  const assessments = new AssessmentRepository(database);
  assessments.failInterruptedAssessments(overrides.now?.() ?? new Date());
  const abortController = new AbortController();
  const activity = new ActivityTracker();

  const profiles = new ProfileRepository(database);
  const contactSnapshots = new ContactSnapshotRepository(database);
  const logger = new JsonlLogger(overrides.logSink ?? stdoutSink, overrides.now);
  const tokenService = new TokenService(new TokenRepository(database), overrides.now);
  const qccGateway = overrides.qccGateway ?? new QccGateway({
    urls: {
      company: config.qccMcpCompanyUrl,
      risk: config.qccMcpRiskUrl,
      ipr: config.qccMcpIprUrl,
      operation: config.qccMcpOperationUrl,
    },
    apiKey: config.qccApiKey,
    signal: abortController.signal,
  });
  const searchClient: SearchDependency = overrides.searchClient ?? new DoubaoSearchClient({
    url: config.doubaoSearchApiUrl,
    apiKey: config.doubaoSearchApiKey,
    now: overrides.now,
    signal: abortController.signal,
  });
  const ark: ArkDependency = overrides.ark ?? new ArkEvidenceService({
    url: config.arkApiUrl,
    model: config.arkModel,
    credential: config.arkCredential,
    requestMaxBytes: config.arkRequestMaxBytes,
    signal: abortController.signal,
  });
  const contactExtractor = overrides.contactExtractor ?? new ContactExtractor({
    url: config.arkApiUrl,
    model: config.arkModel,
    credential: config.arkCredential,
    requestMaxBytes: config.arkRequestMaxBytes,
    signal: abortController.signal,
  });
  const contactService = new ContactService({
    searchClient: {
      searchWeb: query => {
        if (searchClient.searchWeb === undefined) {
          throw new UpstreamError(
            'doubao_search',
            'INVALID_RESPONSE',
            'Contact web search is unavailable',
          );
        }
        return searchClient.searchWeb(query);
      },
    },
    extractor: contactExtractor,
    snapshots: contactSnapshots,
    cacheLogger: logger,
    now: overrides.now,
  });
  const profileService = new CompanyProfileService(qccGateway, profiles, {
    profileCacheTtlDays: config.profileCacheTtlDays,
    maxQccCalls: config.maxQccCalls,
    maxTotalCalls: config.maxTotalUpstreamCalls,
    now: overrides.now,
  });
  const qccResearch = new QccResearchCollector(qccGateway, overrides.now);
  const runner = new AssessmentRunner({
    assessments,
    profiles,
    qccResearch,
    searchClient,
    ark,
    logger,
    profileCacheTtlDays: config.profileCacheTtlDays,
    budgetLimits: {
      qcc: config.maxQccCalls,
      doubaoSearch: config.maxSearchCalls,
      ark: config.maxArkCalls,
      total: config.maxTotalUpstreamCalls,
    },
    now: overrides.now,
    signal: abortController.signal,
  });
  const queue = new AssessmentQueue(
    assessmentId => activity.track(() => runner.run(assessmentId)),
    config.maxConcurrentAssessments,
  );
  const assessmentService = new AssessmentService({
    assessments,
    queue,
    assessmentCacheTtlDays: config.assessmentCacheTtlDays,
    now: overrides.now,
    signal: abortController.signal,
  });
  const servicesFor = (userId: string): McpServices => ({
    getCompanyProfile: input => activity.track(() => profileService.get(input.query, input.regionHint)),
    submitAssessment: input => activity.track(() => assessmentService.submit(input, userId)),
    getAssessmentStatus: input => activity.track(() => assessmentService.status(input)),
    getAssessmentReport: input => activity.track(() => assessmentService.report(input)),
    getContacts: input => activity.track(() => contactService.get(input)),
  });
  const app = createHttpApp(config, token => tokenService.verify(token), servicesFor);

  let upstreamClosing: Promise<void> | null = null;
  const closeUpstreams = (): Promise<void> => {
    if (upstreamClosing !== null) return upstreamClosing;
    upstreamClosing = Promise.allSettled([
      qccGateway.close(),
      searchClient.close?.() ?? Promise.resolve(),
      ark.close?.() ?? Promise.resolve(),
    ]).then(() => undefined);
    return upstreamClosing;
  };

  let server: Server | null = null;
  let closing: Promise<void> | null = null;
  return {
    tokenService,
    async listen(port = config.port, host = '0.0.0.0') {
      if (server !== null) throw new Error('Application is already listening');
      queue.start();
      server = app.listen(port, host);
      await new Promise<void>((resolve, reject) => {
        server!.once('listening', resolve);
        server!.once('error', reject);
      });
      return server;
    },
    close(timeoutMs = 30_000) {
      if (closing !== null) return closing;
      closing = (async () => {
        queue.stopAccepting();
        const listenerClosed = server === null ? Promise.resolve() : closeServer(server);
        void listenerClosed.catch(() => undefined);
        const normalDrain = listenerClosed.then(() => activity.whenIdle());
        const completedNormally = await waitAtMost(normalDrain, timeoutMs);
        if (completedNormally) {
          await closeUpstreams();
          await app.closeMcpHandler();
        } else {
          abortController.abort();
          await closeUpstreams();
          void app.closeMcpHandler().catch(() => undefined);
          server?.closeIdleConnections();
          server?.closeAllConnections();
          await activity.whenIdle();
        }
        database.close();
      })();
      return closing;
    },
  };
}

export async function startApplication(env: NodeJS.ProcessEnv = process.env): Promise<RunningApplication> {
  const runtime = createApplication(loadConfig(env));
  await runtime.listen();
  return runtime;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') loadDotEnv({ quiet: true });
  const runtime = await startApplication();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write('Application startup failed\n');
    process.exitCode = 1;
  });
}
