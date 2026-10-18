import { ProductKeySchema } from '../src/research/contracts.js';
import { renderSummary } from '../src/research/render.js';
import { compare } from '../src/research/diff.js';
import { expect, it } from 'vitest';
import { buildResult } from '../src/research/opportunity-adapter.js';
import { ResearchPolicy } from '../src/research/policy.js';
import {
  fixture,
  initial,
  scenarioResult,
  AT,
} from './fixtures/company-sales-scenario/core.js';
import { ingestEvidence } from '../src/research/evidence.js';
function input(template_id: string): any {
  const f = fixture();
  const r = f.service.start({ ...initial, template_id }, 'u');
  const dossier = f.repo.getDossier(r.dossier_id)!;
  f.db.close();
  const e = ingestEvidence(
    {
      source_type: 'web',
      url: 'https://example.com/b',
      publisher: '企业甲',
      content: '企业甲主营Creo产品设计制造',
      published_at: AT,
      collected_at: AT,
      company_scope: 'confirmed',
    },
    {
      title: '业务',
      quote: '企业甲主营Creo产品设计制造',
      product_keys: ['creo'],
      signal_kind: 'other',
    },
  )!;
  return {
    run: r,
    dossier,
    baselines: {},
    prior: [],
    scope: ['creo'],
    policy: new ResearchPolicy(),
    evidence: [e],
    facts: [],
    claims: [],
    gaps: [],
    evidence_checks: [],
    source_status: [],
    budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
    conflict_evidence_ids: [],
    warnings: [],
    stop_reason: 'NO_PENDING_WORK',
    completed_rounds: 0,
    round_search_counts: [],
    pending_work: [],
    assessed_at: AT,
  };
}
it('falls back after invalid or trimmed scenario claims without losing validated facts or changing ratings', () => {
  const company = input('company_research');
  const topic = input('product_sales_scenario');
  try {
    const before = buildResult(company)!;
    topic.template_result = scenarioResult(['creo']);
    topic.template_result.products[0].scene_claim_ids = ['removed-claim'];
    const result = buildResult(topic)!;
    expect(result).not.toBeNull();
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.template_result.kind).toBe('product_sales_scenario');
    expect(
      result.gaps.some(
        (g) =>
          g.kind === 'technical' && g.text.includes('TEMPLATE_OUTPUT_INVALID'),
      ),
    ).toBe(true);
    expect(result.product_assessments).toEqual(before.product_assessments);
  } finally {
    company.policy.close();
    topic.policy.close();
  }
});
it('private scenario result never reaches final snapshot, including inherited input', () => {
  const topic = input('product_sales_scenario');
  try {
    topic.template_result = scenarioResult(['creo']);
    topic.template_result.products[0].paths[0].rationale = 'person@example.com';
    const result = buildResult(topic)!;
    expect(result.template_result.kind).toBe('product_sales_scenario');
    expect(JSON.stringify(result)).not.toContain('person@example.com');
    expect(
      result.gaps.some((g) => g.text.includes('TEMPLATE_OUTPUT_INVALID')),
    ).toBe(true);
  } finally {
    topic.policy.close();
  }
});

it.each([0, 100])(
  'revalidates scenario claim closure after actual 2MiB trimming with %s initial gaps',
  (count) => {
    const topic = input('product_sales_scenario');
    try {
      const e = {
        ...topic.evidence[0],
        evidence_id: 'large',
        source_key: 'large-source',
        url: 'https://example.com/' + 'x'.repeat(2200000),
        locator: {
          url: 'https://example.com/' + 'x'.repeat(2200000),
          publisher: '企业甲',
        },
        quote: '企业甲主营Creo精密产品设计制造',
      };
      topic.gaps = Array.from({ length: count }, (_, i) => ({
        gap_id: 'gap-' + i,
        kind: 'knowledge',
        text: '尚未核实客户资料',
        product_keys: ['creo'],
        evidence_ids: [],
        priority: 'medium',
      }));
      topic.evidence.push(e);
      topic.claims = [
        {
          claim_id: 'trimmed',
          kind: 'supported',
          text: e.quote,
          product_keys: ['creo'],
          evidence_ids: ['large'],
          temporal_scope: 'historical',
          subject_key: null,
          predicate: null,
          object_key: null,
        },
      ];
      topic.template_result = scenarioResult(['creo']);
      topic.template_result.products[0].scene_claim_ids = ['trimmed'];
      const s = buildResult(topic)!;
      expect(s).not.toBeNull();
      expect(s.evidence.some((e) => e.evidence_id === 'large')).toBe(false);
      expect(s.claims.some((c) => c.claim_id === 'trimmed')).toBe(false);
      expect(
        s.template_result.kind === 'product_sales_scenario' &&
          s.template_result.products[0]!.scene_claim_ids,
      ).toEqual([]);
      expect(
        s.gaps.some((g) => g.text.includes('TEMPLATE_OUTPUT_INVALID')),
      ).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(
        2 * 1024 * 1024,
      );
    } finally {
      topic.policy.close();
    }
  },
);

