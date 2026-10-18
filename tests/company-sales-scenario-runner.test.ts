import { expect, it } from 'vitest';
import { ResearchRunner } from '../src/research/runner.js';
import { ArkResearchModel } from '../src/research/model.js';
import { buildResult } from '../src/research/opportunity-adapter.js';
import { ingestEvidence } from '../src/research/evidence.js';
import { TestClock } from './company-research-test-clock.js';
import {
  fixture,
  initial,
  snapshot,
  scenarioResult,
  AT,
} from './fixtures/company-sales-scenario/core.js';
export function seeded(template_id = 'company_research') {
  const f = fixture();
  const r = f.service.start({ ...initial, template_id }, 'u');
  const b = snapshot(r);
  const e = ingestEvidence(
    {
      source_type: 'web',
      url: 'https://example.com/scene',
      publisher: '企业甲',
      content: '企业甲主营Creo机械产品设计与制造',
      published_at: AT,
      collected_at: AT,
      company_scope: 'confirmed',
    },
    {
      title: '业务场景',
      quote: '企业甲主营Creo机械产品设计与制造',
      product_keys: ['creo'],
      signal_kind: 'other',
    },
  )!;
  b.evidence = [e];
  b.facts = [
    {
      fact_id: 'f',
      kind: 'product_scene',
      text: e.quote,
      product_keys: ['creo'],
      evidence_ids: [e.evidence_id],
    },
  ];
  b.claims = [
    {
      claim_id: 'scene',
      kind: 'supported',
      text: e.quote,
      product_keys: ['creo'],
      evidence_ids: [e.evidence_id],
      temporal_scope: 'historical',
      subject_key: null,
      predicate: null,
      object_key: null,
    },
  ];
  f.repo.claim(r.run_id);
  const v = f.repo.finish(r.run_id, b);
  return { ...f, baseline: v };
}
const ok = () => ({
  claims: [],
  gaps: [],
  queries: [],
  template_result: scenarioResult(['creo']),
});
it.each([
  { sequence: ['network', 'invalid'], want: 2, status: 'partial' },
  { sequence: ['invalid', 'network', 'success'], want: 2, status: 'partial' },
  { sequence: ['invalid', 'success'], want: 2, status: 'completed' },
  { sequence: ['success'], want: 1, status: 'completed' },
  { sequence: ['private', 'success'], want: 2, status: 'completed' },
  { sequence: ['deadline', 'success'], want: 1, status: 'partial' },
])(
  'counts actual final fetch dispatches across mixed errors $sequence',
  async ({ sequence, want, status }) => {
    const f = seeded();
    let calls = 0,
      sources = 0;
    const clock = new TestClock();
    try {
      const run = f.service.start(
        {
          mode: 'continue',
          dossier_id: f.baseline.dossier_id,
          base_version_id: f.baseline.version_id,
          operation_id: 'topic',
          template_id: 'product_sales_scenario',
          products: ['creo'],
        },
        'other',
      );
      await new ResearchRunner({
        repository: f.repo,
        clock,
        limits: { timeoutMs: 60000 },
        sources: () => {
          sources++;
          throw new Error('must not collect');
        },
        model: (context) =>
          new ArkResearchModel(
            {
              url: 'https://model.invalid',
              credential: 'synthetic',
              model: 'm',
              template: context.run.request.template,
              context: {
                company_identity: {
                  legal_name: initial.legal_name,
                  credit_code: initial.credit_code,
                },
                effective_goal: context.run.request.effective_goal,
                product_goals: context.run.request.product_goals,
              },
              fetchFn: async () => {
                const action = sequence[calls++];
                if (action === 'network') throw new TypeError('network failed');
                if (action === 'deadline') clock.advance(60000);
                return new Response(
                  JSON.stringify({
                    choices: [
                      {
                        message: {
                          content: JSON.stringify(
                            action === 'invalid'
                              ? {}
                              : action === 'private'
                                ? {
                                    ...ok(),
                                    template_result: {
                                      ...scenarioResult(['creo']),
                                      products: scenarioResult([
                                        'creo',
                                      ]).products.map((p) => ({
                                        ...p,
                                        unknowns: ['person@example.com'],
                                      })),
                                    },
                                  }
                                : ok(),
                          ),
                        },
                      },
                    ],
                  }),
                  { status: 200 },
                );
              },
            },
            context.policy,
          ),
        resultBuilder: buildResult,
      }).run(run.run_id, new AbortController().signal);
      const terminal = f.repo.getRun(run.run_id)!;
      expect(sources).toBe(0);
      expect(calls).toBe(want);
      expect(terminal.status).toBe(status);
      expect(terminal.budget_usage.ark).toBe(want);
      const version = f.repo.getVersion(terminal.version_id!)!;
      expect(version.snapshot.template_result.kind).toBe(
        'product_sales_scenario',
      );
      expect(version.snapshot.claims.some((c) => c.claim_id === 'scene')).toBe(
        true,
      );
      if (status === 'partial') {
        expect(version.snapshot.gaps.some((g) => g.kind === 'technical')).toBe(
          true,
        );
        if (version.snapshot.template_result.kind === 'product_sales_scenario')
          expect(
            version.snapshot.template_result.products[0]!.paths.every(
              (p) => p.state === 'insufficient',
            ),
          ).toBe(true);
      }
    } finally {
      f.db.close();
    }
  },
);
it.each([false, true])(
  'reuses unchanged same-template paths with zero sources and model factories; repeated explicit goal=%s',
  async (repeated) => {
    const f = seeded('product_sales_scenario');
    let sources = 0,
      models = 0;
    try {
      const run = f.service.start(
        {
          mode: 'continue',
          dossier_id: f.baseline.dossier_id,
          base_version_id: f.baseline.version_id,
          operation_id: 'same',
          ...(repeated ? { goal: f.baseline.snapshot.product_goals.creo } : {}),
        },
        'u',
      );
      await new ResearchRunner({
        repository: f.repo,
        sources: () => {
          sources++;
          throw new Error('unexpected');
        },
        model: () => {
          models++;
          throw new Error('unexpected');
        },
        resultBuilder: buildResult,
      }).run(run.run_id, new AbortController().signal);
      const done = f.repo.getRun(run.run_id)!;
      expect(done.status).toBe('completed');
      expect(sources).toBe(0);
      expect(models).toBe(0);
      expect(
        f.repo.getVersion(done.version_id!)!.snapshot.template_result,
      ).toEqual(f.baseline.snapshot.template_result);
    } finally {
      f.db.close();
    }
  },
);
it('new analysis-only sales goal reuses sufficient material and runs final without inventing source work', async () => {
  const f = seeded();
  let sources = 0,
    models = 0;
  try {
    const run = f.service.start(
      {
        mode: 'continue',
        dossier_id: f.baseline.dossier_id,
        base_version_id: f.baseline.version_id,
        operation_id: 'analysis-only',
        template_id: 'product_sales_scenario',
        products: ['creo'],
        goal: '按现有设计资料分析三条销售路径',
      },
      'u',
    );
    await new ResearchRunner({
      repository: f.repo,
      sources: () => {
        sources++;
        throw new Error('unexpected source work');
      },
      model: (context) =>
        new ArkResearchModel(
          {
            url: 'https://model.invalid',
            credential: 'synthetic',
            model: 'm',
            template: context.run.request.template,
            context: {
              company_identity: {
                legal_name: initial.legal_name,
                credit_code: initial.credit_code,
              },
              effective_goal: context.run.request.effective_goal,
              product_goals: context.run.request.product_goals,
            },
            fetchFn: async () => {
              models++;
              return Response.json({
                choices: [{ message: { content: JSON.stringify(ok()) } }],
              });
            },
          },
          context.policy,
        ),
      resultBuilder: buildResult,
    }).run(run.run_id, new AbortController().signal);
    expect(sources).toBe(0);
    expect(models).toBe(1);
    expect(f.repo.getRun(run.run_id)!.status).toBe('completed');
  } finally {
    f.db.close();
  }
});
