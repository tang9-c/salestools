import { describe, expect, it } from 'vitest';
import { CallBudget } from '../src/orchestration/call-budget.js';
import { retryOnce, type RetryAttemptEvent, UpstreamError } from '../src/orchestration/retry.js';
import { JsonlLogger } from '../src/logging/logger.js';

describe('JsonlLogger', () => {
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
      error: { code: 'REMOTE', message: 'Authorization: Bearer [REDACTED]' },
    });
    expect(lines[0]).not.toMatch(/hidden-token|qcc-secret|raw-upstream|private-report/);
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
});
