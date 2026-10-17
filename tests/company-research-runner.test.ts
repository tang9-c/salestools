import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { ResearchRepository } from '../src/research/repository.js';
import {
  ResearchRunner,
  type ResearchResultInput,
} from '../src/research/runner.js';
import { type ResearchSourceBatch } from '../src/research/sources.js';
import { ingestEvidence } from '../src/research/evidence.js';
import { TestClock } from './company-research-test-clock.js';
import type { ResearchSnapshot } from '../src/research/contracts.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
});
const clock = () => new TestClock();
const at = '2026-10-17T00:00:00.000Z';
function evidence(index = 0) {
  const quote = `企业甲招聘需要Creo建模技能${index}`;
  return ingestEvidence(
    {
      source_type: 'web',
      url: `https://example.com/${index}`,
      publisher: '企业甲',
      content: quote,
      collected_at: at,
      published_at: at,
      company_scope: 'confirmed',
    },
    {
      title: '招聘',
      quote,
      product_keys: ['creo'],
      signal_kind: 'job_requirement',
    },
  )!;
}
const empty = (): ResearchSourceBatch => ({
  evidence: [],
  checks: [],
  warnings: [],
  source_status: [],
});
function result(input: ResearchResultInput): ResearchSnapshot {
  return {
    schema_version: 1,
    template: input.run.request.template,
    method_version: input.run.request.method_version,
    evaluator_version: 'opportunity@1',
    dossier_id: input.run.dossier_id,
    run_id: input.run.run_id,
    credit_code: input.dossier.credit_code,
    legal_name: input.dossier.legal_name,
    effective_goal: input.run.request.effective_goal,
    product_keys: input.run.request.product_keys,
    product_goals: input.run.request.product_goals,
    parent_version_id: input.run.base_version_id,
    evidence_base_version_ids: [
      ...new Set(
        Object.values(input.run.request.product_base_versions).filter(
          (v): v is string => !!v,
        ),
      ),
    ],
    template_result: { kind: 'company_research' },
    summary: '已验证的招聘线索',
    evidence: input.evidence,
    facts: [],
    claims: input.claims,
    gaps: input.gaps,
    coverage: input.run.request.product_keys.map((product) => ({
      product,
      scope_complete: false,
      technical_gap_ids: [],
      knowledge_gap_ids: [],
      blocking_conflict_ids: [],
    })),
    product_assessments: [],
    changes: { business_changes: [], method_changes: [], analysis_changes: [] },
    source_status: input.source_status,
    budget_usage: input.budget_usage,
    evidence_checks: input.evidence_checks,
  };
}
function fixture() {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  cleanup.push(() => db.close());
  const repo = new ResearchRepository(db, { now: () => new Date(at) });
  const run = repo.begin(
    {
      mode: 'initial',
      legal_name: '企业甲',
      credit_code: '91310000123456789X',
      operation_id: 'start',
      products: ['creo'],
    },
    'u',
  );
  return { repo, run };
}
it('runs three bounded rounds, counts actual retries and makes one successful final attempt', async () => {
  const { repo, run } = fixture();
  const c = clock();
  let searches = 0;
  let finals = 0;
  let closed = 0;
  const rounds: number[] = [];
  let built: ResearchResultInput | undefined;
  const runner = new ResearchRunner({
    repository: repo,
    clock: c,
    resultBuilder: (input) => {
      built = input;
      return result(input);
    },
    context: () => [],
    sources: (ctx) => ({
      async collectQcc() {
        return empty();
      },
      async collectGraph() {
        return empty();
      },
      async search(work, signal) {
        await ctx.policy.call(
          'doubao_search',
          'collect',
          async () => {
            searches++;
            return null;
          },
          signal,
        );
        return { ...empty(), evidence: [evidence(searches)] };
      },
      async close() {
        closed++;
      },
    }),
    model: (ctx) => ({
      async analyze(materials, gaps, scope, signal, stage = 'collect') {
        await ctx.policy.call(
          'ark',
          stage,
          async () => {
            if (stage === 'final') finals++;
            return null;
          },
          signal,
        );
        rounds.push(materials.length);
        return {
          claims: [],
          gaps,
          queries:
            stage === 'final'
              ? []
              : gaps.slice(0, 4).map((g) => ({
                  gap_id: g.gap_id,
                  product_keys: g.product_keys,
                  topic: 'software' as const,
                })),
        };
      },
      async close() {
        closed++;
      },
    }),
  });
  await runner.run(run.run_id, new AbortController().signal);
  const status = repo.getRun(run.run_id)!;
  expect(status.version_id).not.toBeNull();
  expect(finals).toBe(1);
  expect(searches).toBeLessThanOrEqual(16);
  expect(closed).toBe(2);
  expect(status.budget_usage.total).toBe(searches + rounds.length);
  expect(status.progress.completed_rounds).toBeLessThanOrEqual(3);
  expect(built!.round_search_counts[0]).toBeLessThanOrEqual(8);
  expect(built!.round_search_counts.slice(1).every((n) => n <= 4)).toBe(true);
});
it('stops a full round without new validated content', async () => {
  const { repo, run } = fixture();
  let models = 0;
  const runner = new ResearchRunner({
    repository: repo,
    clock: clock(),
    resultBuilder: result,
    context: () => [evidence()],
    sources: () => ({
      async collectQcc() {
        return empty();
      },
      async collectGraph() {
        return empty();
      },
      async search() {
        return { ...empty(), evidence: [evidence()] };
      },
      async close() {},
    }),
    model: () => ({
      async analyze() {
        models++;
        return { claims: [], gaps: [], queries: [] };
      },
      async close() {},
    }),
  });
  await runner.run(run.run_id, new AbortController().signal);
  expect(repo.getRun(run.run_id)!.stop_reason).toBe('NO_NEW_EVIDENCE');
  expect(models).toBe(1);
});
it.each([true, false])(
  'freezes validated evidence at total deadline; material=%s',
  async (hasMaterial) => {
    const { repo, run } = fixture();
    const c = clock();
    let final = 0;
    let built: ResearchResultInput | undefined;
    const runner = new ResearchRunner({
      repository: repo,
      clock: c,
      limits: { timeoutMs: 60000 },
      context: () => (hasMaterial ? [evidence()] : []),
      resultBuilder: (input) => {
        built = input;
        c.advance(100);
        return result(input);
      },
      sources: () => ({
        async collectQcc() {
          return empty();
        },
        async collectGraph() {
          return empty();
        },
        async search() {
          c.advance(48000);
          return { ...empty(), evidence: [evidence(99)] };
        },
        async close() {},
      }),
      model: (ctx) => ({
        async analyze(_m, _g, _s, signal, stage = 'collect') {
          return ctx.policy.call(
            'ark',
            stage,
            async (requestSignal) => {
              final++;
              c.advance(12000);
              expect(requestSignal.aborted).toBe(true);
              return { claims: [], gaps: [], queries: [] };
            },
            signal,
          );
        },
        async close() {},
      }),
    });
    await runner.run(run.run_id, new AbortController().signal);
    const status = repo.getRun(run.run_id)!;
    expect(status.stop_reason).toBe('TIME_BUDGET_EXHAUSTED');
    expect(final).toBe(1);
    if (hasMaterial) {
      expect(status.status).toBe('partial');
      expect(built!.evidence.map((e) => e.evidence_id)).toEqual([
        evidence().evidence_id,
      ]);
      expect(repo.versions(run.dossier_id)).toHaveLength(1);
    } else {
      expect(status.status).toBe('failed');
      expect(repo.versions(run.dossier_id)).toHaveLength(0);
    }
  },
);
it('cancellation before the result transaction prevents publishing; cancellation after commit preserves terminal state', async () => {
  const { repo, run } = fixture();
  const abort = new AbortController();
  const runner = new ResearchRunner({
    repository: repo,
    context: () => [evidence()],
    clock: clock(),
    resultBuilder: (input) => {
      repo.cancel(run.run_id, 'other');
      abort.abort();
      return result(input);
    },
    sources: () => ({
      async collectQcc() {
        return empty();
      },
      async collectGraph() {
        return empty();
      },
      async search() {
        return empty();
      },
      async close() {},
    }),
    model: () => ({
      async analyze() {
        return { claims: [], gaps: [], queries: [] };
      },
      async close() {},
    }),
  });
  await runner.run(run.run_id, abort.signal);
  expect(repo.versions(run.dossier_id)).toHaveLength(0);
  expect(repo.getRun(run.run_id)!.status).toBe('cancelled');
  const second = fixture();
  second.repo.claim(second.run.run_id);
  const input = {
    run: second.run,
    dossier: second.repo.getDossier(second.run.dossier_id)!,
    evidence: [evidence()],
    claims: [],
    gaps: [],
    source_status: [],
    budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
    evidence_checks: [],
  } as unknown as ResearchResultInput;
  second.repo.finish(second.run.run_id, result(input));
  expect(second.repo.cancel(second.run.run_id, 'other').status).toBe(
    'completed',
  );
});
it('no pending continue work makes zero sources, graph, model or check updates and loads the fixed product baseline', async () => {
  const { repo, run } = fixture();
  repo.claim(run.run_id);
  const s = result({
    run,
    dossier: repo.getDossier(run.dossier_id)!,
    evidence: [evidence()],
    claims: [],
    gaps: [],
    source_status: [],
    budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
    evidence_checks: [],
  } as unknown as ResearchResultInput);
  const first = repo.finish(run.run_id, s);
  const next = repo.begin(
    {
      mode: 'continue',
      dossier_id: run.dossier_id,
      base_version_id: first.version_id,
      operation_id: 'continue',
      products: ['creo'],
    },
    'u',
  );
  let created = 0;
  const runner = new ResearchRunner({
    repository: repo,
    clock: clock(),
    context: () => [],
    resultBuilder: (input) => {
      expect(input.baselines.creo!.run_id).toBe(run.run_id);
      expect(input.evidence_checks).toEqual([]);
      return result(input);
    },
    sources: () => {
      created++;
      throw new Error('not needed');
    },
    model: () => {
      created++;
      throw new Error('not needed');
    },
  });
  await runner.run(next.run_id, new AbortController().signal);
  expect(created).toBe(0);
  expect(repo.getRun(next.run_id)!.stop_reason).toBe('NO_PENDING_WORK');
  expect(repo.getRun(next.run_id)!.budget_usage.total).toBe(0);
});
it('does not claim persistence success or retry storage forever after a local builder failure', async () => {
  const { repo, run } = fixture();
  let builds = 0;
  const runner = new ResearchRunner({
    repository: repo,
    clock: clock(),
    context: () => [evidence()],
    resultBuilder: () => {
      builds++;
      throw new Error('disk unavailable');
    },
    sources: () => ({
      async collectQcc() {
        return empty();
      },
      async collectGraph() {
        return empty();
      },
      async search() {
        return empty();
      },
      async close() {},
    }),
    model: () => ({
      async analyze() {
        return { claims: [], gaps: [], queries: [] };
      },
      async close() {},
    }),
  });
  await runner.run(run.run_id, new AbortController().signal);
  expect(builds).toBe(1);
  expect(repo.getRun(run.run_id)!.status).toBe('failed');
  expect(repo.versions(run.dossier_id)).toHaveLength(0);
});
it('keeps previously validated QCC material when a later collection request hits its deadline', async () => {
  const { repo, run } = fixture();
  const c = clock();
  let qcc = 0;
  const runner = new ResearchRunner({
    repository: repo,
    clock: c,
    limits: { timeoutMs: 60000 },
    resultBuilder: result,
    sources: () => ({
      async collectQcc() {
        qcc++;
        if (qcc === 1) return { ...empty(), evidence: [evidence()] };
        c.advance(48000);
        throw new Error('deadline');
      },
      async collectGraph() {
        return empty();
      },
      async search() {
        return empty();
      },
      async close() {},
    }),
    model: () => ({
      async analyze() {
        return { claims: [], gaps: [], queries: [] };
      },
      async close() {},
    }),
  });
  await runner.run(run.run_id, new AbortController().signal);
  expect(qcc).toBeGreaterThan(1);
  expect(repo.getRun(run.run_id)!.status).toBe('partial');
  expect(repo.latestVersion(run.dossier_id)!.snapshot.evidence).toHaveLength(1);
});
it('rejects a final response that crosses total time during schema validation', async () => {
  const { repo, run } = fixture();
  const c = clock();
  const runner = new ResearchRunner({
    repository: repo,
    clock: c,
    limits: { timeoutMs: 60000 },
    resultBuilder: result,
    context: () => [evidence()],
    sources: () => ({
      async collectQcc() {
        return empty();
      },
      async collectGraph() {
        return empty();
      },
      async search() {
        return empty();
      },
      async close() {},
    }),
    model: () => ({
      async analyze() {
        return {
          get claims() {
            c.advance(60000);
            return [{ claim_id: 'late' }];
          },
          gaps: [],
          queries: [],
        } as any;
      },
      async close() {},
    }),
  });
  await runner.run(run.run_id, new AbortController().signal);
  expect(repo.getRun(run.run_id)!.stop_reason).toBe('TIME_BUDGET_EXHAUSTED');
  expect(repo.latestVersion(run.dossier_id)!.snapshot.claims).toEqual([]);
  expect(repo.versions(run.dossier_id)).toHaveLength(1);
});
it('records an actual transaction storage failure without publishing or retrying', async () => {
  const { repo, run } = fixture();
  let writes = 0;
  const finish = repo.finish.bind(repo);
  repo.finish = (...args) => {
    writes++;
    throw new Error('SQLITE_FULL');
  };
  const runner = new ResearchRunner({
    repository: repo,
    context: () => [evidence()],
    clock: clock(),
    resultBuilder: result,
    sources: () => ({
      async collectQcc() {
        return empty();
      },
      async collectGraph() {
        return empty();
      },
      async search() {
        return empty();
      },
      async close() {},
    }),
    model: () => ({
      async analyze() {
        return { claims: [], gaps: [], queries: [] };
      },
      async close() {},
    }),
  });
  await runner.run(run.run_id, new AbortController().signal);
  expect(writes).toBe(1);
  expect(repo.getRun(run.run_id)!.status).toBe('failed');
  expect(repo.versions(run.dossier_id)).toHaveLength(0);
  repo.finish = finish;
});
it('loads Creo V1 when the dossier write baseline V2 covers only CST', async () => {
  const { repo, run } = fixture();
  repo.claim(run.run_id);
  const seed = (accepted: typeof run, items: ReturnType<typeof evidence>[]) =>
    result({
      run: accepted,
      dossier: repo.getDossier(run.dossier_id)!,
      evidence: items,
      claims: [],
      gaps: [],
      source_status: [],
      budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
      evidence_checks: [],
    } as unknown as ResearchResultInput);
  const v1 = repo.finish(run.run_id, seed(run, [evidence()]));
  const cst = repo.begin(
    {
      mode: 'continue',
      dossier_id: run.dossier_id,
      base_version_id: v1.version_id,
      operation_id: 'cst',
      products: ['cst'],
    },
    'u',
  );
  repo.claim(cst.run_id);
  const v2 = repo.finish(
    cst.run_id,
    seed(cst, [{ ...evidence(2), product_keys: ['cst'] }]),
  );
  const next = repo.begin(
    {
      mode: 'continue',
      dossier_id: run.dossier_id,
      base_version_id: v2.version_id,
      operation_id: 'back-creo',
      products: ['creo'],
    },
    'u',
  );
  const runner = new ResearchRunner({
    repository: repo,
    clock: clock(),
    resultBuilder: (input) => {
      expect(input.baselines.creo!.run_id).toBe(run.run_id);
      expect(input.run.base_version_id).toBe(v2.version_id);
      expect(input.evidence.map((e) => e.evidence_id)).toEqual([
        evidence().evidence_id,
      ]);
      return result(input);
    },
    sources: () => {
      throw new Error('no work');
    },
    model: () => {
      throw new Error('no work');
    },
  });
  await runner.run(next.run_id, new AbortController().signal);
  expect(repo.getRun(next.run_id)!.stop_reason).toBe('NO_PENDING_WORK');
  expect(repo.getRun(next.run_id)!.status).toBe('completed');
  expect(repo.latestProducts(run.dossier_id).cst!.version_id).toBe(
    v2.version_id,
  );
});
it('does not revive a forcibly failed run during local finalization', async () => {
  const { repo, run } = fixture();
  const runner = new ResearchRunner({
    repository: repo,
    clock: clock(),
    context: () => [evidence()],
    resultBuilder: (input) => {
      repo.fail(run.run_id, 'SERVICE_SHUTDOWN');
      return result(input);
    },
    sources: () => ({
      async collectQcc() {
        return empty();
      },
      async collectGraph() {
        return empty();
      },
      async search() {
        return empty();
      },
      async close() {},
    }),
    model: () => ({
      async analyze() {
        return { claims: [], gaps: [], queries: [] };
      },
      async close() {},
    }),
  });
  await runner.run(run.run_id, new AbortController().signal);
  expect(repo.getRun(run.run_id)!.error_code).toBe('SERVICE_SHUTDOWN');
  expect(repo.versions(run.dossier_id)).toHaveLength(0);
});
it.each([1, 12001])(
  'rejects source material whose runner validation crosses deadline by %i ms',
  async (elapsed) => {
    for (const hasPrevious of [false, true]) {
      const { repo, run } = fixture();
      const c = clock();
      let sources = 0;
      let finals = 0;
      let built: ResearchResultInput | undefined;
      const late = evidence(999);
      let read = false;
      Object.defineProperty(late, 'quote', {
        enumerable: true,
        get() {
          if (!read) {
            read = true;
            c.advance(elapsed);
          }
          return '企业甲招聘需要Creo建模技能999';
        },
      });
      const runner = new ResearchRunner({
        repository: repo,
        clock: c,
        limits: { timeoutMs: 60000 },
        context: () => (hasPrevious ? [evidence()] : []),
        resultBuilder: (input) => {
          built = input;
          return result(input);
        },
        sources: () => ({
          async collectQcc() {
            sources++;
            c.advance(47999);
            return {
              ...empty(),
              evidence: [late],
              warnings: ['LATE_BATCH_WARNING'],
              source_status: [{ source: 'qcc', status: 'available' }],
              checks: [
                {
                  evidence_id: late.evidence_id,
                  last_checked_at: at,
                  check_outcome: 'unchanged',
                  attempts: [],
                },
              ],
            };
          },
          async collectGraph() {
            sources++;
            return empty();
          },
          async search() {
            sources++;
            return empty();
          },
          async close() {},
        }),
        model: () => ({
          async analyze() {
            finals++;
            return { claims: [], gaps: [], queries: [] };
          },
          async close() {},
        }),
      });
      await runner.run(run.run_id, new AbortController().signal);
      expect(sources).toBe(1);
      expect(finals).toBe(elapsed === 1 ? 1 : 0);
      const status = repo.getRun(run.run_id)!;
      expect(status.stop_reason).toBe('TIME_BUDGET_EXHAUSTED');
      if (hasPrevious) {
        expect(status.status).toBe('partial');
        expect(built!.evidence.map((e) => e.evidence_id)).toEqual([
          evidence().evidence_id,
        ]);
        expect(built!.evidence_checks).toEqual([]);
        expect(built!.warnings).not.toContain('LATE_BATCH_WARNING');
        expect(built!.source_status.some((s) => s.source === 'qcc')).toBe(
          false,
        );
      } else {
        expect(status.status).toBe('failed');
        expect(repo.versions(run.dossier_id)).toEqual([]);
      }
    }
  },
);
it('rejects a source batch cancelled during runner schema validation', async () => {
  const { repo, run } = fixture();
  const incoming = evidence(17);
  Object.defineProperty(incoming, 'quote', {
    enumerable: true,
    get() {
      repo.cancel(run.run_id, 'other');
      return '企业甲招聘需要Creo建模技能17';
    },
  });
  let builds = 0;
  const runner = new ResearchRunner({
    repository: repo,
    clock: clock(),
    resultBuilder: (input) => {
      builds++;
      return result(input);
    },
    sources: () => ({
      async collectQcc() {
        return { ...empty(), evidence: [incoming] };
      },
      async collectGraph() {
        return empty();
      },
      async search() {
        return empty();
      },
      async close() {},
    }),
    model: () => ({
      async analyze() {
        return { claims: [], gaps: [], queries: [] };
      },
      async close() {},
    }),
  });
  await runner.run(run.run_id, new AbortController().signal);
  expect(builds).toBe(0);
  expect(repo.versions(run.dossier_id)).toEqual([]);
  expect(repo.getRun(run.run_id)!.status).toBe('cancelled');
});
it('projects shared inherited entities to Creo while preserving qualification, semantic keys and all reference roots', async () => {
  const { repo, run } = fixture();
  repo.cancel(run.run_id, 'u');
  const shared = repo.begin(
    {
      mode: 'initial',
      legal_name: '企业甲',
      credit_code: '91310000123456789X',
      operation_id: 'shared',
      products: ['creo', 'catia'],
    },
    'u',
  );
  const main = {
    ...evidence(80),
    product_keys: ['creo', 'catia'] as ('creo' | 'catia')[],
  };
  const proof = { ...evidence(81), product_keys: ['catia' as const] };
  const auxiliary = {
    ...evidence(82),
    product_keys: ['catia' as const],
    required_evidence_ids: [proof.evidence_id],
  };
  const fact = {
    fact_id: 'shared-fact',
    kind: 'software_ecosystem' as const,
    text: 'Creo或CATIA相关技能线索，不能确认企业部署其中任何软件',
    product_keys: ['creo', 'catia'] as ('creo' | 'catia')[],
    evidence_ids: [auxiliary.evidence_id],
  };
  const claim = {
    claim_id: 'shared-claim',
    kind: 'hypothesis' as const,
    text: 'Creo或CATIA相关能力仍待验证，不能据此确认企业部署',
    product_keys: ['creo', 'catia'] as ('creo' | 'catia')[],
    evidence_ids: [main.evidence_id, auxiliary.evidence_id],
    temporal_scope: 'unknown' as const,
    subject_key: '91310000123456789X',
    predicate: 'software_skill_alternative',
    object_key: 'creo_or_catia',
  };
  const gap = {
    gap_id: 'shared-gap',
    kind: 'knowledge' as const,
    text: 'Creo或CATIA线索归属仍待核实',
    product_keys: ['creo', 'catia'] as ('creo' | 'catia')[],
    evidence_ids: [auxiliary.evidence_id],
    priority: 'high' as const,
  };
  repo.claim(shared.run_id);
  const original = {
    ...result({
      run: shared,
      dossier: repo.getDossier(shared.dossier_id)!,
      evidence: [main, auxiliary, proof],
      claims: [claim],
      gaps: [gap],
      source_status: [],
      budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
      evidence_checks: [],
    } as unknown as ResearchResultInput),
    facts: [fact],
  };
  const { ResearchSnapshotSchema } = await import(
    '../src/research/contracts.js'
  );
  expect(ResearchSnapshotSchema.safeParse(original).success).toBe(true);
  const v1 = repo.finish(shared.run_id, original);
  const next = repo.begin(
    {
      mode: 'continue',
      dossier_id: shared.dossier_id,
      base_version_id: v1.version_id,
      operation_id: 'only-creo',
      products: ['creo'],
    },
    'u',
  );
  let captured: ResearchResultInput | undefined;
  const runner = new ResearchRunner({
    repository: repo,
    clock: clock(),
    resultBuilder: (input) => {
      captured = input;
      return { ...result(input), facts: input.facts };
    },
    sources: () => ({
      async collectQcc() {
        return empty();
      },
      async collectGraph() {
        return empty();
      },
      async search() {
        return empty();
      },
      async close() {},
    }),
    model: () => ({
      async analyze() {
        throw new Error('unavailable');
      },
      async close() {},
    }),
  });
  await runner.run(next.run_id, new AbortController().signal);
  expect(captured!.facts).toContainEqual({ ...fact, product_keys: ['creo'] });
  expect(captured!.claims).toContainEqual({ ...claim, product_keys: ['creo'] });
  expect(captured!.gaps).toContainEqual({ ...gap, product_keys: ['creo'] });
  expect(new Set(captured!.evidence.map((e) => e.evidence_id))).toEqual(
    new Set([main.evidence_id, auxiliary.evidence_id, proof.evidence_id]),
  );
  expect(
    captured!.evidence.find((e) => e.evidence_id === auxiliary.evidence_id)!
      .product_keys,
  ).toEqual(['catia']);
  expect(repo.getRun(next.run_id)!.status).toBe('partial');
  expect(repo.latestVersion(shared.dossier_id)!.snapshot.facts[0].text).toBe(
    fact.text,
  );
});
it('keeps historical evidence and check dates when cached identical content has a later collection time', async () => {
  const { repo, run } = fixture();
  repo.claim(run.run_id);
  const historical = {
    ...evidence(),
    collected_at: '2026-09-01T00:00:00.000Z',
  };
  const check = {
    evidence_id: historical.evidence_id,
    last_checked_at: '2026-09-02T00:00:00.000Z',
    check_outcome: 'unchanged' as const,
    attempts: [],
  };
  const v1 = repo.finish(
    run.run_id,
    result({
      run,
      dossier: repo.getDossier(run.dossier_id)!,
      evidence: [historical],
      claims: [],
      gaps: [],
      source_status: [],
      budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
      evidence_checks: [check],
    } as unknown as ResearchResultInput),
  );
  const next = repo.begin(
    {
      mode: 'continue',
      dossier_id: run.dossier_id,
      base_version_id: v1.version_id,
      operation_id: 'cached-same-id',
      products: ['creo'],
    },
    'u',
  );
  let captured: ResearchResultInput | undefined;
  const runner = new ResearchRunner({
    repository: repo,
    clock: clock(),
    context: () => [
      { ...historical, collected_at: '2026-10-17T00:00:00.000Z' },
    ],
    resultBuilder: (input) => {
      captured = input;
      return result(input);
    },
    sources: () => {
      throw new Error('no source work');
    },
    model: () => {
      throw new Error('no model work');
    },
  });
  await runner.run(next.run_id, new AbortController().signal);
  expect(captured!.evidence).toEqual([historical]);
  expect(captured!.evidence_checks).toEqual([check]);
  expect(repo.getRun(next.run_id)!.stop_reason).toBe('NO_PENDING_WORK');
  expect(repo.getRun(next.run_id)!.budget_usage.total).toBe(0);
});
it('merges identical per-product projections while retaining differing frozen statements with distinct IDs', async () => {
  const { repo, run } = fixture();
  repo.cancel(run.run_id, 'u');
  const shared = repo.begin(
    {
      mode: 'initial',
      legal_name: '企业甲',
      credit_code: '91310000123456789X',
      operation_id: 'projection-v1',
      products: ['creo', 'catia'],
    },
    'u',
  );
  const item = {
    ...evidence(90),
    product_keys: ['creo', 'catia'] as ('creo' | 'catia')[],
  };
  const same = {
    fact_id: 'same',
    kind: 'software_ecosystem' as const,
    text: '相关软件技能线索，未确认部署',
    product_keys: ['creo', 'catia'] as ('creo' | 'catia')[],
    evidence_ids: [item.evidence_id],
  };
  const changing = {
    ...same,
    fact_id: 'changing',
    text: '旧版技能线索，未确认部署',
  };
  const seed = (accepted: typeof shared, facts: ResearchSnapshot['facts']) => ({
    ...result({
      run: accepted,
      dossier: repo.getDossier(shared.dossier_id)!,
      evidence: [item],
      claims: [],
      gaps: [],
      source_status: [],
      budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
      evidence_checks: [],
    } as unknown as ResearchResultInput),
    facts,
  });
  repo.claim(shared.run_id);
  const v1 = repo.finish(shared.run_id, seed(shared, [same, changing]));
  const catia = repo.begin(
    {
      mode: 'continue',
      dossier_id: shared.dossier_id,
      base_version_id: v1.version_id,
      operation_id: 'projection-v2',
      products: ['catia'],
    },
    'u',
  );
  repo.claim(catia.run_id);
  const v2 = repo.finish(
    catia.run_id,
    seed(catia, [
      { ...same, product_keys: ['catia'] },
      {
        ...changing,
        product_keys: ['catia'],
        text: '修订技能线索，仍未确认部署',
      },
    ]),
  );
  const next = repo.begin(
    {
      mode: 'continue',
      dossier_id: shared.dossier_id,
      base_version_id: v2.version_id,
      operation_id: 'projection-v3',
      products: ['creo', 'catia'],
    },
    'u',
  );
  let captured: ResearchResultInput | undefined;
  const runner = new ResearchRunner({
    repository: repo,
    clock: clock(),
    resultBuilder: (input) => {
      captured = input;
      return { ...result(input), facts: input.facts };
    },
    sources: () => {
      throw new Error('no work');
    },
    model: () => {
      throw new Error('no work');
    },
  });
  await runner.run(next.run_id, new AbortController().signal);
  expect(captured!.facts).toHaveLength(3);
  expect(new Set(captured!.facts.map((f) => f.fact_id)).size).toBe(3);
  expect(
    captured!.facts.find((f) => f.fact_id === 'same')!.product_keys,
  ).toEqual(['creo', 'catia']);
  expect(
    captured!.facts.find((f) => f.text === changing.text)!.product_keys,
  ).toEqual(['creo']);
  expect(
    captured!.facts.find((f) => f.text === '修订技能线索，仍未确认部署')!
      .product_keys,
  ).toEqual(['catia']);
  expect(repo.getRun(next.run_id)!.status).toBe('completed');
});
