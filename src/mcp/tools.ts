import type { CompanyContextService } from '../companies/company-context-service.js';
import type { CompanyLinkService } from '../companies/company-link.js';
import type { RelatedUpdates } from '../companies/company-context-types.js';
import { CompanyOverviewSchema } from '../contracts/company-context.js';
import { unavailableOverview } from './company-context-output.js';
import { registerCompanyLinkTools } from './company-link-tools.js';
import { McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import type { UploadSessions } from '../contacts/upload-session.js';
import type { OpportunityLevel, ProductKey, ResearchSourceStatus } from '../contracts/index.js';
import type { ContactServiceOutput } from '../contacts/contact-service.js';
import type { ContactLibraryService } from '../contacts/library-service.js';
import type { ContactImportService } from '../contacts/import-service.js';
import type { ContactSearch } from '../contacts/contact-search.js';
import type { VectorIndexer } from '../contacts/vector-indexer.js';
import type { ContactAnswerService } from '../contacts/contact-answer.js';
import type { CompanyQuestionInput } from '../orchestration/company-question-service.js';
import type { CompanyQuestionResult } from '../contracts/index.js';
import {
  AssessmentIdInputSchema,
  AssessmentReportInputSchema,
  AssessmentReportOutputSchema,
  AssessmentStatusOutputSchema,
  CompanyProfileInputSchema,
  CompanyProfileOutputSchema,
  GetContactsInputSchema,
  GetContactsOutputSchema,
  AskCompanyInputSchema,
  AskCompanyOutputSchema,
  SubmitAssessmentInputSchema,
  SubmitAssessmentOutputSchema,
} from './tool-schemas.js';
import { registerContactTools } from './contact-tools.js';
import { registerContactImportTools } from './contact-import-tools.js';
import { registerContactSearchTools } from './contact-search-tools.js';
import { registerContactAnswerTools } from './contact-answer-tools.js';

type Awaitable<T> = T | Promise<T>;

export interface CompanyProfileServiceInput {
  query: string;
  regionHint?: string;
}

export interface SubmitAssessmentServiceInput {
  legalName: string;
  creditCode: string;
  forceRefresh: boolean;
}

export interface AssessmentServiceInput {
  assessmentId: string;
}

export interface CandidateServiceOutput {
  legalName: string;
  creditCode: string;
  status: string | null;
  registeredAddress: string | null;
  matchReason: string;
}

export interface BasicProfileServiceOutput {
  industry: string | null;
  region: string | null;
  companyType: string | null;
  foundedYear: number | null;
  registeredCapital: string | null;
  legalRepresentative: string | null;
  website: string | null;
  employeeRange: string | null;
  riskSummary: string | null;
  collectedAt: string;
}

export type CompanyProfileServiceOutput = {
  sourceStatus: 'completed';
  candidates: CandidateServiceOutput[];
  basicProfile: BasicProfileServiceOutput | null;
  cacheHit: boolean;
} | {
  sourceStatus: 'failed';
  candidates: CandidateServiceOutput[];
  basicProfile: null;
  cacheHit: false;
  message: string;
};

export type SubmitAssessmentServiceOutput = {
  assessmentId: string;
  status: 'processing';
  estimatedMinutes: '5-40';
  cacheHit: false;
} | {
  assessmentId: string;
  status: 'completed';
  cacheHit: true;
  cachedAt: string;
};

export interface AssessmentStatusServiceOutput {
  assessmentId: string;
  status: 'processing' | 'completed' | 'failed';
  message: string;
}

export type AssessmentReportServiceOutput = {
  assessmentId: string;
  status: 'processing' | 'failed';
  message: string;
} | {
  assessmentId: string;
  status: 'completed';
  legalName: string;
  overallOpportunity: OpportunityLevel;
  recommendedProduct: ProductKey | null;
  collectedAt: string;
  generatedAt?: string;
  relatedUpdates?: RelatedUpdates;
  dynamicSignalFreshness: 'current' | 'stale';
  sourceStatus: {
    qcc: ResearchSourceStatus;
    doubaoSearch: ResearchSourceStatus;
    ark: 'completed' | 'partial';
  };
  markdown: string;
};

export interface McpServices {
  contactUpload?: {
    actor: string;
    sessions: UploadSessions;
    sourceTokenHash: string;
    baseUrl: string;
    html: () => Promise<string>;
  };
  getCompanyProfile(input: CompanyProfileServiceInput): Awaitable<CompanyProfileServiceOutput>;
  submitAssessment(input: SubmitAssessmentServiceInput, userId: string): Awaitable<SubmitAssessmentServiceOutput>;
  getAssessmentStatus(input: AssessmentServiceInput): Awaitable<AssessmentStatusServiceOutput>;
  getAssessmentReport(input: AssessmentServiceInput & { includeRelatedUpdates?: boolean }): Awaitable<AssessmentReportServiceOutput>;
  getContacts(input: CompanyProfileServiceInput): Awaitable<ContactServiceOutput>;
  askCompany(input: CompanyQuestionInput): Awaitable<CompanyQuestionResult>;
  companyContext?: Pick<CompanyContextService, 'detail' | 'summaries' | 'overview' | 'relatedUpdates'>;
  companyLinks?: Pick<CompanyLinkService, 'change'>;
  companyProfileOptions?: { now?: () => Date; ttlDays?: number };
  contactLibrary?: ContactLibraryService;
  contactImport?: ContactImportService;
  contactSearch?: ContactSearch;
  contactSearchApp?: { html: () => Promise<string> };
  vectorIndexer?: VectorIndexer;
  contactAnswer?: ContactAnswerService;
}

export type { ContactServiceOutput } from '../contacts/contact-service.js';

function toolResult<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function companyProfileOutput(output: CompanyProfileServiceOutput) {
  const candidates = output.candidates.map(candidate => ({
    legal_name: candidate.legalName,
    credit_code: candidate.creditCode,
    status: candidate.status,
    registered_address: candidate.registeredAddress,
    match_reason: candidate.matchReason,
  }));
  const basicProfile = output.basicProfile === null ? null : {
    industry: output.basicProfile.industry,
    region: output.basicProfile.region,
    company_type: output.basicProfile.companyType,
    founded_year: output.basicProfile.foundedYear,
    registered_capital: output.basicProfile.registeredCapital,
    legal_representative: output.basicProfile.legalRepresentative,
    website: output.basicProfile.website,
    employee_range: output.basicProfile.employeeRange,
    risk_summary: output.basicProfile.riskSummary,
    collected_at: output.basicProfile.collectedAt,
  };
  return CompanyProfileOutputSchema.parse(output.sourceStatus === 'failed' ? {
    source_status: output.sourceStatus,
    candidates,
    basic_profile: basicProfile,
    cache_hit: output.cacheHit,
    message: output.message,
  } : {
    source_status: output.sourceStatus,
    candidates,
    basic_profile: basicProfile,
    cache_hit: output.cacheHit,
  });
}

function submitAssessmentOutput(output: SubmitAssessmentServiceOutput) {
  return SubmitAssessmentOutputSchema.parse(output.status === 'processing' ? {
    assessment_id: output.assessmentId,
    status: output.status,
    estimated_minutes: output.estimatedMinutes,
    cache_hit: output.cacheHit,
  } : {
    assessment_id: output.assessmentId,
    status: output.status,
    cache_hit: output.cacheHit,
    cached_at: output.cachedAt,
  });
}

function assessmentStatusOutput(output: AssessmentStatusServiceOutput) {
  return AssessmentStatusOutputSchema.parse({
    assessment_id: output.assessmentId,
    status: output.status,
    message: output.message,
  });
}

function assessmentReportOutput(output: AssessmentReportServiceOutput) {
  return AssessmentReportOutputSchema.parse(output.status === 'completed' ? {
    assessment_id: output.assessmentId,
    status: output.status,
    legal_name: output.legalName,
    overall_opportunity: output.overallOpportunity,
    recommended_product: output.recommendedProduct,
    collected_at: output.collectedAt,
    ...(output.generatedAt === undefined ? {} : { generated_at: output.generatedAt }),
    ...(output.relatedUpdates === undefined ? {} : { related_updates: output.relatedUpdates }),
    dynamic_signal_freshness: output.dynamicSignalFreshness,
    source_status: {
      qcc: output.sourceStatus.qcc,
      doubao_search: output.sourceStatus.doubaoSearch,
      ark: output.sourceStatus.ark,
    },
    markdown: output.markdown,
  } : {
    assessment_id: output.assessmentId,
    status: output.status,
    message: output.message,
  });
}

function contactsOutput(output: ContactServiceOutput) {
  return GetContactsOutputSchema.parse({
    companies: output.companies.map(company => ({
      company_name: company.companyName,
      contacts: company.contacts.map(contact => ({
        name: contact.name,
        title: contact.title,
        source_url: contact.sourceUrl,
        published_at: contact.publishedAt,
      })),
      historical_contacts: company.historicalContacts.map(contact => ({
        name: contact.name,
        title: contact.title,
        source_url: contact.sourceUrl,
        published_at: contact.publishedAt,
        first_seen_at: contact.firstSeenAt,
        last_seen_at: contact.lastSeenAt,
        status: contact.status,
      })),
    })),
    warnings: output.warnings,
    collected_at: output.collectedAt,
  });
}

export function buildMcpServer(services: McpServices): McpServer {
  const server = new McpServer({ name: 'target-customer-assessment', version: '0.1.0' });

  if (services.contactUpload) {
    const upload = services.contactUpload;
    const resourceUri = 'ui://salestools/contact-upload.html';
    registerAppTool(server, 'open_contact_upload', {
      title: '选择 PDF 或拍摄名片',
      description: '打开联系人文件上传界面。若客户端不支持内嵌界面，请使用返回的短时链接。',
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri } },
    }, async () => {
      const { code } = upload.sessions.createHandoff(upload.actor, upload.sourceTokenHash);
      const url = `${upload.baseUrl}/contact-upload#code=${encodeURIComponent(code)}`;
      return { content: [{ type: 'text' as const, text: `打开上传页面：${url}` }],
        structuredContent: { fallback_url: url } };
    });
    registerAppTool(server, 'create_contact_upload_session', {
      title: '创建联系人上传会话',
      description: '仅供联系人上传界面调用。',
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    }, async () => {
      const session = upload.sessions.create(upload.actor, upload.sourceTokenHash);
      return { content: [{ type: 'text' as const, text: JSON.stringify(session) }],
        structuredContent: { ...session, base_url: upload.baseUrl } };
    });
    registerAppResource(server, '联系人文件上传', resourceUri,
      { mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{
        uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: await upload.html(),
        _meta: { ui: { csp: { connectDomains: [upload.baseUrl] } } },
      }] }));
  }

  if (services.contactLibrary) registerContactTools(server, services.contactLibrary, services.companyContext, services.companyProfileOptions);
  if (services.contactImport) registerContactImportTools(server, services.contactImport);
  if (services.contactSearch) registerContactSearchTools(server, services.contactSearch, services.vectorIndexer, services.contactSearchApp, services.companyContext);
  if (services.contactAnswer) registerContactAnswerTools(server, services.contactAnswer);

  if (services.companyLinks) registerCompanyLinkTools(server, services.companyLinks);

  server.registerTool('get_company_profile', {
    description: 'Default tool for basic company-profile lookups and ambiguous requests; use it before any formal assessment.',
    inputSchema: CompanyProfileInputSchema,
    outputSchema: CompanyProfileOutputSchema,
  }, async input => {
    const output = companyProfileOutput(await services.getCompanyProfile({
      query: input.query,
      ...(input.region_hint === undefined ? {} : { regionHint: input.region_hint }),
    }));
    if (!input.include_company_context || output.source_status !== 'completed'
      || output.candidates.length !== 1 || output.basic_profile === null) return toolResult(output);
    let overview = unavailableOverview(services.companyContext ? 'unavailable' : 'not_applicable');
    try { if (services.companyContext) overview = await services.companyContext.overview(output.candidates[0]!.credit_code); }
    catch (error) { if (error instanceof Error && error.name === 'AbortError') throw error; }
    return toolResult(CompanyProfileOutputSchema.parse({ ...output, company_context: CompanyOverviewSchema.parse(overview) }));
  });

  server.registerTool('submit_assessment', {
    description: 'Use only for an explicit formal assessment after the user confirms legal_name and credit_code.',
    inputSchema: SubmitAssessmentInputSchema,
    outputSchema: SubmitAssessmentOutputSchema,
  }, async (input, context) => toolResult(submitAssessmentOutput(await services.submitAssessment({
    legalName: input.legal_name,
    creditCode: input.credit_code,
    forceRefresh: input.force_refresh,
  }, context.http?.authInfo?.clientId ?? ''))));

  server.registerTool('get_assessment_status', {
    description: 'Get the processing status of a previously submitted assessment.',
    inputSchema: AssessmentIdInputSchema,
    outputSchema: AssessmentStatusOutputSchema,
  }, async ({ assessment_id }) => toolResult(assessmentStatusOutput(await services.getAssessmentStatus({
    assessmentId: assessment_id,
  }))));

  server.registerTool('get_assessment_report', {
    description: 'Read a completed assessment report, or its current processing or failure state.',
    inputSchema: AssessmentReportInputSchema,
    outputSchema: AssessmentReportOutputSchema,
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ assessment_id, include_related_updates }) => toolResult(assessmentReportOutput(await services.getAssessmentReport({
    assessmentId: assessment_id, includeRelatedUpdates: include_related_updates,
  }))));

  server.registerTool('discover_contacts', {
    description: '从公开网页发现企业关键岗位人员和历史任职证据；不是 search_contacts 的共享图谱搜索或 get_contact 的档案读取。历史证据不代表已离职，不返回邮箱或电话，也不保证法人主体已确认。',
    inputSchema: GetContactsInputSchema,
    outputSchema: GetContactsOutputSchema,
  }, async input => toolResult(contactsOutput(await services.getContacts({
    query: input.query,
    ...(input.region_hint === undefined ? {} : { regionHint: input.region_hint }),
  }))));

  server.registerTool('ask_company', {
    description: '针对已确认的单个法定主体追问具体销售研究问题；优先引用报告证据，必要时定向补查，不修改原评估。',
    inputSchema: AskCompanyInputSchema,
    outputSchema: AskCompanyOutputSchema,
  }, async input => {
    const answer = await services.askCompany({
    legalName: input.legal_name,
    creditCode: input.credit_code,
    question: input.question,
    ...(input.assessment_id === undefined ? {} : { assessmentId: input.assessment_id }),
    });
    return toolResult(AskCompanyOutputSchema.parse({
      status: answer.status, legal_name: answer.legalName, markdown: answer.markdown,
      used_fresh_research: answer.usedFreshResearch, collected_at: answer.collectedAt,
      sources: answer.sources.map(source => ({
        title: source.title, source: source.source, url: source.url,
        published_at: source.publishedAt,
      })),
    }));
  });

  return server;
}
