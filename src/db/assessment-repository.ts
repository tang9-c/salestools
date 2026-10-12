import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Page, ReportItem, ReportSummary } from '../companies/company-context-types.js';
import {
  AssessmentResultAuditSchema,
  EvidenceSnapshotSchema,
  OpportunityLevelSchema,
  ProductKeySchema,
  ReportModelSchema,
  UtcTimestampSchema,
  type OpportunityLevel,
  type ProductKey,
  type ReportModel,
  type AssessmentResultAudit,
  type EvidenceSnapshot,
} from '../contracts/index.js';

export class AssessmentNotFoundError extends Error {
  override readonly name = 'AssessmentNotFoundError';

  constructor(assessmentId: string) {
    super(`Assessment not found: ${assessmentId}`);
  }
}

export class InvalidAssessmentTransitionError extends Error {
  override readonly name = 'InvalidAssessmentTransitionError';

  constructor(assessmentId: string, status: AssessmentRecord['status']) {
    super(`Assessment ${assessmentId} cannot transition from ${status}`);
  }
}

export interface AssessmentInput {
  requestedBy: string;
  legalName: string;
  creditCode: string;
}

export interface AssessmentCompletion {
  reportMarkdown: string;
  recommendedProduct: ProductKey | null;
  overallOpportunity: OpportunityLevel;
  sourceStatus: ReportModel['sourceStatus'];
  collectedAt: string;
  resultAudit: AssessmentResultAudit;
  evidenceSnapshot?: EvidenceSnapshot | null;
}

export interface AssessmentRecord {
  assessmentId: string;
  cacheKey: string;
  requestedBy: string;
  legalName: string;
  creditCode: string;
  status: 'processing' | 'completed' | 'failed';
  reportMarkdown: string | null;
  recommendedProduct: ProductKey | null;
  overallOpportunity: OpportunityLevel | null;
  sourceStatus: ReportModel['sourceStatus'] | null;
  resultAudit: AssessmentResultAudit | null;
  evidenceSnapshot: EvidenceSnapshot | null;
  collectedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  cachedAt: string | null;
  failedAt: string | null;
}

export interface AssessmentReuseResult {
  record: AssessmentRecord;
  created: boolean;
  cacheHit: boolean;
  cachedAt: string | null;
}

interface AssessmentRow {
  assessment_id: string;
  cache_key: string;
  requested_by: string;
  legal_name: string;
  credit_code: string;
  status: 'processing' | 'completed' | 'failed';
  report_markdown: string | null;
  recommended_product: string | null;
  overall_opportunity: string | null;
  source_status_json: string | null;
  result_json: string | null;
  evidence_snapshot_json: string | null;
  collected_at: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  cached_at: string | null;
  failed_at: string | null;
}

const reportSourceStatusSchema = ReportModelSchema.shape.sourceStatus;

function toRecord(row: AssessmentRow): AssessmentRecord {
  return {
    assessmentId: row.assessment_id,
    cacheKey: row.cache_key,
    requestedBy: row.requested_by,
    legalName: row.legal_name,
    creditCode: row.credit_code,
    status: row.status,
    reportMarkdown: row.report_markdown,
    recommendedProduct: row.recommended_product === null ? null : ProductKeySchema.parse(row.recommended_product),
    overallOpportunity: row.overall_opportunity === null ? null : OpportunityLevelSchema.parse(row.overall_opportunity),
    sourceStatus: row.source_status_json === null ? null : reportSourceStatusSchema.parse(JSON.parse(row.source_status_json)),
    resultAudit: row.result_json === null ? null : AssessmentResultAuditSchema.parse(JSON.parse(row.result_json)),
    evidenceSnapshot: row.evidence_snapshot_json === null ? null : EvidenceSnapshotSchema.parse(JSON.parse(row.evidence_snapshot_json)),
    collectedAt: row.collected_at === null ? null : UtcTimestampSchema.parse(row.collected_at),
    errorMessage: row.error_message,
    createdAt: UtcTimestampSchema.parse(row.created_at),
    completedAt: row.completed_at === null ? null : UtcTimestampSchema.parse(row.completed_at),
    cachedAt: row.cached_at === null ? null : UtcTimestampSchema.parse(row.cached_at),
    failedAt: row.failed_at === null ? null : UtcTimestampSchema.parse(row.failed_at),
  };
}

