import {
  EvidenceBundleSchema,
  ResearchBundleSchema,
  type AssessmentResultAudit,
  type EvidenceBundle,
  type IdentityProfile,
  type ReportModel,
  type ResearchBundle,
  type ResearchItem,
  type ResearchSourceStatus,
} from '../contracts/index.js';
import type {
  AssessmentCompletion,
  AssessmentRecord,
} from '../db/assessment-repository.js';
import type { StoredCompanyProfile } from '../db/profile-repository.js';
import type { JsonlLogger } from '../logging/logger.js';
import { evaluateOpportunities } from '../opportunity/evaluate-all.js';
import { buildReportModel } from '../report/build-report-model.js';
import { renderMarkdown } from '../report/render-markdown.js';
import type { SourceCollection } from '../upstream/qcc/assessment-research.js';
import type { ArkEvidenceExtraction } from '../upstream/ark/client.js';
import { buildSearchPlan } from '../upstream/search/search-plan.js';
import { CallBudget, type CallBudgetLimits, type UpstreamSource } from './call-budget.js';
import {
  retryOnce,
  safeUpstreamErrorMessage,
  UpstreamError,
  type RetryOptions,
} from './retry.js';

interface AssessmentStore {
  get(assessmentId: string): AssessmentRecord | null;
  completeAssessment(assessmentId: string, result: AssessmentCompletion, now: Date): AssessmentRecord;
  failAssessment(assessmentId: string, errorMessage: string, now: Date): AssessmentRecord;
}

interface ProfileStore {
  findFreshByCreditCode(creditCode: string, now: Date, ttlDays: number): StoredCompanyProfile | null;
}

interface QccResearchSource {
  collectQccResearch(identity: IdentityProfile, budget: CallBudget, retryOptions?: RetryOptions): Promise<SourceCollection>;
}

interface SearchClient {
  search(query: ReturnType<typeof buildSearchPlan>[number]): Promise<ResearchItem[]>;
}

interface ArkSource {
  extractWithAudit(bundle: ResearchBundle): Promise<ArkEvidenceExtraction>;
}

export interface AssessmentRunnerOptions {
  assessments: AssessmentStore;
  profiles: ProfileStore;
  qccResearch: QccResearchSource;
  searchClient: SearchClient;
  ark: ArkSource;
  logger: JsonlLogger;
  profileCacheTtlDays: number;
  budgetLimits: CallBudgetLimits;
  now?: () => Date;
  opportunityEvaluator?: typeof evaluateOpportunities;
  reportModelBuilder?: typeof buildReportModel;
  markdownRenderer?: typeof renderMarkdown;
  signal?: AbortSignal;
}

export class AssessmentWorkerError extends Error {
  override readonly name = 'AssessmentWorkerError';

  constructor(readonly code: 'ASSESSMENT_STATE_UNAVAILABLE') {
    super('Assessment worker state could not be persisted');
  }
}

function safeCaughtError(source: UpstreamSource, error: unknown): string {
  const code = error instanceof UpstreamError && error.source === source
    ? error.code
    : 'UPSTREAM_FAILED';
  return safeUpstreamErrorMessage(source, code);
}

function failedCollection(label: string, source: UpstreamSource, error: unknown): SourceCollection {
  const safeError = safeCaughtError(source, error);
  return {
    items: [],
    sourceStatus: { status: 'failed', error: safeError },
    gaps: [`${label}：${safeError}`],
  };
}

export class AssessmentRunner {
  private readonly now: () => Date;
  private readonly opportunityEvaluator: typeof evaluateOpportunities;
  private readonly reportModelBuilder: typeof buildReportModel;
  private readonly markdownRenderer: typeof renderMarkdown;

  constructor(private readonly options: AssessmentRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.opportunityEvaluator = options.opportunityEvaluator ?? evaluateOpportunities;
    this.reportModelBuilder = options.reportModelBuilder ?? buildReportModel;
    this.markdownRenderer = options.markdownRenderer ?? renderMarkdown;
  }

