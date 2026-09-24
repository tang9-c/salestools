import { McpServer } from '@modelcontextprotocol/server';
import type { OpportunityLevel, ProductKey, ResearchSourceStatus } from '../contracts/index.js';
import type { ContactServiceOutput } from '../contacts/contact-service.js';
import type { CompanyQuestionInput } from '../orchestration/company-question-service.js';
import type { CompanyQuestionResult } from '../contracts/index.js';
import {
  AssessmentIdInputSchema,
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
  dynamicSignalFreshness: 'current' | 'stale';
  sourceStatus: {
    qcc: ResearchSourceStatus;
    doubaoSearch: ResearchSourceStatus;
    ark: 'completed' | 'partial';
  };
  markdown: string;
};

export interface McpServices {
  getCompanyProfile(input: CompanyProfileServiceInput): Awaitable<CompanyProfileServiceOutput>;
  submitAssessment(input: SubmitAssessmentServiceInput, userId: string): Awaitable<SubmitAssessmentServiceOutput>;
  getAssessmentStatus(input: AssessmentServiceInput): Awaitable<AssessmentStatusServiceOutput>;
  getAssessmentReport(input: AssessmentServiceInput): Awaitable<AssessmentReportServiceOutput>;
  getContacts(input: CompanyProfileServiceInput): Awaitable<ContactServiceOutput>;
  askCompany(input: CompanyQuestionInput): Awaitable<CompanyQuestionResult>;
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

  server.registerTool('get_company_profile', {
    description: 'Default tool for basic company-profile lookups and ambiguous requests; use it before any formal assessment.',
    inputSchema: CompanyProfileInputSchema,
    outputSchema: CompanyProfileOutputSchema,
  }, async input => toolResult(companyProfileOutput(await services.getCompanyProfile({
    query: input.query,
    ...(input.region_hint === undefined ? {} : { regionHint: input.region_hint }),
  }))));

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
    inputSchema: AssessmentIdInputSchema,
    outputSchema: AssessmentReportOutputSchema,
  }, async ({ assessment_id }) => toolResult(assessmentReportOutput(await services.getAssessmentReport({
    assessmentId: assessment_id,
  }))));

  server.registerTool('get_contacts', {
    description: '查询公开网页中的当前关键岗位职业身份和历史任职证据；历史证据不代表已离职，不返回邮箱或电话，也不保证法人主体已确认。',
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
