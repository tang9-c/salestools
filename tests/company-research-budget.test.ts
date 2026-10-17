import { expect, it } from 'vitest';
import { ResearchPolicy, researchLimits } from '../src/research/policy.js';

import { TestClock } from './company-research-test-clock.js';
it.each([60000, 300000, 600000, 1800000])(
  'keeps a positive collection window at T=%i',
  (timeoutMs) => {
    const clock = new TestClock();
    const p = new ResearchPolicy({ timeoutMs }, clock);
    expect(p.reserveMs).toBe(Math.min(60000, timeoutMs / 5));
    expect(p.collectUntil).toBe(timeoutMs - p.reserveMs);
    expect(p.isOpen('collect')).toBe(true);
    p.close();
  },
);
it.each([
  { timeoutMs: 59999 },
  { timeoutMs: 1800001 },
  { ark: 1 },
  { total: 2 },
])('rejects invalid limits %o', (limits) => {
  expect(() => researchLimits(limits)).toThrow('RESEARCH_CONFIG_INVALID');
});
it.each([28, 24])(
  'protects final two attempts after two intermediate model attempts with total %i',
  async (total) => {
    const p = new ResearchPolicy({ total }, new TestClock());
    let actual = 0;
    for (let i = 0; i < 2; i++)
      await p.call('ark', 'collect', async () => ++actual);
    for (let i = 0; i < 30; i++) {
      try {
        await p.call(
          i % 2 ? 'doubao_search' : 'qcc',
          'collect',
          async () => ++actual,
        );
      } catch {}
    }
    while (p.canStart('ark', 'collect'))
      await p.call('ark', 'collect', async () => ++actual);
    expect(p.usage().total).toBeLessThanOrEqual(total - 2);
    expect(p.remainingModel()).toBeGreaterThanOrEqual(2);
    let finals = 0;
    await p
      .call('ark', 'final', async () => {
        actual++;
        finals++;
        throw Object.assign(new Error(), { code: 'NETWORK_ERROR' });
      })
      .catch(() => {});
    expect(finals).toBe(2);
    expect(p.usage().total).toBe(actual);
    p.close();
  },
);
it('uses the minimum 2/3 configuration for a source then one successful final call', async () => {
  const p = new ResearchPolicy({ ark: 2, total: 3 }, new TestClock());
  let calls = 0;
  await p.call('qcc', 'collect', async () => ++calls);
  expect(p.canStart('ark', 'collect')).toBe(false);
  await p.call('ark', 'final', async () => ++calls);
  expect(calls).toBe(2);
  expect(p.usage().total).toBe(calls);
  p.close();
});
it('counts failed retries, aborts collection exactly at its boundary and ignores a late reply', async () => {
  const clock = new TestClock();
  const p = new ResearchPolicy({ timeoutMs: 60000 }, clock);
  let actual = 0;
  await p
    .call('qcc', 'collect', async () => {
      actual++;
      throw Object.assign(new Error(), { code: 'NETWORK_ERROR' });
    })
    .catch(() => {});
  expect(actual).toBe(2);
  clock.advance(47999);
  const pending = p.call('doubao_search', 'collect', async (signal) => {
    actual++;
    expect(signal.aborted).toBe(false);
    clock.advance(1);
    expect(signal.aborted).toBe(true);
    return 'late';
  });
  await expect(pending).rejects.toThrow('COLLECTION_DEADLINE');
  expect(p.canStart('qcc', 'collect')).toBe(false);
  expect(p.canStart('ark', 'final')).toBe(true);
  await p.call('ark', 'final', async () => {
    actual++;
    return 'ok';
  });
  expect(p.usage().total).toBe(actual);
  p.close();
});
it('stops graph IPC at forty for the entire run and excludes it from upstream total', async () => {
  const p = new ResearchPolicy({}, new TestClock());
  let actual = 0;
  for (let i = 0; i < 40; i++) await p.graph(async () => ++actual);
  await expect(p.graph(async () => ++actual)).rejects.toThrow(
    'GRAPH_IPC_BUDGET_EXHAUSTED',
  );
  expect(p.usage()).toMatchObject({ graph: 40, total: 0 });
  expect(actual).toBe(40);
  p.close();
});
it('retries transient final HTTP errors once but never retries HTTP client errors', async () => {
  const p = new ResearchPolicy({}, new TestClock());
  let calls = 0;
  await p.call('ark', 'final', async () => {
    calls++;
    if (calls === 1)
      throw Object.assign(new Error('HTTP503'), {
        code: 'REMOTE_HTTP_ERROR',
        status: 503,
      });
    return 'ok';
  });
  expect(calls).toBe(2);
  expect(p.usage().ark).toBe(2);
  p.close();
});
it.each([47999, 48000, 48001])(
  'dispatches collection only strictly before collection deadline at %i',
  async (instant) => {
    const c = new TestClock();
    const p = new ResearchPolicy({ timeoutMs: 60000 }, c);
    let actual = 0;
    c.advance(instant);
    await p.call('qcc', 'collect', async () => ++actual).catch(() => {});
    expect(actual).toBe(instant < 48000 ? 1 : 0);
    expect(p.usage().qcc).toBe(actual);
    c.advance(60000 - instant);
    await expect(p.call('ark', 'final', async () => ++actual)).rejects.toThrow(
      'TIME_BUDGET_EXHAUSTED',
    );
    expect(p.usage().ark).toBe(0);
    p.close();
  },
);
