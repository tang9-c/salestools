import {
  EvidenceBundleSchema,
  ResearchBundleSchema,
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
import { buildSearchPlan } from '../upstream/search/search-plan.js';
import { CallBudget, type CallBudgetLimits } from './call-budget.js';
import { retryOnce, type RetryOptions } from './retry.js';

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
  extract(bundle: ResearchBundle): Promise<EvidenceBundle>;
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
}

function failedCollection(message: string): SourceCollection {
  return {
    items: [],
    sourceStatus: { status: 'failed', error: message },
    gaps: [message],
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
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
    const task = this.options.assessments.get(assessmentId);
    if (task === null || task.status !== 'processing') return;
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

      const budget = new CallBudget(this.options.budgetLimits);
      const retryOptions = this.retryOptions(task);
      const qccPromise = this.options.qccResearch
        .collectQccResearch(profile.identity, budget, retryOptions)
        .catch(error => failedCollection(`企查查信息获取失败：${errorMessage(error, '未知错误')}`));
      const searchPromise = this.collectSearch(profile.identity, budget, retryOptions)
        .catch(error => failedCollection(`豆包搜索信息获取失败：${errorMessage(error, '未知错误')}`));
      const [qcc, search] = await Promise.all([qccPromise, searchPromise]);
      const research = ResearchBundleSchema.parse({
        identity: profile.identity,
        items: [...qcc.items, ...search.items],
        sourceStatus: { qcc: qcc.sourceStatus, doubaoSearch: search.sourceStatus },
        gaps: [...new Set([...qcc.gaps, ...search.gaps])],
        collectedAt: this.now().toISOString(),
      });

      const extracted = await retryOnce('ark', budget, () => this.options.ark.extract(research), retryOptions);
      if (extracted.status === 'failed') {
        this.fail(task, '模型事实整理不可用');
        return;
      }

      try {
        const evidence = EvidenceBundleSchema.parse(extracted.value);
        const assessment = this.opportunityEvaluator(evidence, this.now());
        const sourceStatus: ReportModel['sourceStatus'] = {
          qcc: qcc.sourceStatus.status,
          doubaoSearch: search.sourceStatus.status,
          ark: 'completed',
        };
        const model = this.reportModelBuilder(profile.identity, evidence, assessment, sourceStatus);
        const markdown = this.markdownRenderer(model);
        this.options.assessments.completeAssessment(task.assessmentId, {
          reportMarkdown: markdown,
          recommendedProduct: model.recommendedProduct,
          overallOpportunity: model.overallOpportunity,
          sourceStatus: model.sourceStatus,
          collectedAt: model.collectedAt,
        }, this.now());
      } catch {
        this.fail(task, '体检报告生成或保存失败');
      }
    } catch {
      this.fail(task, '体检任务处理失败');
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
        errors.push(result.error.message);
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
    try {
      this.options.assessments.failAssessment(task.assessmentId, message, this.now());
    } catch {
      // If SQLite itself is unavailable there is no second persistence channel in v0.1.
    }
  }
}
