import type { AdminAudit } from '../admin/token-router.js';
import {
  AssessmentResultAuditSchema,
  type AssessmentResultAudit,
} from '../contracts/index.js';
import type { RetryAttemptEvent } from '../orchestration/retry.js';
import type { ImportEvent } from '../contacts/import-service.js';
import { safeCode } from '../contacts/import-diagnostics.js';
import type { ContactExtractionEvent } from '../upstream/ark/contact-extractor.js';

export interface LogSink {
  write(line: string): void;
}

export type UpstreamAttemptLog = RetryAttemptEvent & Readonly<{
  assessmentId: string;
  userId: string;
  batchIndex?: number;
  batchItemCount?: number;
  requestBytes?: number;
}>;

export type ArkBatchSkippedLog = Readonly<{
  assessmentId: string;
  userId: string;
  batchIndex: number;
  batchItemCount: number;
  requestBytes: number;
  reason: 'BUDGET_EXHAUSTED';
}>;

export type ArkBatchStartedLog = Omit<ArkBatchSkippedLog, 'reason'>;

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

  logContactExtraction(event: ContactExtractionEvent): void {
    this.sink.write(`${JSON.stringify({ event: 'contact_extraction', timestamp: this.now().toISOString(), ...event })}\n`);
  }

  logAdminTokenOperation(event: AdminAudit): void {
    this.sink.write(`${JSON.stringify({ event: 'admin_token_operation', timestamp: this.now().toISOString(),
      actor: 'token-admin', requestId: event.requestId, action: event.action, userId: event.userId,
      outcome: event.outcome, httpStatus: event.httpStatus, disabled: event.disabled,
      attempts: event.attempts,
      before: adminMetadata(event.before), after: adminMetadata(event.after) })}\n`);
  }

  logContactImport(event: ImportEvent): void {
    this.sink.write(`${JSON.stringify({ event: 'contact_import', timestamp: this.now().toISOString(), ...event })}\n`);
  }

  logContactCleanup(fileId: string, error?: unknown): void {
    this.sink.write(`${JSON.stringify({ event: 'contact_import_cleanup', timestamp: this.now().toISOString(),
      file_id: fileId, outcome: error === undefined ? 'completed' : 'failed',
      ...(error === undefined ? {} : { code: safeCode(error instanceof Error ? error.message : undefined,
        'IMPORT_CLEANUP_FAILED') }) })}\n`);
  }

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
      ...(event.batchItemCount === undefined ? {} : { batch_item_count: event.batchItemCount }),
      ...(event.requestBytes === undefined ? {} : { request_bytes: event.requestBytes }),
      error: event.error === null ? null : {
        code: event.error.code,
        message: safeMessage(event.error.message),
      },
    };
    this.sink.write(`${JSON.stringify(line)}\n`);
  }

  logArkBatchSkipped(event: ArkBatchSkippedLog): void {
    this.sink.write(`${JSON.stringify({
      event: 'ark_batch_skipped',
      timestamp: this.now().toISOString(),
      assessment_id: event.assessmentId,
      user_id: event.userId,
      batch_index: event.batchIndex,
      batch_item_count: event.batchItemCount,
      request_bytes: event.requestBytes,
      reason: event.reason,
    })}\n`);
  }

  logArkBatchStarted(event: ArkBatchStartedLog): void {
    this.sink.write(`${JSON.stringify({
      event: 'ark_batch_started',
      timestamp: this.now().toISOString(),
      assessment_id: event.assessmentId,
      user_id: event.userId,
      batch_index: event.batchIndex,
      batch_item_count: event.batchItemCount,
      request_bytes: event.requestBytes,
    })}\n`);
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

function adminMetadata(value: AdminAudit['before']) {
  if (!value) return value;
  return { userId:value.userId,enabled:value.enabled,email:value.email,crmConnectionId:value.crmConnectionId,
    crmOrgId:value.crmOrgId,crmUserId:value.crmUserId,createdAt:value.createdAt,updatedAt:value.updatedAt };
}