it('shows scenario states and questions and keeps path analysis separate from business facts', () => {
  const topic = input('product_sales_scenario');
  const company = input('company_research');
  try {
    topic.template_result = scenarioResult(['creo']);
    const before = buildResult(company)!;
    const after = buildResult(topic)!;
    const summary = renderSummary(after);
    expect(summary).toContain('新购');
    expect(summary).toContain('替换');
    expect(summary).toContain('补充');
    expect(summary).toContain('客户有哪些');
    expect(summary.length).toBeLessThanOrEqual(4000);
    const changed = structuredClone(after);
    if (changed.template_result.kind === 'product_sales_scenario')
      changed.template_result.products[0]!.paths[1]!.questions = [
        '该路径还缺少哪些信息？',
      ];
    const delta = compare(after, changed);
    expect(delta.business_changes).toEqual([]);
    expect(
      delta.analysis_changes.some(
        (c) =>
          c.kind === 'sales_path_changed' && c.product_keys.includes('creo'),
      ),
    ).toBe(true);
    expect(compare(before, after).business_changes).toEqual([]);
  } finally {
    company.policy.close();
    topic.policy.close();
  }
});

it('keeps all seven products and their path states in the first-screen budget', () => {
  const topic = input('product_sales_scenario');
  try {
    const s = buildResult({
      ...topic,
      template_result: scenarioResult(['creo']),
    })!;
    s.product_keys = [...ProductKeySchema.options];
    s.template_result = scenarioResult(s.product_keys);
    s.product_assessments = [];
    s.coverage = s.product_keys.map((product) => ({
      product,
      scope_complete: true,
      technical_gap_ids: [],
      knowledge_gap_ids: [],
      blocking_conflict_ids: [],
    }));
    if (s.template_result.kind === 'product_sales_scenario')
      for (const p of s.template_result.products) {
        p.scene_claim_ids = [p.product + 'c'.repeat(180)];
        for (const path of p.paths) {
          path.rationale = '待核实客户实际场景和前提'.repeat(40);
          path.questions = [
            '客户还有哪些未满足的业务活动需要核实？'.repeat(10),
          ];
        }
      }
    const text = renderSummary(s);
    expect(text.length).toBeLessThanOrEqual(4000);
    for (const product of s.product_keys)
      expect(text).toContain(
        product + '：新购依据不足；替换依据不足；补充依据不足',
      );
  } finally {
    topic.policy.close();
  }
});
it('allows a fresh dated public scene to support a qualified exploration without upgrading historical claim time', () => {
  const topic = input('product_sales_scenario');
  try {
    const quote =
      '企业甲当前开展Creo机械产品设计，现有协作流程无法满足新增产品项目';
    const e = ingestEvidence(
      {
        source_type: 'web',
        url: 'https://example.com/current-scene',
        publisher: '企业甲',
        content: quote,
        collected_at: AT,
        published_at: AT,
        company_scope: 'confirmed',
      },
      {
        title: '设计场景',
        quote,
        product_keys: ['creo'],
        signal_kind: 'other',
      },
    )!;
    topic.evidence = [e];
    topic.claims = [
      {
        claim_id: 'recent-scene',
        kind: 'supported',
        text: quote,
        product_keys: ['creo'],
        evidence_ids: [e.evidence_id],
        temporal_scope: 'historical',
        subject_key: null,
        predicate: null,
        object_key: null,
      },
    ];
    topic.template_result = scenarioResult(['creo']);
    topic.template_result.products[0].scene_claim_ids = ['recent-scene'];
    Object.assign(topic.template_result.products[0].paths[0], {
      state: 'worth_exploring',
      rationale: quote,
      supporting_claim_ids: ['recent-scene'],
      prerequisites: ['需核实新增项目约束'],
      questions: ['现有流程的具体限制是什么？'],
    });
    const s = buildResult(topic)!;
    expect(
      s.template_result.kind === 'product_sales_scenario' &&
        s.template_result.products[0]!.paths[0]!.state,
    ).toBe('worth_exploring');
    expect(
      s.claims.find((c) => c.claim_id === 'recent-scene')!.temporal_scope,
    ).toBe('historical');
    topic.evidence = [{ ...e, published_at: '2020-01-01T00:00:00.000Z' }];
    const stale = buildResult(topic)!;
    expect(
      stale.template_result.kind === 'product_sales_scenario' &&
        stale.template_result.products[0]!.paths[0]!.state,
    ).toBe('insufficient');
  } finally {
    topic.policy.close();
  }
});
