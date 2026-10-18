// Pure loopback HTTP + file SQLite + production pipeline; only upstream responses are controlled.
import { expect, it } from 'vitest';
import {
  fixture,
  initial,
  AT,
  until,
  gate,
} from './fixtures/company-research/http.js';
import {
  snapshot,
  scenarioResult,
} from './fixtures/company-sales-scenario/core.js';
import { ingestEvidence } from '../src/research/evidence.js';
import { SALES_SCENARIO_DEFAULT_GOALS } from '../src/research/templates/product-sales-scenario.js';
import { ResearchPolicy } from '../src/research/policy.js';
import { ArkResearchModel } from '../src/research/model.js';
import { TestClock } from './company-research-test-clock.js';
function output(body: any) {
  const u = JSON.parse(body.messages[1].content);
  if (u.template?.id !== 'product_sales_scenario' || u.stage !== 'final')
    return { claims: [], gaps: [], queries: [] };
  const result = scenarioResult(u.product_scope);
  for (const p of result.products)
    p.scene_claim_ids = (u.claims ?? [])
      .filter((c: any) => c.product_keys.includes(p.product))
      .slice(0, 1)
      .map((c: any) => c.claim_id);
  return { claims: [], gaps: [], queries: [], template_result: result };
}
function seedClean(repo: any) {
  const r = repo.begin({ ...initial, goal: '原Creo通用目标' }, 'seed');
  const body = snapshot(r);
  const e = ingestEvidence(
    {
      source_type: 'web',
      url: 'https://example.com/clean',
      publisher: '企业甲',
      content: '企业甲主营Creo机械产品设计制造',
      collected_at: AT,
      published_at: AT,
      company_scope: 'confirmed',
    },
    {
      title: '业务场景',
      quote: '企业甲主营Creo机械产品设计制造',
      product_keys: ['creo'],
      signal_kind: 'other',
    },
  )!;
  body.evidence = [e];
  body.facts = [
    {
      fact_id: 'clean-fact',
      kind: 'product_scene',
      text: e.quote,
      product_keys: ['creo'],
      evidence_ids: [e.evidence_id],
    },
  ];
  body.claims = [
    {
      claim_id: 'clean-scene',
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
  repo.claim(r.run_id);
  return repo.finish(r.run_id, body);
}
it('real HTTP company→CST sales→inherited Creo sales→refresh→company preserves per-product goals, versions and read-only sharing', async () => {
  const f = await fixture();
  try {
    f.output(output);
    const first = await f.start({ ...initial, goal: '原Creo通用目标' });
    expect(first.version_id).not.toBeNull();
    const other = await f.client('shared');
    const request = {
      mode: 'continue',
      dossier_id: first.dossier_id,
      base_version_id: first.version_id,
      operation_id: 'cst-sales',
      template_id: 'product_sales_scenario',
      products: ['cst'],
      goal: 'CST专题目标',
    };
    const accepted = await f.call('start_company_research', request, other);
    await until(
      () =>
        !['queued', 'running'].includes(f.repo.getRun(accepted.run_id)!.status),
    );
    const cst = f.repo.getRun(accepted.run_id)!;
    expect(cst.actor).toBe('shared');
    expect(cst.version_id).not.toBeNull();
    const calls = f.requests.length;
    const replay = await f.call('start_company_research', request, other);
    expect(replay.run_id).toBe(cst.run_id);
    expect(f.requests.length).toBe(calls);
    const creo = await f.start({
      mode: 'continue',
      dossier_id: first.dossier_id,
      base_version_id: cst.version_id,
      operation_id: 'creo-sales',
      products: ['creo'],
    });
    expect(creo.request.template.id).toBe('product_sales_scenario');
    expect(creo.request.product_base_versions.creo).toBe(first.version_id);
    expect(creo.request.product_goals.creo).toBe(
      SALES_SCENARIO_DEFAULT_GOALS.creo,
    );
    expect(f.repo.latestProducts(first.dossier_id).cst!.version_id).toBe(
      cst.version_id,
    );
    const readCalls = f.requests.length;
    const read = await f.call(
      'get_company_research',
      { dossier_id: first.dossier_id, version_id: creo.version_id },
      other,
    );
    expect(read.template_result.kind).toBe('product_sales_scenario');
    expect(read.template_result.products.map((p: any) => p.product)).toEqual([
      'creo',
    ]);
    const id = read.template_result.products[0].scene_claim_ids[0];
    expect(id).toBeDefined();
    const evidence = await f.call(
      'get_company_research_evidence',
      { version_id: creo.version_id, claim_id: id },
      other,
    );
    expect(evidence.total).toBeGreaterThan(0);
    expect(f.requests.length).toBe(readCalls);
    const refresh = await f.start({
      mode: 'refresh',
      dossier_id: first.dossier_id,
      base_version_id: creo.version_id,
      operation_id: 'refresh',
    });
    expect(refresh.version_id).not.toBeNull();
    const back = await f.start({
      mode: 'continue',
      dossier_id: first.dossier_id,
      base_version_id: refresh.version_id,
      operation_id: 'back',
      template_id: 'company_research',
      products: ['creo'],
    });
    expect(back.request.template.id).toBe('company_research');
    expect(back.version_id).not.toBeNull();
    const conflict = await f.call('start_company_research', {
      mode: 'continue',
      dossier_id: first.dossier_id,
      base_version_id: first.version_id,
      operation_id: 'stale',
    });
    expect(conflict.error_code).toBe('RESEARCH_VERSION_CONFLICT');
    expect(
      f.repo.getVersion(first.version_id!)!.snapshot.template_result,
    ).toEqual({ kind: 'company_research' });
  } finally {
    await f.close();
  }
});
it('switches from sufficient fixed history with model only and then reuses sales paths with zero new upstream calls', async () => {
  const f = await fixture({ setup: seedClean });
  try {
    f.output(output);
    const head = f.repo.latestVersion(
      f.repo.dossierByCreditCode(initial.credit_code)!.dossier_id,
    )!;
    const run = await f.start({
      mode: 'continue',
      dossier_id: head.dossier_id,
      base_version_id: head.version_id,
      operation_id: 'sales',
      template_id: 'product_sales_scenario',
      products: ['creo'],
    });
    expect(run.status).toBe('completed');
    expect(f.requests.filter((r) => r.source !== 'ark')).toHaveLength(0);
    expect(f.requests.filter((r) => r.source === 'ark')).toHaveLength(1);
    const version = f.repo.getVersion(run.version_id!)!;
    const before = JSON.stringify(version.snapshot.evidence);
    const count = f.requests.length;
    const same = await f.start({
      mode: 'continue',
      dossier_id: head.dossier_id,
      base_version_id: version.version_id,
      operation_id: 'same',
    });
    expect(same.version_id).not.toBeNull();
    expect(f.requests).toHaveLength(count);
    expect(
      JSON.stringify(f.repo.getVersion(same.version_id!)!.snapshot.evidence),
    ).toBe(before);
  } finally {
    await f.close();
  }
});
it('shared cancel and mutual exclusion preserve terminal state against a late real model transport', async () => {
  const started = gate(),
    release = gate();
  let dispatches = 0;
  const f = await fixture({
    setup: seedClean,
    research: {
      modelFetch: async () => {
        dispatches++;
        started.resolve();
        await release.promise;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  claims: [],
                  gaps: [],
                  queries: [],
                  template_result: scenarioResult(['creo']),
                }),
              },
            },
          ],
        });
      },
    },
  });
  try {
    const head = f.repo.latestVersion(
      f.repo.dossierByCreditCode(initial.credit_code)!.dossier_id,
    )!;
    const args = {
      mode: 'continue',
      dossier_id: head.dossier_id,
      base_version_id: head.version_id,
      operation_id: 'blocked',
      template_id: 'product_sales_scenario',
      products: ['creo'],
    };
    const run = await f.call('start_company_research', args);
    await started.promise;
    expect((await f.call('start_company_research', args)).run_id).toBe(
      run.run_id,
    );
    expect(dispatches).toBe(1);
    const shared = await f.client('other');
    expect(
      (
        await f.call(
          'start_company_research',
          { ...args, operation_id: 'competing' },
          shared,
        )
      ).error_code,
    ).toBe('RESEARCH_ALREADY_RUNNING');
    const cancelled = await f.call(
      'cancel_company_research',
      { run_id: run.run_id },
      shared,
    );
    expect(cancelled.cancelled_by).toBe('other');
    release.resolve();
    await until(() => f.repo.getRun(run.run_id)!.budget_usage.ark === 1);
    expect(f.repo.getRun(run.run_id)!.status).toBe('cancelled');
    expect(f.repo.versions(head.dossier_id)).toHaveLength(1);
  } finally {
    release.resolve();
    await f.close();
  }
});
it('real Ark transport cannot retry when only one global dispatch remains', async () => {
  const clock = new TestClock();
  const policy = new ResearchPolicy({ total: 3 }, clock, undefined, 2);
  let calls = 0;
  try {
    await policy.call('qcc', 'final', async () => ({}));
    await policy.call('qcc', 'final', async () => ({}));
    const model = new ArkResearchModel(
      {
        url: 'https://model.invalid',
        credential: 'synthetic',
        model: 'm',
        template: { id: 'product_sales_scenario', version: 1 },
        context: {
          company_identity: {
            legal_name: initial.legal_name,
            credit_code: initial.credit_code,
          },
          effective_goal: '研究',
          product_goals: { creo: '研究' },
        },
        fetchFn: async () => {
          calls++;
          return new Response('{}', { status: 503 });
        },
      },
      policy,
    );
    await expect(
      model.analyze([], [], ['creo'], new AbortController().signal, 'final'),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(policy.usage()).toMatchObject({ qcc: 2, ark: 1, total: 3 });
    expect(policy.canStart('ark', 'final')).toBe(false);
    await model.close();
  } finally {
    policy.close();
  }
});
