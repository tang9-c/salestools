import { describe, expect, it } from 'vitest';
import { CallBudget } from '../src/orchestration/call-budget.js';

describe('CallBudget', () => {
  it('charges both the source limit and total limit for each attempt', () => {
    const budget = new CallBudget({ qcc: 2, doubaoSearch: 1, ark: 1, total: 3 });

    expect(budget.tryConsume('qcc')).toBe(true);
    expect(budget.tryConsume('qcc')).toBe(true);
    expect(budget.tryConsume('qcc')).toBe(false);
    expect(budget.usage()).toEqual({ qcc: 2, doubaoSearch: 0, ark: 0, total: 2 });
  });

  it('does not partially charge a source when the total limit is exhausted', () => {
    const budget = new CallBudget({ qcc: 2, doubaoSearch: 2, ark: 2, total: 1 });

    expect(budget.tryConsume('qcc')).toBe(true);
    expect(budget.tryConsume('doubao_search')).toBe(false);
    expect(budget.usage()).toEqual({ qcc: 1, doubaoSearch: 0, ark: 0, total: 1 });
    expect(budget.canConsume('doubao_search')).toBe(false);
  });

  it('reports remaining capacity without consuming it', () => {
    const budget = new CallBudget({ qcc: 3, doubaoSearch: 2, ark: 1, total: 4 });
    expect(budget.remaining('qcc')).toBe(3);
    expect(budget.canConsume('qcc', 2)).toBe(true);
    expect(budget.usage().total).toBe(0);
  });
});