function ttlCutoff(now: Date, ttlDays: number): string {
  return new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
}

export class AssessmentRepository {
  constructor(private readonly database: DatabaseSync) {}

  summariesByCreditCodes(codes: string[]): Map<string, ReportSummary> {
    const result = new Map(codes.map(code => [code, { count: 0, latest: null } as ReportSummary]));
    if (codes.length === 0) return result;
    const rows = this.database.prepare(`
      WITH ranked AS (
        SELECT credit_code, assessment_id, completed_at AS generated_at, collected_at,
          overall_opportunity, recommended_product,
          row_number() OVER (PARTITION BY credit_code ORDER BY completed_at DESC, assessment_id DESC) AS rank,
          count(*) OVER (PARTITION BY credit_code) AS report_count
        FROM assessments
        WHERE credit_code IN (SELECT value FROM json_each(?)) AND status = 'completed'
      ) SELECT * FROM ranked WHERE rank = 1
    `).all(JSON.stringify(codes)) as Array<Record<string, unknown>>;
    for (const row of rows) {
      result.set(row.credit_code as string, {
        count: row.report_count as number,
        latest: {
          assessment_id: row.assessment_id as string,
          generated_at: row.generated_at as string,
          collected_at: row.collected_at as string,
          overall_opportunity: row.overall_opportunity as string,
          recommended_product: row.recommended_product as string | null,
        },
      });
    }
    return result;
  }

