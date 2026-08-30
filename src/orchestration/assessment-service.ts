import type {
  AssessmentRecord,
  AssessmentRepository,
} from '../db/assessment-repository.js';
import { AssessmentNotFoundError } from '../db/assessment-repository.js';
import { presentStoredReport } from '../report/render-markdown.js';

export interface AssessmentEnqueuer {
  enqueue(assessmentId: string): boolean;
}

export interface AssessmentServiceOptions {
  assessments: AssessmentRepository;
  queue: AssessmentEnqueuer;
  assessmentCacheTtlDays: number;
  now?: () => Date;
  signal?: AbortSignal;
}

export class AssessmentService {
  private readonly now: () => Date;

  constructor(private readonly options: AssessmentServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  submit(
    input: { legalName: string; creditCode: string; forceRefresh: boolean },
    userId: string,
  ) {
    if (isAborted(this.options.signal)) {
      throw new Error('Assessment service is shutting down');
    }
    const result = this.options.assessments.createOrReuseAssessment({
      requestedBy: userId,
      legalName: input.legalName,
      creditCode: input.creditCode,
    }, input.forceRefresh, this.now(), this.options.assessmentCacheTtlDays);

    if (result.cacheHit) {
      if (result.cachedAt === null) throw new Error('Cached assessment is missing completedAt');
      return {
        assessmentId: result.record.assessmentId,
        status: 'completed' as const,
        cacheHit: true as const,
        cachedAt: result.cachedAt,
      };
    }

    if (result.created) {
      if (isAborted(this.options.signal)) {
        this.options.assessments.failAssessment(
          result.record.assessmentId,
          'Assessment rejected during service shutdown',
          this.now(),
        );
        throw new Error('Assessment service is shutting down');
      }
      try {
        this.options.queue.enqueue(result.record.assessmentId);
      } catch (error) {
        this.options.assessments.failAssessment(
          result.record.assessmentId,
          'Assessment rejected during service shutdown',
          this.now(),
        );
        throw error;
      }
    }
    return {
      assessmentId: result.record.assessmentId,
      status: 'processing' as const,
      estimatedMinutes: '5-10' as const,
      cacheHit: false as const,
    };
  }

  status(input: { assessmentId: string }) {
    const record = this.required(input.assessmentId);
    return {
      assessmentId: record.assessmentId,
      status: record.status,
      message: statusMessage(record),
    };
  }

  report(input: { assessmentId: string }) {
    const record = this.required(input.assessmentId);
    if (record.status !== 'completed') {
      return {
        assessmentId: record.assessmentId,
        status: record.status,
        message: statusMessage(record),
      } as const;
    }
    if (record.reportMarkdown === null
      || record.overallOpportunity === null
      || record.sourceStatus === null
      || record.collectedAt === null
      || record.completedAt === null) {
      throw new Error(`Completed assessment is incomplete: ${record.assessmentId}`);
    }
    const presentation = presentStoredReport(record.reportMarkdown, record.completedAt, this.now());
    return {
      assessmentId: record.assessmentId,
      status: 'completed' as const,
      legalName: record.legalName,
      overallOpportunity: record.overallOpportunity,
      recommendedProduct: record.recommendedProduct,
      collectedAt: record.collectedAt,
      dynamicSignalFreshness: presentation.dynamicSignalFreshness,
      sourceStatus: record.sourceStatus,
      markdown: presentation.markdown,
    };
  }

  failInterruptedAssessments(): number {
    return this.options.assessments.failInterruptedAssessments(this.now());
  }

  private required(assessmentId: string): AssessmentRecord {
    const record = this.options.assessments.get(assessmentId);
    if (record === null) throw new AssessmentNotFoundError(assessmentId);
    return record;
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function statusMessage(record: AssessmentRecord): string {
  if (record.status === 'processing') return '正在收集公开资料';
  if (record.status === 'completed') return '体检报告已完成';
  return record.errorMessage ?? '体检任务失败';
}
