import { expect, it } from 'vitest';
import {
  buildResult,
  toOpportunityEvidence,
} from '../src/research/opportunity-adapter.js';
import { compare } from '../src/research/diff.js';
import { selectEvidence, renderSummary } from '../src/research/render.js';
import { ingestEvidence, toResearchItem } from '../src/research/evidence.js';
import type { ResearchResultInput } from '../src/research/runner.js';
import { evaluateOpportunities } from '../src/opportunity/evaluate-all.js';
const at = '2026-10-17T00:00:00.000Z';
function ev(
  quote = '企业甲招聘要求熟练Creo或CATIA任一种软件',
  kind:
    | 'job_requirement'
    | 'direct_use'
    | 'associated_skill'
    | 'other' = 'job_requirement',
) {
  return ingestEvidence(
    {
      source_type: 'web',
      url: 'https://example.com/job',
      publisher: '企业甲',
      content: quote,
      collected_at: at,
      published_at: '2020-01-01T00:00:00.000Z',
      company_scope: 'confirmed',
    },
    { title: '公开材料', quote, signal_kind: kind, product_keys: ['creo'] },
  )!;
}
function input(evidence = [ev()]): ResearchResultInput {
  return {
    run: {
      run_id: 'r',
      dossier_id: 'd',
      base_version_id: null,
      request: {
        template: { id: 'company_research', version: 1 },
        method_version: 'research@1',
        product_keys: ['creo'],
        product_goals: { creo: '研究' },
        effective_goal: '研究',
        product_base_versions: { creo: null },
      },
    } as ResearchResultInput['run'],
    dossier: {
      dossier_id: 'd',
      legal_name: '企业甲',
      credit_code: '91310000123456789X',
    } as ResearchResultInput['dossier'],
    baselines: {},
    prior: [],
    scope: ['creo'],
    policy: {} as ResearchResultInput['policy'],
    evidence,
    facts: [],
    claims: [],
    gaps: [],
    evidence_checks: [],
    source_status: [],
    budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
    conflict_evidence_ids: [],
    warnings: [],
    stop_reason: 'NO_NEW_EVIDENCE',
    completed_rounds: 1,
    round_search_counts: [1],
    pending_work: [],
    assessed_at: at,
  };
}
it('requires meaningful results rather than metadata or arbitrary nonempty quote', () => {
  expect(buildResult(input([]))).toBeNull();
  expect(buildResult(input([ev('欢迎访问企业甲网站', 'other')]))).toBeNull();
});
it('keeps recruitment qualification and historical date, only publishes selected product', () => {
  const s = buildResult(input())!;
  expect(s.facts[0]).toMatchObject({ kind: 'recruitment', text: ev().quote });
  expect(s.claims.filter((c) => c.predicate === 'uses')).toEqual([]);
  expect(s.evidence[0]!.published_at).toBe('2020-01-01T00:00:00.000Z');
  expect(s.product_assessments.map((x) => x.product)).toEqual(['creo']);
  expect(s.summary).toContain('任一种');
});
it('does not promote associated skills, suppliers or conflicts to confirmed use', () => {
  const e = ev('关联人员掌握Creo技能', 'associated_skill');
  const s = buildResult(input([e]))!;
  expect(s.claims.every((c) => c.kind === 'hypothesis')).toBe(true);
  const v = input([ev('企业甲使用Creo进行设计', 'direct_use')]);
  v.conflict_evidence_ids = [v.evidence[0]!.evidence_id];
  expect(buildResult(v)!.claims.filter((c) => c.kind === 'supported')).toEqual(
    [],
  );
});
it('rejects missing dependencies and private material', () => {
  const e = ev();
  e.required_evidence_ids = ['missing'];
  expect(buildResult(input([e]))).toBeNull();
  expect(
    buildResult(input([{ ...ev(), quote: '企业甲联系电话13812345678' }])),
  ).toBeNull();
});
it('records processing omissions separately from knowledge unknowns', () => {
  const v = input();
  v.warnings = ['MODEL_MATERIAL_OMITTED'];
  v.gaps = [
    {
      gap_id: 'k',
      kind: 'knowledge',
      text: '采购预算未知',
      product_keys: ['creo'],
      evidence_ids: [],
      priority: 'medium',
    },
  ];
  const s = buildResult(v)!;
  expect(s.coverage[0]!.scope_complete).toBe(false);
  expect(s.coverage[0]!.knowledge_gap_ids).toContain('k');
  expect(s.coverage[0]!.technical_gap_ids.length).toBeGreaterThan(0);
});
it('compares semantic claims independently from wording, and separates goal/method and rating changes', () => {
  const a = buildResult(input())!;
  a.claims = [
    {
      claim_id: 'c',
      kind: 'strong_signal',
      text: '招聘线索',
      product_keys: ['creo'],
      evidence_ids: [a.evidence[0]!.evidence_id],
      temporal_scope: 'historical',
      subject_key: a.credit_code,
      predicate: 'requires_skill',
      object_key: 'creo',
    },
  ];
  const b = structuredClone(a);
  b.claims[0]!.text = '过去招聘提及相关技能';
  expect(compare(a, b).business_changes).toEqual([]);
  b.product_goals.creo = '新目标';
  b.method_version = 'research@2';
  b.product_assessments[0]!.level = '高';
  expect(compare(a, b).business_changes).toEqual([]);
  expect(compare(a, b).method_changes.length).toBeGreaterThan(0);
  expect(compare(a, b).analysis_changes.length).toBeGreaterThan(0);
});
it('paginates fixed-version evidence and complete claim dependency closure without mutation', () => {
  const s = buildResult(input())!;
  const root = s.evidence[0]!;
  const dep = {
    ...root,
    evidence_id: 'dependency',
    product_keys: ['catia'] as const,
  };
  s.evidence.push({ ...dep, product_keys: ['catia'] });
  root.required_evidence_ids = ['dependency'];
  s.claims = [
    {
      claim_id: 'c',
      kind: 'hypothesis',
      text: '待核实',
      product_keys: ['creo'],
      evidence_ids: [root.evidence_id],
      temporal_scope: 'historical',
      subject_key: null,
      predicate: null,
      object_key: null,
    },
  ];
  const p = selectEvidence(
    { version_id: 'v1', snapshot: s },
    { claim_id: 'c' },
    { offset: 0, limit: 1 },
  );
  expect(p.total).toBe(2);
  expect(p.version_id).toBe('v1');
  expect(p.items[0]!.collected_at).toBe(at);
  p.items[0]!.title = 'changed';
  expect(s.evidence.some((x) => x.title === 'changed')).toBe(false);
  expect(() =>
    selectEvidence(
      { version_id: 'v1', snapshot: s },
      { claim_id: 'absent' },
      { offset: 0, limit: 10 },
    ),
  ).toThrow();
});
it('uses unchanged legacy evaluator for equivalent public evidence', () => {
  const s = buildResult(input())!;
  const item = toResearchItem(s.evidence[0]!, s.legal_name)!;
  const mapped = toOpportunityEvidence(
    s.evidence,
    s.facts,
    s.gaps,
    s.legal_name,
    s.credit_code,
    at,
  );
  const {
    source,
    sourceKind,
    summary,
    content,
    query,
    position,
    logId,
    ...reference
  } = item;
  const bundle = {
    ...mapped,
    evidence: [reference],
    facts: [
      {
        factId: s.facts[0]!.fact_id,
        statement: '企业甲招聘要求熟练Creo或CATIA任一种软件',
        kind: 'recruitment' as const,
        productTags: ['creo'] as ['creo'],
        strength: 'direct' as const,
        evidenceIds: [item.evidenceId],
        entityScope: 'legal_entity' as const,
        entityMatch: 'confirmed' as const,
        matchBasis: ['validated_research_source'],
      },
    ],
  };
  expect(s.product_assessments).toEqual(
    evaluateOpportunities(bundle, new Date(at)).products.filter(
      (p) => p.product === 'creo',
    ),
  );
  expect(renderSummary(s)).not.toMatch(/13812345678|@example/);
});
it('reads product view with closure and only related checks, preserving stored dates', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { initializeDatabase } = await import('../src/db/database.js');
  const { ResearchRepository } = await import('../src/research/repository.js');
  const { CompanyResearchService } = await import('../src/research/service.js');
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  try {
    const repo = new ResearchRepository(db, { now: () => new Date(at) });
    const service = new CompanyResearchService(repo, {
      identityLookup: () => true,
    });
    const r = service.start(
      {
        mode: 'initial',
        legal_name: '企业甲',
        credit_code: '91310000123456789X',
        products: ['creo'],
        operation_id: 'i',
      },
      'u',
    );
    repo.claim(r.run_id);
    const v = input();
    v.run = repo.getRun(r.run_id)!;
    v.dossier = repo.getDossier(r.dossier_id)!;
    const e = v.evidence[0]!;
    e.required_evidence_ids = ['dep'];
    v.evidence.push({
      ...e,
      evidence_id: 'dep',
      product_keys: ['catia'],
      required_evidence_ids: [],
    });
    v.evidence.push({
      ...e,
      evidence_id: 'unrelated',
      product_keys: ['cst'],
      required_evidence_ids: [],
    });
    v.evidence_checks = v.evidence.map((x) => ({
      evidence_id: x.evidence_id,
      last_checked_at: '2026-09-01T00:00:00.000Z',
      check_outcome: 'unchanged',
      attempts: [],
    }));
    const snapshot = buildResult(v)!;
    const version = repo.finish(r.run_id, snapshot);
    const context = service.readProductContext(
      v.dossier.credit_code,
      'creo',
      at,
    );
    expect(context.evidence?.map((x) => x.evidence_id)).toContain('dep');
    expect(context.evidence?.map((x) => x.evidence_id)).not.toContain(
      'unrelated',
    );
    expect(context.evidence_checks?.map((x) => x.evidence_id)).not.toContain(
      'unrelated',
    );
    expect(
      context.evidence_checks?.every(
        (x) => x.last_checked_at === '2026-09-01T00:00:00.000Z',
      ),
    ).toBe(true);
    expect(
      service.readProductContext(v.dossier.credit_code, 'cst', at),
    ).toMatchObject({ researched: false, opportunity: null });
    expect(() =>
      service.readProductContext('other', 'creo', at, version.version_id),
    ).toThrow('RESEARCH_VERSION_CONFLICT');
  } finally {
    db.close();
  }
});
it('keeps graph provenance nullable and cannot derive confirmed deployment from personal skills', () => {
  const e = {
    ...ev('关联人员掌握Creo技能', 'associated_skill'),
    source_type: 'graph' as const,
    url: null,
    locator: {
      entity_id: 'person',
      entity_version: 1,
      evidence_id: 'source',
      text_hash: 'hash',
    },
  };
  const s = buildResult(input([e]))!;
  expect(s.evidence[0]!.url).toBeNull();
  expect(s.evidence[0]!.locator).toEqual(e.locator);
  expect(s.claims[0]!.kind).toBe('hypothesis');
  expect(s.product_assessments[0]!.level).toBe('待核实');
});
it('does not mistake narrowing inherited shared semantic claims for new business', () => {
  const a = buildResult(input())!;
  a.product_keys = ['creo', 'catia'];
  a.product_goals.catia = '研究';
  a.claims = [
    {
      claim_id: 'c',
      kind: 'hypothesis',
      text: '待核实Creo或CATIA',
      product_keys: ['creo', 'catia'],
      evidence_ids: [a.evidence[0]!.evidence_id],
      temporal_scope: 'historical',
      subject_key: a.credit_code,
      predicate: 'associated_clue',
      object_key: 'one-of:creo,catia',
    },
  ];
  const b = structuredClone(a);
  b.product_keys = ['creo'];
  delete b.product_goals.catia;
  b.claims[0]!.product_keys = ['creo'];
  expect(compare(a, b).business_changes).toEqual([]);
});
it('does not let source mirrors add independent confidence', () => {
  const e = ev('企业甲使用Creo进行复杂曲面产品设计', 'direct_use');
  const mirror = {
    ...e,
    source_type: 'web' as const,
    evidence_id: 'mirror',
    url: 'https://mirror.example.com/job',
    locator: { url: 'https://mirror.example.com/job', publisher: '镜像' },
  };
  const a = buildResult(input([e]))!,
    b = buildResult(input([e, mirror]))!;
  expect(b.product_assessments[0]!.confidence).toBe(
    a.product_assessments[0]!.confidence,
  );
});
it('reports truncated claims and keeps full dependency groups after evidence cap', () => {
  const v = input(
    Array.from({ length: 81 }, (_, i) => ({
      ...ev(),
      evidence_id: `e${i}`,
      required_evidence_ids: i === 0 ? ['e80'] : [],
    })),
  );
  const s = buildResult(v)!;
  expect(s.evidence.length).toBeLessThanOrEqual(80);
  expect(
    s.evidence.find((e) => e.evidence_id === 'e0')?.required_evidence_ids,
  ).toEqual(['e80']);
  expect(s.evidence.some((e) => e.evidence_id === 'e80')).toBe(true);
  expect(
    s.gaps.some((g) => g.kind === 'technical' && g.text.includes('省略')),
  ).toBe(true);
  expect(
    s.facts.every((f) =>
      f.evidence_ids.every((id) =>
        s.evidence.some((e) => e.evidence_id === id),
      ),
    ),
  ).toBe(true);
});
it('compares every selected product against its frozen baseline, including a shared baseline', () => {
  const a = buildResult(input())!;
  a.product_keys = ['creo', 'catia'];
  a.product_goals.catia = '研究';
  a.product_assessments.push({
    ...a.product_assessments[0]!,
    product: 'catia',
  });
  a.coverage.push({ ...a.coverage[0]!, product: 'catia' });
  const v = input();
  v.scope = ['creo', 'catia'];
  v.run.request.product_keys = v.scope;
  v.run.request.product_goals = { creo: '新目标', catia: '另一目标' };
  v.baselines = { creo: a, catia: a };
  const s = buildResult(v)!;
  expect(
    s.changes.method_changes.some((c) => c.product_keys.includes('catia')),
  ).toBe(true);
});
it('does not use successful recheck time to upgrade unknown or historic publication', () => {
  const v = input([
    {
      ...ev('企业甲使用Creo进行设计', 'direct_use'),
      published_at: null,
      valid_from: null,
    },
  ]);
  v.evidence_checks = [
    {
      evidence_id: v.evidence[0]!.evidence_id,
      last_checked_at: at,
      check_outcome: 'unchanged',
      attempts: [],
    },
  ];
  const s = buildResult(v)!;
  expect(s.claims[0]!.temporal_scope).toBe('unknown');
  expect(s.evidence[0]!.published_at).toBeNull();
  expect(s.evidence_checks[0]!.last_checked_at).toBe(at);
});
it('marks incomplete output when claim count is truncated', () => {
  const v = input();
  v.claims = Array.from({ length: 61 }, (_, i) => ({
    claim_id: `c${i}`,
    kind: 'hypothesis',
    text: '待核实招聘技能',
    product_keys: ['creo'],
    evidence_ids: [v.evidence[0]!.evidence_id],
    temporal_scope: 'historical',
    subject_key: v.dossier.credit_code,
    predicate: 'requires_skill',
    object_key: `skill${i}`,
  }));
  const s = buildResult(v)!;
  expect(s.claims).toHaveLength(60);
  expect(s.coverage[0]!.scope_complete).toBe(false);
  expect(
    s.gaps.some((g) => g.kind === 'technical' && g.text.includes('结论')),
  ).toBe(true);
});
it('includes product claim references even when their provenance root has another tag', () => {
  const s = buildResult(input())!;
  s.evidence[0]!.product_keys = ['catia'];
  s.claims = [
    {
      claim_id: 'shared',
      kind: 'hypothesis',
      text: '待核实共享线索',
      product_keys: ['creo'],
      evidence_ids: [s.evidence[0]!.evidence_id],
      temporal_scope: 'historical',
      subject_key: null,
      predicate: null,
      object_key: null,
    },
  ];
  expect(
    selectEvidence({ version_id: 'v', snapshot: s }, { product: 'creo' }).total,
  ).toBe(1);
});
it('only marks explicitly supported current use as current and never uses future dates', () => {
  const e = {
    ...ev('企业甲目前使用Creo进行设计', 'direct_use'),
    published_at: at,
    valid_from: at,
  };
  expect(buildResult(input([e]))!.claims[0]!.temporal_scope).toBe(
    'current_supported',
  );
  expect(
    buildResult(input([{ ...e, published_at: '2027-01-01T00:00:00.000Z' }]))!
      .claims[0]!.temporal_scope,
  ).not.toBe('current_supported');
});
it('enforces the actual serialized 2 MiB limit and removes dangling derived references', () => {
  const v = input(
    Array.from({ length: 80 }, (_, i) => ({
      ...ev(),
      evidence_id: `${String.fromCharCode(65 + (i % 26))}${'x'.repeat(196)}${i}`,
    })),
  );
  const ids = v.evidence.map((e) => e.evidence_id);
  v.facts = Array.from({ length: 80 }, (_, i) => ({
    fact_id: `f${i}`,
    kind: 'recruitment',
    text: v.evidence[0]!.quote,
    product_keys: ['creo'],
    evidence_ids: i === 79 ? [ids[0]!] : ids,
  }));
  v.claims = Array.from({ length: 60 }, (_, i) => ({
    claim_id: `c${i}`,
    kind: 'hypothesis',
    text: '待核实招聘技能',
    product_keys: ['creo'],
    evidence_ids: ids,
    temporal_scope: 'historical',
    subject_key: null,
    predicate: null,
    object_key: null,
  }));
  v.gaps = Array.from({ length: 90 }, (_, i) => ({
    gap_id: `g${i}`,
    kind: 'knowledge',
    text: '采购信息未知',
    product_keys: ['creo'],
    evidence_ids: ids,
    priority: 'medium',
  }));
  const s = buildResult(v)!;
  expect(s).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(s), 'utf8')).toBeLessThanOrEqual(
    2 * 1024 * 1024,
  );
  expect(s.evidence.length).toBeLessThan(80);
  expect(s.coverage[0]!.scope_complete).toBe(false);
  const retained = new Set(s.evidence.map((e) => e.evidence_id));
  expect(
    [...s.facts, ...s.claims, ...s.gaps].every((e) =>
      e.evidence_ids.every((id) => retained.has(id)),
    ),
  ).toBe(true);
  expect(
    s.gaps.some((g) => g.kind === 'technical' && g.text.includes('容量')),
  ).toBe(true);
});
it('does not accept model assertions unsupported by source wording or turn greetings into findings', () => {
  const v = input();
  v.claims = [
    {
      claim_id: 'fabricated',
      kind: 'supported',
      text: '企业甲拥有大型飞机总装产线',
      product_keys: ['creo'],
      evidence_ids: [v.evidence[0]!.evidence_id],
      temporal_scope: 'historical',
      subject_key: v.dossier.credit_code,
      predicate: 'manufactures',
      object_key: 'aircraft',
    },
  ];
  const s = buildResult(v)!;
  expect(s.claims.some((c) => c.claim_id === 'fabricated')).toBe(false);
  expect(s.gaps.some((g) => g.kind === 'technical')).toBe(true);
  const empty = input([ev('欢迎访问企业甲网站', 'other')]);
  empty.claims = [
    {
      ...v.claims[0]!,
      text: '欢迎访问企业甲网站',
      evidence_ids: [empty.evidence[0]!.evidence_id],
    },
  ];
  expect(buildResult(empty)).toBeNull();
});
it('inherits already validated business facts without reclassifying their original excerpt', () => {
  const base = buildResult(input())!;
  const e = ev('航空零件', 'other');
  base.evidence = [e];
  base.facts = [
    {
      fact_id: 'industry',
      kind: 'industry',
      text: '航空零件业务',
      product_keys: ['creo'],
      evidence_ids: [e.evidence_id],
    },
  ];
  base.claims = [];
  const v = input([e]);
  v.facts = base.facts;
  v.baselines = { creo: base };
  const s = buildResult(v)!;
  expect(s).not.toBeNull();
  expect(s.facts).toContainEqual(base.facts[0]);
  expect(s.evidence[0]!.collected_at).toBe(at);
});
it('prioritizes refresh at 30/180 days without changing evidence dates', async () => {
  const { planResearch } = await import('../src/research/planner.js');
  const v = input();
  v.run.mode = 'refresh';
  v.run.request.client_request = {
    mode: 'refresh',
    dossier_id: 'd',
    base_version_id: 'v',
    operation_id: 'refresh',
  };
  const base = buildResult(input())!;
  const job = base.evidence[0]!;
  const business = {
    ...ev('企业甲主营精密零件制造', 'other'),
    evidence_id: 'business',
  };
  base.evidence.push(business);
  base.evidence_checks = base.evidence.map((e) => ({
    evidence_id: e.evidence_id,
    last_checked_at: at,
    check_outcome: 'unchanged',
    attempts: [],
  }));
  const reasons = (days: number) =>
    planResearch(
      v.run,
      { creo: base },
      [],
      new Date(Date.parse(at) + days * 86400000),
    )
      .filter((w) => w.reason === 'due_check')
      .flatMap((w) => w.evidence_ids);
  expect(reasons(29)).toEqual([]);
  expect(reasons(30)).toEqual([job.evidence_id]);
  expect(reasons(179)).toEqual([job.evidence_id]);
  expect(reasons(180)).toEqual([job.evidence_id, 'business']);
  business.published_at = null;
  expect(
    planResearch(v.run, { creo: base }, [], new Date(at)).some(
      (w) => w.reason === 'unknown_date' && w.evidence_ids.includes('business'),
    ),
  ).toBe(true);
  expect(job.collected_at).toBe(at);
});
it('keeps public QCC numeric record identifiers without treating them as contact numbers', () => {
  const e = {
    ...ev(),
    source_type: 'qcc' as const,
    url: null,
    locator: { tool: 'recruitment', record_id: '2026101712345' },
  };
  const s = buildResult(input([e]))!;
  expect(s).not.toBeNull();
  expect(s.evidence[0]!.locator).toEqual(e.locator);
});
it('maps formal public procurement to the existing high-opportunity rule without asserting deployment', () => {
  const e = {
    ...ev('企业甲发布Creo三维建模软件采购公告，计划采购Creo许可证', 'other'),
    published_at: at,
  };
  const s = buildResult(input([e]))!;
  expect(s).not.toBeNull();
  expect(s.facts[0]!.kind).toBe('procurement');
  expect(s.product_assessments[0]!.level).toBe('高');
  expect(s.claims.filter((c) => c.predicate === 'uses')).toEqual([]);
});
it.each([
  ['企业甲所属行业为汽车零部件行业', 'industry'],
  ['企业甲具有跨部门设计团队', 'organization'],
  ['企业甲扩产新增生产车间', 'manufacturing'],
  ['企业甲公布设计软件采购预算', 'budget'],
  ['企业甲通过质量管理体系认证', 'quality'],
] as const)('retains exact business facts for %s', (quote, kind) => {
  const s = buildResult(input([ev(quote, 'other')]))!;
  expect(s).not.toBeNull();
  expect(s.facts[0]).toMatchObject({ kind, text: quote });
});
it.each([
  ['企业甲在2020年使用Creo进行设计', '2020-01-01T00:00:00.000Z'],
  ['企业甲目前使用Creo进行设计', '2027-01-01T00:00:00.000Z'],
] as const)(
  'rejects model current-use assertions from historical or future material: %s',
  (quote, published) => {
    const e = {
      ...ev(quote, 'direct_use'),
      published_at: published,
      valid_from: published,
    };
    const v = input([e]);
    v.claims = [
      {
        claim_id: 'model-current',
        kind: 'supported',
        text: quote,
        product_keys: ['creo'],
        evidence_ids: [e.evidence_id],
        temporal_scope: 'current_supported',
        subject_key: v.dossier.credit_code,
        predicate: 'uses',
        object_key: 'creo',
      },
    ];
    const s = buildResult(v)!;
    expect(s.claims.some((c) => c.temporal_scope === 'current_supported')).toBe(
      false,
    );
    expect(s.gaps.some((g) => g.kind === 'technical')).toBe(true);
    expect(s.evidence[0]!.published_at).toBe(published);
  },
);
it.each(['direct_use', 'associated_skill'] as const)(
  'keeps automatic %s semantics stable through real multi-product to single-product continuation',
  (signal) => {
    const e = {
      ...ev(
        signal === 'direct_use'
          ? '企业甲使用Creo和CATIA进行设计'
          : '关联人员掌握Creo或CATIA任一种技能',
        signal,
      ),
      product_keys: ['creo', 'catia'] as ['creo', 'catia'],
    };
    const first = input([e]);
    first.scope = ['creo', 'catia'];
    first.run.request.product_keys = first.scope;
    first.run.request.product_goals = { creo: '研究', catia: '研究' };
    first.run.request.product_base_versions = { creo: null, catia: null };
    const base = buildResult(first)!;
    const next = input([e]);
    next.baselines = { creo: base };
    next.run.base_version_id = 'v1';
    next.run.request.product_base_versions = { creo: 'v1' };
    const project = <
      T extends {
        product_keys: (
          | 'creo'
          | 'catia'
          | 'windchill'
          | 'feigenbaum_qms'
          | 'abaqus'
          | 'cst'
          | 'solidworks'
        )[];
      },
    >(
      items: T[],
    ) =>
      items
        .filter((x) => x.product_keys.includes('creo'))
        .map((x) => ({ ...x, product_keys: ['creo'] as ['creo'] }));
    next.facts = project(base.facts);
    next.claims = project(base.claims);
    next.gaps = project(base.gaps);
    const result = buildResult(next)!;
    expect(result.changes.business_changes).toEqual([]);
    expect(
      result.claims.every((c) =>
        base.claims.some(
          (old) =>
            old.claim_id === c.claim_id && old.object_key === c.object_key,
        ),
      ),
    ).toBe(true);
  },
);
it.each(['method', 'goal', 'same-method'] as const)(
  'classifies reinterpretation of identical evidence as analysis under %s',
  (change) => {
    const base = buildResult(input())!;
    base.claims = [
      {
        claim_id: 'interpretation',
        kind: 'strong_signal',
        text: base.evidence[0]!.quote,
        product_keys: ['creo'],
        evidence_ids: [base.evidence[0]!.evidence_id],
        temporal_scope: 'historical',
        subject_key: base.credit_code,
        predicate: 'requires_skill',
        object_key: 'creo',
      },
    ];
    const next = structuredClone(base);
    next.claims[0]!.kind = 'supported';
    if (change === 'method') next.method_version = 'research@2';
    if (change === 'goal') next.product_goals.creo = '重新解释资料';
    const diff = compare(base, next);
    expect(diff.business_changes).toEqual([]);
    expect(diff.analysis_changes.some((c) => c.kind === 'claim_changed')).toBe(
      true,
    );
    if (change !== 'same-method')
      expect(diff.method_changes.length).toBeGreaterThan(0);
  },
);
it('keeps genuine new-source-backed conclusion changes as business changes', () => {
  const base = buildResult(input())!;
  base.claims = [
    {
      claim_id: 'c',
      kind: 'strong_signal',
      text: base.evidence[0]!.quote,
      product_keys: ['creo'],
      evidence_ids: [base.evidence[0]!.evidence_id],
      temporal_scope: 'historical',
      subject_key: base.credit_code,
      predicate: 'uses',
      object_key: 'creo',
    },
  ];
  const next = structuredClone(base);
  const fresh = ev('企业甲使用Creo进行产品设计', 'direct_use');
  next.evidence.push(fresh);
  next.claims[0] = {
    ...next.claims[0]!,
    kind: 'supported',
    text: fresh.quote,
    evidence_ids: [fresh.evidence_id],
  };
  expect(
    compare(base, next).business_changes.some(
      (c) =>
        c.kind === 'claim_changed' &&
        c.evidence_ids.includes(fresh.evidence_id),
    ),
  ).toBe(true);
});
it.each(['added', 'changed', 'removed'] as const)(
  'records unstructured claim %s as controlled analysis differences',
  (operation) => {
    const base = buildResult(input())!;
    const c = {
      claim_id: 'unstructured',
      kind: 'hypothesis' as const,
      text: '待核实软件技能是否来自任职人员',
      product_keys: ['creo'] as ['creo'],
      evidence_ids: [base.evidence[0]!.evidence_id],
      temporal_scope: 'unknown' as const,
      subject_key: null,
      predicate: null,
      object_key: null,
    };
    base.claims = operation === 'added' ? [] : [c];
    const next = structuredClone(base);
    if (operation === 'added') next.claims = [c];
    if (operation === 'changed')
      next.claims[0]!.text = '待核实技能是否对应企业实际许可证';
    if (operation === 'removed') next.claims = [];
    const diff = compare(base, next);
    expect(diff.business_changes).toEqual([]);
    expect(
      diff.analysis_changes.some((x) => x.kind === `claim_${operation}`),
    ).toBe(true);
    expect(
      diff.analysis_changes.every((x) =>
        x.evidence_ids.every((id) =>
          next.evidence.some((e) => e.evidence_id === id),
        ),
      ),
    ).toBe(true);
  },
);
it('ignores normalization-only unstructured wording and out-of-scope removals', () => {
  const base = buildResult(input())!;
  base.claims = [
    {
      claim_id: 'c',
      kind: 'hypothesis',
      text: '待核实  Creo技能',
      product_keys: ['creo'],
      evidence_ids: [base.evidence[0]!.evidence_id],
      temporal_scope: 'unknown',
      subject_key: null,
      predicate: null,
      object_key: null,
    },
    {
      claim_id: 'catia-only',
      kind: 'unknown',
      text: 'CATIA情况未知',
      product_keys: ['catia'],
      evidence_ids: [],
      temporal_scope: 'unknown',
      subject_key: null,
      predicate: null,
      object_key: null,
    },
  ];
  const next = structuredClone(base);
  next.claims = next.claims.filter((c) => c.claim_id === 'c');
  next.claims[0]!.text = '待核实 Creo技能';
  expect(compare(base, next).analysis_changes).toEqual([]);
});