  async run(assessmentId: string): Promise<void> {
    let task: AssessmentRecord | null;
    try {
      task = this.options.assessments.get(assessmentId);
    } catch {
      this.failById(assessmentId, '体检任务处理失败');
      return;
    }
    if (task === null || task.status !== 'processing') return;
    if (this.stopIfAborted(task)) return;
    try {
      const startedAt = this.now();
      const profile = this.options.profiles.findFreshByCreditCode(
        task.creditCode,
        startedAt,
        this.options.profileCacheTtlDays,
      );
      if (profile === null
        || profile.identity.creditCode !== task.creditCode
        || profile.identity.legalName !== task.legalName) {
        this.fail(task, '主体信息不可用');
        return;
      }
      if (this.stopIfAborted(task)) return;

      const budget = new CallBudget(this.options.budgetLimits, {
        reserveArkCalls: Math.min(2, this.options.budgetLimits.ark),
      });
      const retryOptions = this.retryOptions(task);
      const qccPromise = this.options.qccResearch
        .collectQccResearch(profile.identity, budget, retryOptions)
        .catch(error => failedCollection('企查查信息获取失败', 'qcc', error));
      const searchPromise = this.collectSearch(profile.identity, budget, retryOptions)
        .catch(error => failedCollection('豆包搜索信息获取失败', 'doubao_search', error));
      const [qcc, search] = await Promise.all([qccPromise, searchPromise]);
      if (this.stopIfAborted(task)) return;
      const research = ResearchBundleSchema.parse({
        identity: profile.identity,
        items: [...qcc.items, ...search.items],
        sourceStatus: { qcc: qcc.sourceStatus, doubaoSearch: search.sourceStatus },
        gaps: [...new Set([...qcc.gaps, ...search.gaps])],
        collectedAt: this.now().toISOString(),
      });

      const extracted = await retryOnce(
        'ark',
        budget,
        () => this.options.ark.extractWithAudit(research),
        retryOptions,
      );
      if (this.stopIfAborted(task)) return;
      if (extracted.status === 'failed') {
        this.fail(task, '模型事实整理不可用');
        return;
      }

      try {
        const evidence = EvidenceBundleSchema.parse(extracted.value.evidence);
        const assessment = this.opportunityEvaluator(evidence, this.now());
        const sourceStatus: ReportModel['sourceStatus'] = {
          qcc: qcc.sourceStatus.status,
          doubaoSearch: search.sourceStatus.status,
          ark: 'completed',
        };
        const model = this.reportModelBuilder(profile.identity, evidence, assessment, sourceStatus);
        const markdown = this.markdownRenderer(model);
        const resultAudit: AssessmentResultAudit = {
          industryLabel: evidence.industryLabel,
          industryEvidenceIds: evidence.industryEvidenceIds,
          evidenceSelection: {
            selectedEvidenceIds: [...new Set(extracted.value.selection.bundle.items.map(item => item.evidenceId))],
            originalCount: extracted.value.selection.originalCount,
            selectedCount: extracted.value.selection.selectedCount,
            excludedCount: extracted.value.selection.excludedCount,
            categoryCounts: extracted.value.selection.categoryCounts,
            researchBytes: extracted.value.selection.researchBytes,
            requestBytes: extracted.value.requestBytes,
            batchCount: 1,
            successfulBatchCount: 1,
            failedBatchCount: 0,
            processedCount: extracted.value.selection.selectedCount,
            unprocessedCount: extracted.value.selection.excludedCount,
            deduplicatedCount: 0,
          },
          opportunities: assessment.products.map(product => ({
            product: product.product,
            level: product.level,
            evidenceIds: product.evidenceIds,
          })),
        };
        if (this.stopIfAborted(task)) return;
        this.options.assessments.completeAssessment(task.assessmentId, {
          reportMarkdown: markdown,
          recommendedProduct: model.recommendedProduct,
          overallOpportunity: model.overallOpportunity,
          sourceStatus: model.sourceStatus,
          collectedAt: model.collectedAt,
          resultAudit,
        }, this.now());
        try {
          this.options.logger.logAssessmentDecision({
            assessmentId: task.assessmentId,
            userId: task.requestedBy,
            resultAudit,
          });
        } catch {
          // Assessment persistence is authoritative; logging failures must not reverse completion.
        }
      } catch {
        this.fail(task, '体检报告生成或保存失败');
      }
    } catch {
      this.fail(task, this.options.signal?.aborted === true ? '体检任务已取消' : '体检任务处理失败');
    }
  }

  private async collectSearch(
    identity: IdentityProfile,
    budget: CallBudget,
    retryOptions: RetryOptions,
  ): Promise<SourceCollection> {
    const items: ResearchItem[] = [];
    const gaps: string[] = [];
    const errors: string[] = [];
    let failedCalls = 0;
    let stoppedByBudget = false;
    const plan = buildSearchPlan(identity);

    for (const query of plan) {
      if (!budget.canConsume('doubao_search')) {
        stoppedByBudget = true;
        gaps.push('豆包搜索调用预算已用尽');
        break;
      }
      const result = await retryOnce(
        'doubao_search',
        budget,
        () => this.options.searchClient.search(query),
        retryOptions,
      );
      if (result.status === 'completed') {
        items.push(...result.value);
      } else {
        failedCalls += 1;
        errors.push(safeUpstreamErrorMessage('doubao_search', result.error.code));
        gaps.push(`豆包搜索查询失败：${query.purpose}`);
        if (result.error.code === 'BUDGET_EXHAUSTED') stoppedByBudget = true;
      }
    }

    const status: ResearchSourceStatus = items.length === 0
      ? 'failed'
      : failedCalls > 0 || stoppedByBudget ? 'partial' : 'completed';
    return {
      items,
      sourceStatus: {
        status,
        error: status === 'failed' ? errors[0] ?? '豆包搜索未返回可用资料' : errors[0] ?? null,
      },
      gaps: [...new Set(gaps)],
    };
  }

  private retryOptions(task: AssessmentRecord): RetryOptions {
    return {
      onAttempt: event => this.options.logger.logUpstreamAttempt({
        assessmentId: task.assessmentId,
        userId: task.requestedBy,
        ...event,
      }),
    };
  }

  private fail(task: AssessmentRecord, message: string): void {
    this.failById(task.assessmentId, message);
  }

  private stopIfAborted(task: AssessmentRecord): boolean {
    if (this.options.signal?.aborted !== true) return false;
    this.fail(task, '体检任务已取消');
    return true;
  }

  private failById(assessmentId: string, message: string): void {
    try {
      this.options.assessments.failAssessment(assessmentId, message, this.now());
    } catch {
      throw new AssessmentWorkerError('ASSESSMENT_STATE_UNAVAILABLE');
    }
  }
}
