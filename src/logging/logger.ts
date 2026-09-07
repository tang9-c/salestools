import {
  AssessmentResultAuditSchema,
  type AssessmentResultAudit,
} from '../contracts/index.js';
import type { RetryAttemptEvent } from '../orchestration/retry.js';

export interface LogSink {
  write(line: string): void;
}

export type UpstreamAttemptLog = RetryAttemptEvent & Readonly<{
  assessmentId: string;
  userId: string;
  batchIndex?: number;
}>;

export type AssessmentDecisionLog = Readonly<{
  assessmentId: string;
  userId: string;
  resultAudit: AssessmentResultAudit;
}>;

const AUTHORIZATION_PATTERN = /(authorization["']?\s*[:=]\s*)(?:bearer\s+)?[^\s,;}\]]+/giu;
const SECRET_FIELD_PATTERN = /((?:api[_-]?key|token|credential|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu;
const BEARER_PATTERN = /(bearer\s+)[^\s,;}\]]+/giu;

function safeMessage(message: string): string {
  return message
    .replace(AUTHORIZATION_PATTERN, '$1[REDACTED]')
    .replace(SECRET_FIELD_PATTERN, '$1[REDACTED]')
    .replace(BEARER_PATTERN, '$1[REDACTED]');
}

export class JsonlLogger {
  constructor(
    private readonly sink: LogSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  logAssessmentDecision(event: AssessmentDecisionLog): void {
    const audit = AssessmentResultAuditSchema.parse(event.resultAudit);
    const line = {
      event: 'assessment_decision',
      timestamp: this.now().toISOString(),
      assessment_id: event.assessmentId,
      user_id: event.userId,
      industry_label: audit.industryLabel,
      original_evidence_count: audit.evidenceSelection.originalCount,
      selected_evidence_count: audit.evidenceSelection.selectedCount,
      excluded_evidence_count: audit.evidenceSelection.excludedCount,
      batch_count: audit.evidenceSelection.batchCount,
      successful_batch_count: audit.evidenceSelection.successfulBatchCount,
      failed_batch_count: audit.evidenceSelection.failedBatchCount,
      processed_evidence_count: audit.evidenceSelection.processedCount,
      unprocessed_evidence_count: audit.evidenceSelection.unprocessedCount,
      deduplicated_evidence_count: audit.evidenceSelection.deduplicatedCount,
      category_counts: audit.evidenceSelection.categoryCounts,
      research_bytes: audit.evidenceSelection.researchBytes,
      request_bytes: audit.evidenceSelection.requestBytes,
      product_levels: Object.fromEntries(audit.opportunities.map(opportunity => [
        opportunity.product,
        opportunity.level,
      ])),
    };
    this.sink.write(`${JSON.stringify(line)}\n`);
  }

  logUpstreamAttempt(event: UpstreamAttemptLog): void {
    const line = {
      event: 'upstream_attempt',
      timestamp: this.now().toISOString(),
      assessment_id: event.assessmentId,
      user_id: event.userId,
      source: event.source,
      duration_ms: event.durationMs,
      success: event.success,
      attempt: event.attempt,
      ...(event.batchIndex === undefined ? {} : { batch_index: event.batchIndex }),
      error: event.error === null ? null : {
        code: event.error.code,
        message: safeMessage(event.error.message),
      },
    };
    this.sink.write(`${JSON.stringify(line)}\n`);
  }

  logContactCacheError(event: {
    operation: 'read' | 'parse' | 'write';
    cacheKey: string;
    error: Error;
  }): void {
    const line = {
      event: 'contact_cache_error',
      timestamp: this.now().toISOString(),
      operation: event.operation,
      cache_key_prefix: event.cacheKey.slice(0, 12),
      error: {
        name: event.error.name,
        message: safeMessage(event.error.message),
      },
    };
    this.sink.write(`${JSON.stringify(line)}\n`);
  }
}