import { createResearchSources } from '../src/research/sources.js';
import { ResearchPolicy } from '../src/research/policy.js';
import { TestClock } from './company-research-test-clock.js';
import { parseAnalysis } from '../src/research/model.js';
it.each(['jobs.example.com', 'mirror.example.org'])('does not increase confidence for a real mapped recruitment reprint at %s', async domain => {
  const policy = new ResearchPolicy({}, new TestClock());
  const source = createResearchSources({
    qcc: { urls: { company: 'https://qcc.test', operation: 'https://qcc.test', risk: 'https://qcc.test', ipr: 'https://qcc.test' }, apiKey: 'q' },
    search: { url: 'https://search.test', apiKey: 's' },
  }, {
    identity: { legalName: '企业甲', creditCode: '91310000123456789X', formerNames: [], aliases: [], englishNames: [], brands: [], officialDomains: [], registeredAddress: null, parentLegalName: null, subsidiaryLegalNames: [] },
    scope: ['creo'], policy, prior: [],
  }, { fetchFn: async () => Response.json({ Code: 0, Result: { WebResults: [
    { Title: '企业甲招聘Creo工程师', Url: 'https://jobs.example.com/a', SiteName: '企业甲招聘', Content: '企业甲招聘Creo机械设计工程师负责复杂曲面产品设计', Summary: '企业甲招聘', PublishTime: '2026-10-17', SortId: 1 },
    { Title: '企业甲招聘Creo工程师', Url: `https://${domain}/reprint-a`, SiteName: '企业甲招聘', Content: '企业甲招聘Creo机械设计工程师负责复杂曲面产品设计', Summary: '企业甲招聘', PublishTime: '2026-10-17', SortId: 2 },
  ] } }) });
  try {
    const batch = await source.search({ key: 'jobs', topic: 'recruitment', product_keys: ['creo'], gap_ids: [], evidence_ids: [], reason: 'missing_background' }, policy.signal('collect'));
    expect(batch.evidence).toHaveLength(2);
    expect(new Set(batch.evidence.map(e => e.evidence_id)).size).toBe(2);
    expect(new Set(batch.evidence.map(e => e.url)).size).toBe(2);
    const one = buildResult(input(batch.evidence.slice(0, 1)))!;
    const repeated = buildResult(input(batch.evidence))!;
    expect(one.product_assessments[0].confidence).toBe('中');
    expect(repeated.product_assessments[0].confidence).toBe('中');
  } finally { await source.close(); policy.close(); }
});
it.each([
  ['acquired_company', 'unrelated-unverified-company'],
  ['uses', 'creo'],
  ['requires_skill', 'creo'],
])('clears unsupported model semantics %s/%s despite a literal citation at parse and builder boundaries', (predicate, object_key) => {
  const material = ev('企业甲主营Creo复杂曲面产品设计', 'other');
  const claim = { claim_id: 'fabricated-semantics', kind: 'supported' as const, text: material.quote,
    product_keys: ['creo' as const], evidence_ids: [material.evidence_id], temporal_scope: 'unknown' as const,
    subject_key: '91310000123456789X', predicate, object_key };
  const parsed = parseAnalysis({ claims: [claim], gaps: [], queries: [] }, [material], [], ['creo'], '91310000123456789X');
  expect(parsed.claims[0]).toMatchObject({ subject_key: null, predicate: null, object_key: null });
  const before = buildResult(input([material]))!;
  const next = buildResult({ ...input([material]), claims: [claim] })!;
  expect(next.claims[0]).toMatchObject({ subject_key: null, predicate: null, object_key: null });
  expect(compare(before, next).business_changes).toEqual([]);
  expect(compare(before, next).analysis_changes.some(c => c.kind === 'claim_added')).toBe(true);
});
it('keeps rating coverage key technical gap and citations in a bounded first screen with long source facts', () => {
  const evidence = Array.from({ length: 8 }, (_, i) => {
    const quote = '企业甲主营Creo产品设计' + '复杂工程原文'.repeat(300);
    return ingestEvidence({ source_type: 'web', url: `https://example.com/fact-${i}`, publisher: '企业甲', content: quote, collected_at: at, published_at: at, company_scope: 'confirmed' },
      { title: `公开业务材料${i}`, quote, signal_kind: 'other', product_keys: ['creo'] })!;
  });
  const s = buildResult({ ...input(evidence), source_status: [{ source: 'web', status: 'failed', error_code: 'SEARCH_UNAVAILABLE' }] })!;
  expect(s.facts).toHaveLength(8);
  expect(s.summary.length).toBeLessThanOrEqual(4000);
  expect(s.summary).toContain('产品机会');
  expect(s.summary).toContain(`creo：${s.product_assessments[0].level}`);
  expect(s.summary).toContain('处理范围未完成');
  expect(s.summary).toContain('web来源处理未完成');
  expect(s.summary).toContain(evidence[0].evidence_id);
  expect(s.evidence[0].quote.length).toBeGreaterThan(1800);
});


