import { describe, expect, it } from 'vitest';
import { CallBudget } from '../src/orchestration/call-budget.js';
import { retryOnce, type RetryAttemptEvent, UpstreamError } from '../src/orchestration/retry.js';
import { JsonlLogger } from '../src/logging/logger.js';

describe('JsonlLogger', () => {
  it('writes one sanitized assessment decision with counts, byte sizes, and product levels', () => {
    const lines: string[] = [];
    const logger = new JsonlLogger({ write: line => lines.push(line) }, () => new Date('2026-08-30T00:00:00.000Z'));
    logger.logAssessmentDecision({
      assessmentId: 'assessment-1',
      userId: 'sales-1',
      resultAudit: {
        industryLabel: '工业自动化装备',
        industryEvidenceIds: ['qcc-profile'],
        evidenceSelection: {
          selectedEvidenceIds: ['qcc-profile', 'doubao_search-web'],
          originalCount: 3,
          selectedCount: 2,
          excludedCount: 1,
          categoryCounts: { industry: 1, technology: 1, timing: 0, capacity: 0 },
          researchBytes: 2_048,
          requestBytes: 4_096,
        },
        opportunities: [
          { product: 'windchill', level: '高', evidenceIds: ['qcc-profile'] },
          { product: 'feigenbaum_qms', level: '中', evidenceIds: [] },
          { product: 'creo', level: '低', evidenceIds: [] },
          { product: 'catia', level: '待核实', evidenceIds: [] },
          { product: 'abaqus', level: '待核实', evidenceIds: [] },
          { product: 'cst', level: '待核实', evidenceIds: [] },
          { product: 'solidworks', level: '待核实', evidenceIds: [] },
        ],
      },
      sourceContent: 'customer-source-content',
      summary: 'customer-summary',
      rawResponse: 'ark-raw-response',
    } as never);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'assessment_decision',
      timestamp: '2026-08-30T00:00:00.000Z',
      assessment_id: 'assessment-1',
      user_id: 'sales-1',
      industry_label: '工业自动化装备',
      original_evidence_count: 3,
      selected_evidence_count: 2,
      excluded_evidence_count: 1,
      batch_count: 1,
      successful_batch_count: 1,
      failed_batch_count: 0,
      processed_evidence_count: 2,
      unprocessed_evidence_count: 1,
      deduplicated_evidence_count: 0,
      category_counts: { industry: 1, technology: 1, timing: 0, capacity: 0 },
      research_bytes: 2_048,
      request_bytes: 4_096,
      product_levels: {
        windchill: '高',
        feigenbaum_qms: '中',
        creo: '低',
        catia: '待核实',
        abaqus: '待核实',
        cst: '待核实',
        solidworks: '待核实',
      },
    });
    expect(lines[0]).not.toMatch(/customer-source-content|customer-summary|ark-raw-response|evidenceIds/iu);
  });

  it('serializes only allowlisted attempt fields and redacts authorization-shaped error text', () => {
    const lines: string[] = [];
    const logger = new JsonlLogger({ write: line => lines.push(line) }, () => new Date('2026-08-30T00:00:00.000Z'));
    logger.logUpstreamAttempt({
      assessmentId: 'assessment-1',
      userId: 'sales-1',
      source: 'qcc',
      durationMs: 12,
      success: false,
      attempt: 1,
      error: { code: 'REMOTE', message: 'Authorization: Bearer hidden-token' },
      request: { apiKey: 'qcc-secret' },
      response: { raw: 'raw-upstream' },
      reportBody: 'private-report',
    } as never);

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toEqual({
      event: 'upstream_attempt',
      timestamp: '2026-08-30T00:00:00.000Z',
      assessment_id: 'assessment-1',
      user_id: 'sales-1',
      source: 'qcc',
      duration_ms: 12,
      success: false,
      attempt: 1,
      error: { code: 'REMOTE', message: 'Authorization: [REDACTED]' },
    });
    expect(lines[0]).not.toMatch(/hidden-token|qcc-secret|raw-upstream|private-report/);
  });

  it('attributes Ark attempts to a batch without logging evidence content', () => {
    const lines: string[] = [];
    const logger = new JsonlLogger({ write: line => lines.push(line) }, () => new Date('2026-08-30T00:00:00.000Z'));

    logger.logUpstreamAttempt({
      assessmentId: 'assessment-1',
      userId: 'sales-1',
      source: 'ark',
      durationMs: 18,
      success: true,
      attempt: 1,
      error: null,
      batchIndex: 2,
      batchItemCount: 7,
      requestBytes: 12_001,
      content: 'private evidence body',
    } as never);

    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'upstream_attempt',
      timestamp: '2026-08-30T00:00:00.000Z',
      assessment_id: 'assessment-1',
      user_id: 'sales-1',
      source: 'ark',
      duration_ms: 18,
      success: true,
      attempt: 1,
      batch_index: 2,
      batch_item_count: 7,
      request_bytes: 12_001,
      error: null,
    });
    expect(lines[0]).not.toContain('private evidence body');
  });

  it('records an Ark batch skipped before HTTP because its call budget is exhausted', () => {
    const lines: string[] = [];
    const logger = new JsonlLogger({ write: line => lines.push(line) }, () => new Date('2026-08-30T00:00:00.000Z'));

    logger.logArkBatchSkipped({
      assessmentId: 'assessment-1', userId: 'sales-1', batchIndex: 3,
      batchItemCount: 6, requestBytes: 11_900, reason: 'BUDGET_EXHAUSTED',
    });

    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'ark_batch_skipped', timestamp: '2026-08-30T00:00:00.000Z',
      assessment_id: 'assessment-1', user_id: 'sales-1', batch_index: 3,
      batch_item_count: 6, request_bytes: 11_900, reason: 'BUDGET_EXHAUSTED',
    });
  });

  it('writes one JSON line for each real retry attempt', async () => {
    const lines: string[] = [];
    const logger = new JsonlLogger({ write: line => lines.push(line) });
    const observer = (event: RetryAttemptEvent) => logger.logUpstreamAttempt({
      assessmentId: 'assessment-1', userId: 'sales-1', ...event,
    });
    let calls = 0;
    const result = await retryOnce('ark', new CallBudget({ qcc: 0, doubaoSearch: 0, ark: 2, total: 2 }), async () => {
      calls += 1;
      throw new UpstreamError('ark', 'UNAVAILABLE', 'temporarily unavailable');
    }, { onAttempt: observer });

    expect(result.status).toBe('failed');
    expect(calls).toBe(2);
    expect(lines).toHaveLength(2);
    expect(lines.map(line => JSON.parse(line).attempt)).toEqual([1, 2]);
  });

  it('maps arbitrary upstream error text to a fixed safe attempt message', async () => {
    const events: RetryAttemptEvent[] = [];
    const secretText = 'api_key=qcc-raw-key token=plain-token raw_response={"credential":"ark-secret"}';
    await retryOnce(
      'qcc',
      new CallBudget({ qcc: 1, doubaoSearch: 0, ark: 0, total: 1 }),
      async () => { throw new UpstreamError('qcc', 'REMOTE_TOOL_ERROR', secretText); },
      { onAttempt: event => events.push(event) },
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.error).toEqual({
      code: 'REMOTE_TOOL_ERROR',
      message: 'QCC tool request failed',
    });
    expect(JSON.stringify(events)).not.toMatch(/qcc-raw-key|plain-token|ark-secret|raw_response/);
  });

  it('redacts common secret patterns as defense in depth when called directly', () => {
    const lines: string[] = [];
    const logger = new JsonlLogger({ write: line => lines.push(line) });
    logger.logUpstreamAttempt({
      assessmentId: 'assessment-1', userId: 'sales-1', source: 'ark',
      durationMs: 1, success: false, attempt: 1,
      error: {
        code: 'REMOTE',
        message: 'api_key=qcc-key token: plain-token credential=ark-key {"secret":"json-secret"}',
      },
    });

    expect(lines[0]).not.toMatch(/qcc-key|plain-token|ark-key|json-secret/);
    expect(JSON.parse(lines[0]!).error.message).toContain('[REDACTED]');
  });

  it('logs only a cache-key prefix and sanitizes contact cache failures', () => {
    const lines: string[] = [];
    const logger = new JsonlLogger(
      { write: line => lines.push(line) },
      () => new Date('2026-09-05T00:00:00.000Z'),
    );
    logger.logContactCacheError({
      operation: 'write',
      cacheKey: 'a'.repeat(64),
      error: new Error('api_key=private-key Authorization: Bearer hidden-token'),
    });

    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'contact_cache_error',
      timestamp: '2026-09-05T00:00:00.000Z',
      operation: 'write',
      cache_key_prefix: 'a'.repeat(12),
      error: {
        name: 'Error',
        message: 'api_key=[REDACTED] Authorization: [REDACTED]',
      },
    });
    expect(lines[0]).not.toMatch(/private-key|hidden-token/);
  });
});
