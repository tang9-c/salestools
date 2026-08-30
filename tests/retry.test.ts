import { describe, expect, it } from 'vitest';
import { CallBudget } from '../src/orchestration/call-budget.js';
import { retryOnce, UpstreamError } from '../src/orchestration/retry.js';

describe('retryOnce', () => {
  it('retries once, charging one source and total call per attempt', async () => {
    const budget = new CallBudget({ qcc: 2, doubaoSearch: 1, ark: 1, total: 2 });
    let calls = 0;

    const result = await retryOnce('qcc', budget, async () => {
      calls += 1;
      if (calls === 1) throw new UpstreamError('qcc', 'TRANSPORT', 'temporary failure');
      return 'ok';
    });

    expect(result).toEqual({ status: 'completed', value: 'ok' });
    expect(calls).toBe(2);
    expect(budget.usage()).toEqual({ qcc: 2, doubaoSearch: 0, ark: 0, total: 2 });
  });

  it('returns the second typed error and never makes a third attempt', async () => {
    const budget = new CallBudget({ qcc: 5, doubaoSearch: 1, ark: 1, total: 5 });
    let calls = 0;
    const second = new UpstreamError('qcc', 'SECOND', 'second failure');

    const result = await retryOnce('qcc', budget, async () => {
      calls += 1;
      throw calls === 1 ? new Error('first failure') : second;
    });

    expect(result).toEqual({ status: 'failed', error: second });
    expect(calls).toBe(2);
  });

  it('does not start the second attempt after budget exhaustion', async () => {
    const budget = new CallBudget({ qcc: 1, doubaoSearch: 1, ark: 1, total: 3 });
    let calls = 0;

    const result = await retryOnce('qcc', budget, async () => {
      calls += 1;
      throw new Error('failure');
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.code).toBe('BUDGET_EXHAUSTED');
    expect(calls).toBe(1);
    expect(budget.usage().qcc).toBe(1);
  });
});