  listCompleted(code: string, offset: number, limit: number): Page<ReportItem> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error('INVALID_PAGINATION');
    }
    const total = (this.database.prepare(`
      SELECT count(*) AS count FROM assessments WHERE credit_code = ? AND status = 'completed'
    `).get(code) as { count: number }).count;
    const items = this.database.prepare(`
      SELECT assessment_id, completed_at AS generated_at, collected_at,
        overall_opportunity, recommended_product
      FROM assessments WHERE credit_code = ? AND status = 'completed'
      ORDER BY completed_at DESC, assessment_id DESC LIMIT ? OFFSET ?
    `).all(code, limit, offset) as unknown as ReportItem[];
    const next = offset + items.length;
    return { items, total, next_offset: next < total ? next : null, complete: true };
  }

  createOrReuseAssessment(
    input: AssessmentInput,
    forceRefresh: boolean,
    now: Date,
    ttlDays: number,
  ): AssessmentReuseResult {
    const createdAt = now.toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const processing = this.database.prepare(`
        SELECT * FROM assessments
        WHERE cache_key = ? AND status = 'processing'
        LIMIT 1
      `).get(input.creditCode) as unknown as AssessmentRow | undefined;
      if (processing !== undefined) {
        this.database.exec('COMMIT');
        return { record: toRecord(processing), created: false, cacheHit: false, cachedAt: null };
      }

      if (!forceRefresh) {
        const completed = this.database.prepare(`
          SELECT * FROM assessments
          WHERE cache_key = ? AND status = 'completed'
            AND completed_at IS NOT NULL AND completed_at >= ?
          ORDER BY completed_at DESC
          LIMIT 1
        `).get(input.creditCode, ttlCutoff(now, ttlDays)) as unknown as AssessmentRow | undefined;
        if (completed !== undefined) {
          const record = toRecord(completed);
          this.database.exec('COMMIT');
          return { record, created: false, cacheHit: true, cachedAt: record.completedAt };
        }
      }

      const assessmentId = randomUUID();
      this.database.prepare(`
        INSERT INTO assessments (
          assessment_id, cache_key, requested_by, legal_name, credit_code, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'processing', ?)
      `).run(assessmentId, input.creditCode, input.requestedBy, input.legalName, input.creditCode, createdAt);
      const record = this.getRequired(assessmentId);
      this.database.exec('COMMIT');
      return { record, created: true, cacheHit: false, cachedAt: null };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(assessmentId: string): AssessmentRecord | null {
    const row = this.database.prepare('SELECT * FROM assessments WHERE assessment_id = ?')
      .get(assessmentId) as unknown as AssessmentRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  findLatestCompletedWithSnapshot(creditCode: string, now: Date, ttlDays: number): AssessmentRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM assessments
      WHERE credit_code = ? AND status = 'completed'
        AND evidence_snapshot_json IS NOT NULL AND collected_at >= ?
        AND completed_at IS NOT NULL AND completed_at >= ?
      ORDER BY completed_at DESC, created_at DESC
      LIMIT 1
    `).get(creditCode, ttlCutoff(now, ttlDays), ttlCutoff(now, ttlDays)) as unknown as AssessmentRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  completeAssessment(assessmentId: string, result: AssessmentCompletion, now: Date): AssessmentRecord {
    const completedAt = now.toISOString();
    const recommendedProduct = result.recommendedProduct === null
      ? null
      : ProductKeySchema.parse(result.recommendedProduct);
    const overallOpportunity = OpportunityLevelSchema.parse(result.overallOpportunity);
    const sourceStatus = reportSourceStatusSchema.parse(result.sourceStatus);
    const resultAudit = AssessmentResultAuditSchema.parse(result.resultAudit);
    const evidenceSnapshot = result.evidenceSnapshot === undefined || result.evidenceSnapshot === null
      ? null : EvidenceSnapshotSchema.parse(result.evidenceSnapshot);
    const collectedAt = UtcTimestampSchema.parse(result.collectedAt);
    const update = this.database.prepare(`
      UPDATE assessments SET
        status = 'completed',
        report_markdown = ?,
        recommended_product = ?,
        overall_opportunity = ?,
        source_status_json = ?,
        result_json = ?,
        evidence_snapshot_json = ?,
        collected_at = ?,
        error_message = NULL,
        completed_at = ?,
        cached_at = ?,
        failed_at = NULL
      WHERE assessment_id = ? AND status = 'processing'
    `).run(
      result.reportMarkdown,
      recommendedProduct,
      overallOpportunity,
      JSON.stringify(sourceStatus),
      JSON.stringify(resultAudit),
      evidenceSnapshot === null ? null : JSON.stringify(evidenceSnapshot),
      collectedAt,
      completedAt,
      completedAt,
      assessmentId,
    );
    if (Number(update.changes) !== 1) this.throwTransitionError(assessmentId);
    return this.getRequired(assessmentId);
  }

  failAssessment(assessmentId: string, errorMessage: string, now: Date): AssessmentRecord {
    const failedAt = now.toISOString();
    const update = this.database.prepare(`
      UPDATE assessments SET
        status = 'failed',
        error_message = ?,
        failed_at = ?,
        completed_at = NULL,
        cached_at = NULL
      WHERE assessment_id = ? AND status = 'processing'
    `).run(errorMessage, failedAt, assessmentId);
    if (Number(update.changes) !== 1) this.throwTransitionError(assessmentId);
    return this.getRequired(assessmentId);
  }

  failInterruptedAssessments(now: Date): number {
    const failedAt = now.toISOString();
    const update = this.database.prepare(`
      UPDATE assessments SET
        status = 'failed',
        error_message = 'Assessment interrupted by service restart',
        failed_at = ?,
        completed_at = NULL,
        cached_at = NULL
      WHERE status = 'processing'
    `).run(failedAt);
    return Number(update.changes);
  }

  private getRequired(assessmentId: string): AssessmentRecord {
    const record = this.get(assessmentId);
    if (record === null) throw new AssessmentNotFoundError(assessmentId);
    return record;
  }

  private throwTransitionError(assessmentId: string): never {
    const record = this.get(assessmentId);
    if (record === null) throw new AssessmentNotFoundError(assessmentId);
    throw new InvalidAssessmentTransitionError(assessmentId, record.status);
  }
}
