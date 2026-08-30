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
      error: { code: 'REMOTE', message: 'Authorization: [REDACTED]' },
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
});
