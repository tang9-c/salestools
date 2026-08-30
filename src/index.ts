import { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { TokenService } from './auth/token-service.js';
import { loadConfig, type AppConfig } from './config.js';
import { AssessmentRepository } from './db/assessment-repository.js';
import { initializeDatabase, openDatabase } from './db/database.js';
import { ProfileRepository } from './db/profile-repository.js';
import { TokenRepository } from './db/token-repository.js';
import { JsonlLogger, type LogSink } from './logging/logger.js';
import { createHttpApp } from './mcp/http-app.js';
import type { McpServices } from './mcp/tools.js';
import { AssessmentRunner } from './orchestration/assessment-runner.js';
import { AssessmentService } from './orchestration/assessment-service.js';
import { AssessmentQueue } from './orchestration/fifo-queue.js';
import { ArkEvidenceService } from './upstream/ark/client.js';
import { QccResearchCollector } from './upstream/qcc/assessment-research.js';
import { QccGateway } from './upstream/qcc/client.js';
import { CompanyProfileService } from './upstream/qcc/profile-service.js';
import { DoubaoSearchClient } from './upstream/search/doubao-client.js';

type QccDependency = Pick<QccGateway, 'call' | 'close'>;
type SearchDependency = Pick<DoubaoSearchClient, 'search'> & { close?: () => Promise<void> };
type ArkDependency = Pick<ArkEvidenceService, 'extract'> & { close?: () => Promise<void> };

export interface ApplicationOverrides {
  database?: DatabaseSync;
  qccGateway?: QccDependency;
  searchClient?: SearchDependency;
  ark?: ArkDependency;
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

async function waitAtMost(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise,
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
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

  const profiles = new ProfileRepository(database);
  const tokenService = new TokenService(new TokenRepository(database), overrides.now);
  const qccGateway = overrides.qccGateway ?? new QccGateway({
    urls: {
      company: config.qccMcpCompanyUrl,
      risk: config.qccMcpRiskUrl,
      ipr: config.qccMcpIprUrl,
      operation: config.qccMcpOperationUrl,
    },
    apiKey: config.qccApiKey,
  });
  const searchClient: SearchDependency = overrides.searchClient ?? new DoubaoSearchClient({
    url: config.doubaoSearchApiUrl,
    apiKey: config.doubaoSearchApiKey,
    now: overrides.now,
  });
  const ark: ArkDependency = overrides.ark ?? new ArkEvidenceService({
    url: config.arkApiUrl,
    model: config.arkModel,
    credential: config.arkCredential,
  });
  const profileService = new CompanyProfileService(qccGateway, profiles, {
    profileCacheTtlDays: config.profileCacheTtlDays,
    maxQccCalls: config.maxQccCalls,
    maxTotalCalls: config.maxTotalUpstreamCalls,
    now: overrides.now,
  });
  const qccResearch = new QccResearchCollector(qccGateway, overrides.now);
  const logger = new JsonlLogger(overrides.logSink ?? stdoutSink, overrides.now);
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
  });
  const queue = new AssessmentQueue(
    assessmentId => runner.run(assessmentId),
    config.maxConcurrentAssessments,
  );
  const assessmentService = new AssessmentService({
    assessments,
    queue,
    assessmentCacheTtlDays: config.assessmentCacheTtlDays,
    now: overrides.now,
  });
  const servicesFor = (userId: string): McpServices => ({
    getCompanyProfile: input => profileService.get(input.query, input.regionHint),
    submitAssessment: input => assessmentService.submit(input, userId),
    getAssessmentStatus: input => assessmentService.status(input),
    getAssessmentReport: input => assessmentService.report(input),
  });
  const app = createHttpApp(config, token => tokenService.verify(token), servicesFor);

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
        await waitAtMost(queue.waitForActive(), timeoutMs);
        await Promise.allSettled([
          app.closeMcpHandler(),
          qccGateway.close(),
          searchClient.close?.() ?? Promise.resolve(),
          ark.close?.() ?? Promise.resolve(),
        ]);
        await listenerClosed;
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
