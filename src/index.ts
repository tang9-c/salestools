import { ResearchRepository, ResearchError } from './research/repository.js';
import { CompanyResearchService } from './research/service.js';
import { ResearchQueue } from './research/queue.js';
import { ResearchRunner, type ResearchRunnerOptions } from './research/runner.js';
import { createResearchSources, type ResearchSourcesDependencies } from './research/sources.js';
import { ArkResearchModel } from './research/model.js';
import { GraphEvidenceCollector } from './research/graph-evidence.js';
import { buildResult } from './research/opportunity-adapter.js';
import { ingestEvidence, sha256 } from './research/evidence.js';
import type { ResearchEvidence } from './research/contracts.js';
import { CompanyLinkRepository } from './db/company-link-repository.js';
import { CompanyLinkService } from './companies/company-link.js';
import { CompanyContextService } from './companies/company-context-service.js';
import { createTokenAdminRouter } from './admin/token-router.js';
import { type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { ZohoContactService } from './contacts/zoho-contact-service.js';
import { ZohoGraphSync } from './contacts/zoho-graph-sync.js';
import { ZohoClient, verifyZohoSDKPatch } from './upstream/zoho/client.js';
import { annotateZohoOwners } from './contacts/zoho-owner-identity.js';
import { TokenAdministration } from './auth/token-administration.js';
import { findCrmConnection } from './auth/token-identity.js';
import { ContactGraphClient, type GraphClient } from './contacts/graph-client.js';
import { ContactLibraryService } from './contacts/library-service.js';
import { SnapshotSync } from './contacts/snapshot-sync.js';
import { UploadStore } from './contacts/upload-store.js';
import { UploadSessions } from './contacts/upload-session.js';
import { ImportJobs } from './contacts/import-jobs.js';
import { ContactImportService } from './contacts/import-service.js';
import { parseLocalDocument } from './contacts/document-worker.js';
import { DocumentExtractor } from './contacts/document-extractor.js';
import { EmbeddingClient } from './contacts/embedding-client.js';
import { VectorIndexer } from './contacts/vector-indexer.js';
import { ContactSearch } from './contacts/contact-search.js';
import { ContactAnswerService } from './contacts/contact-answer.js';
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
import { CompanyProfileService, normalizeLegalName } from './upstream/qcc/profile-service.js';
import { DoubaoSearchClient } from './upstream/search/doubao-client.js';
import { UpstreamError } from './orchestration/retry.js';
import { CompanyQuestionService } from './orchestration/company-question-service.js';
import { CompanyAnswerClient } from './upstream/ark/company-answer.js';
import { formatStartupFailure } from './startup-error.js';

type QccDependency = Pick<QccGateway, 'call' | 'close'>;
type SearchDependency = Pick<DoubaoSearchClient, 'search'>
  & Partial<Pick<DoubaoSearchClient, 'searchWeb'>>
  & { close?: () => Promise<void> };
type ArkDependency = Pick<ArkEvidenceService, 'planBatches' | 'extractWithAudit'> & { close?: () => Promise<void> };

export interface ApplicationOverrides {
  research?: Partial<Pick<ResearchRunnerOptions, 'sources' | 'model' | 'clock'>> & {
    sourceDependencies?: ResearchSourcesDependencies;
    modelFetch?: typeof fetch;
  };
  database?: DatabaseSync;
  qccGateway?: QccDependency;
  searchClient?: SearchDependency;
  ark?: ArkDependency;
  contactExtractor?: ContactExtractorDependency;
  companyAnswer?: Pick<CompanyAnswerClient, 'answer'>;
  questionTimeoutMs?: number;
  logSink?: LogSink;
  now?: () => Date;
  graphClient?: GraphClient;
  zohoClient?: Pick<ZohoClient, 'searchAccountsPage' | 'getAccount' | 'getContactsPage' | 'close'>
    & Partial<Pick<ZohoClient, 'getOrganization' | 'getUsersPage'>>;
  verifyZohoPatch?: () => Promise<void>;
}

export interface RunningApplication {
  readonly tokenService: TokenService;
  readonly graphClient?: GraphClient;
  readonly uploadStore: UploadStore;
  readonly importJobs: ImportJobs;
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
  if (process.env.NODE_ENV === 'production' && config.contactGraphEnabled && !config.contactWorkerSocket) {
    throw new Error('CONTACT_WORKER_SOCKET is required for production contact uploads');
  }
  const database = overrides.database === undefined
    ? openDatabase(config.sqlitePath)
    : initializeDatabase(overrides.database);
  const assessments = new AssessmentRepository(database);
  assessments.failInterruptedAssessments(overrides.now?.() ?? new Date());
  const abortController = new AbortController();
  const activity = new ActivityTracker();

  const profiles = new ProfileRepository(database);
  const contactSnapshots = new ContactSnapshotRepository(database);
  const logSink = overrides.logSink ?? stdoutSink;
  const logger = new JsonlLogger(logSink, overrides.now);
  // The check reads installed patch bytes only. No adapter or SDK is created
  // until it succeeds; a failure degrades only the Zoho source.
  const zohoReady = config.zohoConnections.length === 0 ? undefined :
    Promise.resolve().then(() => (overrides.verifyZohoPatch ?? verifyZohoSDKPatch)()).then(() => {
      const client = overrides.zohoClient ?? new ZohoClient(config.zohoConnections);
      const service = new ZohoContactService(client, config.zohoConnections, {
        logger: event => logSink.write(`${JSON.stringify({ event: 'zoho_contacts', ...event })}\n`),
      });
      return { client, service };
    }).catch(() => null);
  const tokenService = new TokenService(new TokenRepository(database), overrides.now);
  const tokenAdministration = new TokenAdministration(tokenService, {
    getOrganization: async (id, context) => {
      const ready = await zohoReady;
      if (!ready?.client.getOrganization) throw new Error('ZOHO_UNAVAILABLE');
      return ready.client.getOrganization(id, context);
    },
    getUsersPage: async (id, page, context) => {
      const ready = await zohoReady;
      if (!ready?.client.getUsersPage) throw new Error('ZOHO_UNAVAILABLE');
      return ready.client.getUsersPage(id, page, context);
    },
  }, config.zohoConnections);
  const ephemeralUploads = config.sqlitePath === ':memory:';
  const uploadDirectory = ephemeralUploads
    ? mkdtempSync(join(tmpdir(), 'contact-uploads-'))
    : join(tmpdir(), 'salestools-contact-uploads');
  const uploadStore = new UploadStore({ directory: uploadDirectory,
    maxPendingFiles: config.contactMaxPendingFiles,
    maxFileBytes: config.contactMaxFileBytes,
    maxPdfPages: config.contactMaxPdfPages,
    maxImagePixels: config.contactMaxImagePixels,
    maxTempBytes: config.contactMaxTempBytes,
    pythonBin: config.contactPythonBin,
    workerSocket: config.contactWorkerSocket,
    now: overrides.now });
  const importJobs = new ImportJobs({ concurrency: config.contactImportConcurrency,
    timeoutMs: config.contactImportTimeoutMs,
    reserve: actor => uploadStore.reserve(actor), release: id => uploadStore.release(id),
    onCleanup: (id, error) => logger.logContactCleanup(id, error),
    submit: id => { uploadStore.markSubmitted(id); } });
  const graphClient = config.contactGraphEnabled
    ? overrides.graphClient ?? new ContactGraphClient({
      command: config.contactGraphBin!,
      dbPath: config.contactGraphSqlitePath!,
    })
    : undefined;
  const embedding = graphClient && config.embeddingEnabled
    ? new EmbeddingClient({ url: config.embeddingApiUrl!, model: config.embeddingModel!,
      credential: config.embeddingCredential! }) : undefined;
  const vectorIndexer = graphClient && embedding
    ? new VectorIndexer({ graph: graphClient, embedding, model: config.embeddingModel! }) : undefined;
  const zohoGraphSync = graphClient ? new ZohoGraphSync(graphClient, vectorIndexer) : undefined;
  const contactSearch = graphClient ? new ContactSearch(graphClient, embedding) : undefined;
  const companyLinkRepository = graphClient ? new CompanyLinkRepository(database) : undefined;
  const companyContext = companyLinkRepository ? new CompanyContextService({
    graph: graphClient, links: companyLinkRepository, profiles, assessments,
    now: overrides.now ?? (() => new Date()), profileTtlDays: config.profileCacheTtlDays,
  }) : undefined;
  const contactAnswer = graphClient && contactSearch ? new ContactAnswerService({
    graph: graphClient, companyContext,
    resolvePeople: async name => {
      const page = await contactSearch.search({ name, mode: 'keyword', limit: 50 });
      return page.items.filter(item => item.label === 'Person' && item.name)
        .map(item => ({ entity_id: item.entity_id, name: item.name! }));
    },
    ark: { url: config.arkApiUrl, model: config.arkModel,
      credential: config.arkCredential, requestMaxBytes: config.arkRequestMaxBytes },
  }) : undefined;
  const contactLibrary = graphClient === undefined ? undefined : new ContactLibraryService(graphClient,
    (entityId, version) => { vectorIndexer?.index(entityId, version); });
  const pythonProjectDir = fileURLToPath(new URL('../python/', import.meta.url));
  const contactImport = graphClient === undefined ? undefined : new ContactImportService({
    graph: graphClient, uploads: uploadStore, jobs: importJobs,
    onEvent: event => logger.logContactImport(event),
    parse: (file, signal) => parseLocalDocument({
      pythonBin: config.contactPythonBin ?? join(pythonProjectDir, '.venv', 'bin', 'python'),
      workerSocket: config.contactWorkerSocket,
      projectDir: pythonProjectDir, filePath: file.tempPath,
      fileType: file.mime === 'application/pdf' ? 'pdf' : file.mime === 'image/png' ? 'png' : 'jpg',
      documentId: file.fileId,
      limits: { max_file_bytes: config.contactMaxFileBytes, max_pages: config.contactMaxPdfPages,
        max_page_pixels: config.contactMaxImagePixels, max_temp_bytes: config.contactMaxTempBytes },
    }, signal),
    extract: (blocks, file, signal) => new DocumentExtractor({
      url: config.arkApiUrl, model: config.arkModel, credential: config.arkCredential,
      fileName: file.fileName, fileSha256: file.sha256, collectedAt: file.uploadedAt,
      fileId: file.fileId,
      sourceType: file.mime === 'text/plain' ? 'text' : 'file',
      requestMaxBytes: config.contactExtractRequestMaxBytes,
      maxBatches: config.contactExtractMaxBatches,
      maxModelCalls: config.contactExtractMaxModelCalls,
    }).extract(blocks, signal),
    onCommitted: async entityIds => {
      if (!vectorIndexer) return;
      await Promise.all(entityIds.map(async entityId => {
        const detail = await graphClient.request<{ entity?: { label?: string };
          index_content_version?: number; index_status?: string } | null>('get_contact', { entity_id: entityId });
        if (detail?.entity?.label === 'Person' && detail.index_status === 'unindexed'
          && detail.index_content_version) {
          vectorIndexer.index(entityId, detail.index_content_version);
        }
      }));
    },
  });
  const uploadSessions = new UploadSessions((hash, actor) => tokenService.isEnabledHash(hash, actor),
    () => (overrides.now?.() ?? new Date()).getTime());
  const uploadHtml = () => readFile(new URL('../web/dist/contact-upload.html', import.meta.url), 'utf8');
  const baseUrl = /^localhost$|^127\.0\.0\.1$/.test(config.publicMcpHost)
    ? `http://${config.publicMcpHost}:${config.port}` : `https://${config.publicMcpHost}`;
  const snapshotSync = graphClient === undefined ? undefined : new SnapshotSync(contactSnapshots, graphClient);
  void snapshotSync?.schedule().catch(() => undefined);
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
    onBatch: event => logger.logContactExtraction(event),
  });
  const contactService = new ContactService({
    searchClient: {
      searchWeb: (query, signal) => {
        if (searchClient.searchWeb === undefined) {
          throw new UpstreamError(
            'doubao_search',
            'INVALID_RESPONSE',
            'Contact web search is unavailable',
          );
        }
        return searchClient.searchWeb(query, signal);
      },
    },
    extractor: contactExtractor,
    snapshots: contactSnapshots,
    findIdentity: query => {
      const key = normalizeLegalName(query);
      const rows = profiles.findByNormalizedNames([key]);
      return rows.length === 1 && normalizeLegalName(rows[0]!.identity.legalName) === key
        ? rows[0]!.identity : undefined;
    },
    limits: { search: config.maxSearchCalls, ark: config.maxArkCalls, total: config.maxTotalUpstreamCalls },
    onSnapshotAppended: snapshotSync === undefined ? undefined : () => snapshotSync.schedule(),
    cacheLogger: logger,
    now: overrides.now,
  });
  const profileService = new CompanyProfileService(qccGateway, profiles, {
    profileCacheTtlDays: config.profileCacheTtlDays,
    maxQccCalls: config.maxQccCalls,
    maxTotalCalls: config.maxTotalUpstreamCalls,
    now: overrides.now,
  });
  const questionService = new CompanyQuestionService({
    profiles, assessments, companyContext, profileTtlDays: config.profileCacheTtlDays,
    now: overrides.now,
    requestTimeoutMs: overrides.questionTimeoutMs,
    qccFactory: signal => overrides.qccGateway === undefined
      ? new QccGateway({
        urls: {
          company: config.qccMcpCompanyUrl, risk: config.qccMcpRiskUrl,
          ipr: config.qccMcpIprUrl, operation: config.qccMcpOperationUrl,
        },
        apiKey: config.qccApiKey, signal,
      })
      : { call: overrides.qccGateway.call.bind(overrides.qccGateway), close: async () => undefined },
    searchFactory: signal => overrides.searchClient ?? new DoubaoSearchClient({
      url: config.doubaoSearchApiUrl, apiKey: config.doubaoSearchApiKey,
      now: overrides.now, signal,
    }),
    answerFactory: signal => overrides.companyAnswer ?? new CompanyAnswerClient({
      url: config.arkApiUrl, model: config.arkModel, credential: config.arkCredential,
      requestMaxBytes: config.arkRequestMaxBytes, signal,
    }),
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
  const researchRepository = new ResearchRepository(database, {
    maxQueued: config.companyResearchMaxQueued,
    maxPerActor: config.companyResearchMaxPerUser,
    maxRunning: 1,
    now: overrides.now,
  });
  // Recovery changes only persisted state: no paid work is resumed after a process restart.
  researchRepository.recover();
  const confirmedProfile = (code: string, name: string) => {
    const profile = profiles.findFreshByCreditCode(
      code,
      overrides.now?.() ?? new Date(),
      config.profileCacheTtlDays,
    );
    return profile?.identity.creditCode === code &&
      profile.identity.legalName === name
      ? profile
      : null;
  };
  const researchService = new CompanyResearchService(researchRepository, {
    identityLookup: (code, name) => confirmedProfile(code, name) !== null,
  });
  const graphCollector = companyContext
    ? new GraphEvidenceCollector({
        organizations: companyContext,
        now: overrides.now,
      })
    : undefined;
  const researchRunner = new ResearchRunner({
    repository: researchRepository,
    limits: config.companyResearchLimits,
    clock: overrides.research?.clock,
    resultBuilder: buildResult,
    context: (run, dossier) => {
      const profile = confirmedProfile(dossier.credit_code, dossier.legal_name);
      if (!profile) throw new ResearchError('RESEARCH_IDENTITY_REQUIRED');
      const result: ResearchEvidence[] = [];
      const {
        collected_at: _collectedAt,
        legal_representative: _representative,
        ...businessProfile
      } = profile.basicProfile;
      const content = JSON.stringify(businessProfile);
      const cached = ingestEvidence(
        {
          source_type: 'qcc',
          tool: 'get_company_profile',
          record_id: sha256(`${dossier.credit_code}:get_company_profile`),
          url: null,
          content,
          collected_at: profile.collectedAt,
          published_at: null,
          company_scope: 'confirmed',
        },
        {
          title: '已确认企业基础画像',
          quote: content.slice(0, 2000),
          product_keys: run.request.product_keys,
          signal_kind: 'other',
        },
      );
      if (cached) result.push(cached);
      const latest = assessments.listCompleted(dossier.credit_code, 0, 1)
        .items[0];
      const assessment = latest ? assessments.get(latest.assessment_id) : null;
      if (
        assessment?.status === 'completed' &&
        assessment.creditCode === dossier.credit_code &&
        assessment.legalName === dossier.legal_name
      ) {
        const snapshot = assessment.evidenceSnapshot;
        for (const item of snapshot?.items ?? []) {
          if (
            !item.excerpt ||
            item.entityMatch !== 'confirmed' ||
            item.entityScope !== 'legal_entity'
          )
            continue;
          const facts = snapshot!.facts.filter((f) =>
            f.evidenceIds.includes(item.evidenceId),
          );
          const tags = run.request.product_keys.filter((p) =>
            facts.some((f) => f.productTags.includes(p)),
          );
          if (facts.some((f) => f.productTags.length > 0) && !tags.length)
            continue;
          // Generic business evidence still supplies the selected scope, never another product's rating.
          const evidence = ingestEvidence(
            {
              source_type: 'assessment',
              assessment_id: assessment.assessmentId,
              evidence_id: item.evidenceId,
              url: item.url,
              content: item.excerpt,
              collected_at: item.collectedAt,
              published_at: item.publishedAt,
              company_scope: item.entityMatch,
              ...(item.url ? { original_source_key: `web:${item.url}` } : {}),
            },
            {
              title: item.title.slice(0, 1000),
              quote: item.excerpt,
              product_keys: tags.length ? tags : run.request.product_keys,
              signal_kind: facts.some((f) => f.kind === 'recruitment')
                ? 'job_requirement'
                : 'other',
            },
          );
          if (evidence) result.push(evidence);
        }
      }
      return result;
    },
    sources:
      overrides.research?.sources ??
      ((context) => {
        const profile = confirmedProfile(
          context.dossier.credit_code,
          context.dossier.legal_name,
        );
        if (!profile) throw new ResearchError('RESEARCH_IDENTITY_REQUIRED');
        return createResearchSources(
          {
            qcc: {
              urls: {
                company: config.qccMcpCompanyUrl,
                risk: config.qccMcpRiskUrl,
                ipr: config.qccMcpIprUrl,
                operation: config.qccMcpOperationUrl,
              },
              apiKey: config.qccApiKey,
            },
            search: {
              url: config.doubaoSearchApiUrl,
              apiKey: config.doubaoSearchApiKey,
            },
          },
          {
            identity: profile.identity,
            scope: context.scope,
            policy: context.policy,
            prior: context.prior,
          },
          {
            ...overrides.research?.sourceDependencies,
            ...(graphClient && graphCollector
              ? {
                  graph: {
                    collector: graphCollector,
                    request: <T,>(
                      op: Parameters<GraphClient['request']>[0],
                      payload: object,
                      signal: AbortSignal,
                    ) => graphClient.request<T>(op, payload, signal),
                  },
                }
              : {}),
          },
        );
      }),
    model:
      overrides.research?.model ??
      ((context) =>
        new ArkResearchModel(
          {
            url: config.arkApiUrl,
            credential: config.arkCredential,
            model: config.arkModel,
            template: context.run.request.template,
            context: {
              company_identity: {
                credit_code: context.dossier.credit_code,
                legal_name: context.dossier.legal_name,
              },
              effective_goal: context.run.request.effective_goal,
              product_goals: context.run.request.product_goals,
            },
            requestMaxBytes: config.arkRequestMaxBytes,
            fetchFn: overrides.research?.modelFetch,
          },
          context.policy,
        )),
  });
  const researchQueue = new ResearchQueue(researchRepository, (id, signal) =>
    activity.track(() => researchRunner.run(id, signal)),
  );
  const companyLinks = graphClient && companyLinkRepository ? new CompanyLinkService({
    graph: graphClient, links: companyLinkRepository, profiles, now: overrides.now ?? (() => new Date()),
  }) : undefined;
  const servicesFor = (userId: string, token: string): McpServices => ({
    companyResearch: config.companyResearchEnabled
      ? { enabled: true, service: researchService, queue: researchQueue } : undefined,
    zohoContacts: zohoReady === undefined ? undefined : {
      connectionIds: config.zohoConnections.map(connection => connection.id),
      get: input => activity.track(async () => {
        const ready = await zohoReady;
        if (!ready) throw new Error('ZOHO_UNAVAILABLE');
        const result = await ready.service.get(input);
        await zohoGraphSync?.sync(result, userId);
        const binding = tokenService.get(userId);
        const bindingConnection = binding?.crmConnectionId ? findCrmConnection(config.zohoConnections, binding.crmConnectionId) : undefined;
        let identity: { connectionId: string; userId: string } | null = null;
        if (binding?.crmConnectionId && binding.crmOrgId && binding.crmUserId
          && result.connections.some(connection => connection.connection_id === bindingConnection?.id)) {
          try {
            const connection = bindingConnection;
            if (!connection || !ready.client.getOrganization)
              throw new Error('CRM_IDENTITY_UNVERIFIED');
            const orgId = await ready.client.getOrganization(connection.id,
              {deadlineAt:Date.now()+5000,signal:AbortSignal.timeout(5000)});
            if(orgId !== binding.crmOrgId) throw new Error('CRM_IDENTITY_UNVERIFIED');
            identity = { connectionId: connection.id, userId: binding.crmUserId };
          } catch { result.warnings.push('CRM_IDENTITY_UNVERIFIED：无法核验当前用户的 CRM 组织，负责人是否本人未知。'); }
        }
        return annotateZohoOwners(result, identity);
      }),
    },
    contactUpload: contactImport ? { actor: userId, sessions: uploadSessions, sourceTokenHash: tokenService.hash(token),
      baseUrl, html: uploadHtml } : undefined,
    companyContext, companyLinks,
    companyProfileOptions: { now: overrides.now, ttlDays: config.profileCacheTtlDays },
    contactLibrary,
    contactImport,
    contactSearch,
    contactSearchApp: contactSearch ? { html: () => readFile(new URL('../web/dist/contact-search-graph.html', import.meta.url), 'utf8') } : undefined,
    contactAnswer,
    vectorIndexer,
    getCompanyProfile: input => activity.track(() => profileService.get(input.query, input.regionHint)),
    submitAssessment: input => activity.track(() => assessmentService.submit(input, userId)),
    getAssessmentStatus: input => activity.track(() => assessmentService.status(input)),
    getAssessmentReport: input => activity.track(() => assessmentService.reportWithUpdates(input, companyContext, abortController.signal)),
    getContacts: input => activity.track(() => contactService.get(input)),
    askCompany: input => activity.track(() => questionService.ask(input, abortController.signal)),
  });
  const uploadsEnabled = process.env.NODE_ENV !== 'production' || !!config.contactWorkerSocket;
  const app = createHttpApp(config, token => tokenService.verify(token), servicesFor,
    uploadsEnabled ? uploadStore : undefined,
    contactImport ? { sessions: uploadSessions, imports: contactImport, html: uploadHtml } : undefined,
    config.tokenAdminKeySha256 ? createTokenAdminRouter({keyHash: config.tokenAdminKeySha256,
      publicMcpHost: config.publicMcpHost, service: tokenAdministration,
      audit: event => logger.logAdminTokenOperation(event)}) : undefined);

  let upstreamClosing: Promise<void> | null = null;
  const closeUpstreams = (): Promise<void> => {
    if (upstreamClosing !== null) return upstreamClosing;
    upstreamClosing = Promise.allSettled([
      qccGateway.close(),
      searchClient.close?.() ?? Promise.resolve(),
      ark.close?.() ?? Promise.resolve(),
      zohoReady?.then(ready => ready?.client.close()) ?? Promise.resolve(),
      graphClient?.close() ?? Promise.resolve(),
    ]).then(() => undefined);
    return upstreamClosing;
  };

  let server: Server | null = null;
  let closing: Promise<void> | null = null;
  return {
    tokenService,
    graphClient,
    uploadStore,
    importJobs,
    async listen(port = config.port, host = '0.0.0.0') {
      if (server !== null) throw new Error('Application is already listening');
      await uploadStore.cleanupOrphans();
      if (graphClient) {
        await graphClient.request('recover_import_jobs', {
          operation_id: `import-recovery:${randomUUID()}`, actor: 'system',
        });
        await graphClient.request('set_vector_state', {
          action: 'recover_interrupted', operation_id: `vector-recovery:${randomUUID()}`, actor: 'system',
        });
      }
      queue.start();
      server = app.listen(port, host);
      await new Promise<void>((resolve, reject) => {
        server!.once('listening', resolve);
        server!.once('error', reject);
      });
      if (config.companyResearchEnabled) researchQueue.start();
      return server;
    },
    close(timeoutMs = 30_000) {
      if (closing !== null) return closing;
      closing = (async () => {
        queue.stopAccepting();
        researchQueue.stopAccepting();
        const listenerClosed = server === null ? Promise.resolve() : closeServer(server);
        void listenerClosed.catch(() => undefined);
        const normalDrain = listenerClosed.then(async () => {
          await researchQueue.waitForActive();
          await activity.whenIdle();
        });
        const completedNormally = await waitAtMost(normalDrain, timeoutMs);
        if (completedNormally) {
          await importJobs.recover();
          await vectorIndexer?.whenIdle();
          await closeUpstreams();
          await app.closeMcpHandler();
        } else {
          researchQueue.abortActive();
          abortController.abort();
          await researchQueue.waitForActive();
          await importJobs.recover();
          await closeUpstreams();
          void app.closeMcpHandler().catch(() => undefined);
          server?.closeIdleConnections();
          server?.closeAllConnections();
          await activity.whenIdle();
        }
        database.close();
        await uploadStore.close();
        if (ephemeralUploads) rmSync(uploadDirectory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}

export async function startApplication(env: NodeJS.ProcessEnv = process.env): Promise<RunningApplication> {
  const runtime = createApplication(loadConfig(env));
  try { await runtime.listen(); }
  catch (error) { await runtime.close().catch(() => undefined); throw error; }
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
  void main().catch(error => {
    process.stderr.write(formatStartupFailure(error));
    process.exitCode = 1;
  });
}