it.each([
  '企业甲招聘要求熟练CATIA但不要求Creo',
  '企业甲招聘不必掌握Creo',
  '企业甲招聘并非要求熟练Creo',
  '企业甲招聘要求熟练CATIA，而Creo仅为加分项',
  '企业甲招聘要求熟练CATIA，并了解Creo',
  '企业甲招聘要求熟练CATIA，Creo is not required',
  '企业甲招聘要求熟练CATIA，Creo is optional',
  '企业甲招聘要求熟练CATIA，Creo is nice to have',
  '企业甲 recruitment requires CATIA proficiency; Creo is not required',
  '企业甲 recruitment requires CATIA proficiency; Creo is optional',
  '企业甲招聘要求熟练Creo或CATIA任一种',
  '企业甲招聘熟悉Creo者优先',
])('keeps qualified recruitment as analysis instead of a required Creo skill: %s', (quote) => {
  const material = ev(quote, 'job_requirement');
  const claim = {
    claim_id: 'qualified-skill',
    kind: 'strong_signal' as const,
    text: quote,
    product_keys: ['creo' as const],
    evidence_ids: [material.evidence_id],
    temporal_scope: 'unknown' as const,
    subject_key: '91310000123456789X',
    predicate: 'requires_skill',
    object_key: 'creo',
  };
  const parsed = parseAnalysis(
    { claims: [claim], gaps: [], queries: [] },
    [material], [], ['creo'], '91310000123456789X',
  );
  expect(parsed.claims[0]).toMatchObject({
    text: quote, subject_key: null, predicate: null, object_key: null,
  });
  const before = buildResult(input([material]))!;
  const fromParsed = buildResult({ ...input([material]), claims: parsed.claims })!;
  const fromRaw = buildResult({ ...input([material]), claims: [claim] })!;
  for (const snapshot of [fromParsed, fromRaw]) {
    expect(snapshot.claims.find(c => c.claim_id === claim.claim_id)).toMatchObject({
      text: quote, subject_key: null, predicate: null, object_key: null,
    });
    expect(compare(before, snapshot).business_changes).toEqual([]);
    expect(compare(before, snapshot).analysis_changes.some(c => c.kind === 'claim_added')).toBe(true);
  }
});
it.each([
  '企业甲招聘要求熟练Creo',
  '企业甲招聘岗位必须掌握Creo',
  '企业甲招聘要求熟练Creo，而CATIA仅为加分项',
  '企业甲 recruitment requires proficiency in Creo',
])('preserves a literal affirmative requirement for the same product: %s', (quote) => {
  const material = ev(quote, 'job_requirement');
  const claim = {
    claim_id: 'required-skill', kind: 'strong_signal' as const, text: quote,
    product_keys: ['creo' as const], evidence_ids: [material.evidence_id],
    temporal_scope: 'unknown' as const, subject_key: '91310000123456789X',
    predicate: 'requires_skill', object_key: 'creo',
  };
  const parsed = parseAnalysis(
    { claims: [claim], gaps: [], queries: [] },
    [material], [], ['creo'], '91310000123456789X',
  );
  expect(parsed.claims[0]).toMatchObject({
    subject_key: '91310000123456789X', predicate: 'requires_skill', object_key: 'creo',
  });
  const snapshot = buildResult({ ...input([material]), claims: parsed.claims })!;
  expect(snapshot.claims.find(c => c.claim_id === claim.claim_id)).toMatchObject({
    subject_key: '91310000123456789X', predicate: 'requires_skill', object_key: 'creo',
  });
});
