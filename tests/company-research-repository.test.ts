import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { ResearchRepository } from '../src/research/repository.js';
import { CompanyResearchService } from '../src/research/service.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'research-'));
  const db = initializeDatabase(new DatabaseSync(join(dir, 'db.sqlite')));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = new ResearchRepository(db, options);
  let confirmed = true;
  const service = new CompanyResearchService(repo, {
    identityLookup: () => confirmed,
  });
  return {
    db,
    repo,
    service,
    expire: () => {
      confirmed = false;
    },
  };
}
const initial = {
  mode: 'initial' as const,
  legal_name: '企业甲',
  credit_code: '91310000123456789X',
  operation_id: 'one',
  products: ['creo'],
};
function snapshot(run: any) {
  return {
    dossier_id: run.dossier_id,
    run_id: run.run_id,
    credit_code: initial.credit_code,
    legal_name: initial.legal_name,
    schema_version: 1,
    template: run.request.template,
    method_version: 'research@1',
    effective_goal: run.request.effective_goal,
    product_keys: run.request.product_keys,
    product_goals: run.request.product_goals,
    parent_version_id: run.base_version_id,
    evidence_base_version_ids: Object.values(
      run.request.product_base_versions,
    ).filter(Boolean),
    template_result: { kind: 'company_research' },
    evidence: [],
    facts: [],
    claims: [],
    gaps: [],
    product_assessments: [],
    coverage: run.request.product_keys.map((product: string) => ({
      product,
      scope_complete: true,
      technical_gap_ids: [],
      knowledge_gap_ids: [],
      blocking_conflict_ids: [],
    })),
    changes: { business_changes: [], method_changes: [], analysis_changes: [] },
    source_status: [],
    budget_usage: { qcc: 0, search: 0, ark: 0, total: 0 },
    evidence_checks: [],
    summary: '未找到明确使用证据',
    evaluator_version: 'opportunity@1',
  };
}
function complete(repo: ResearchRepository, run: any) {
  repo.claim(run.run_id);
  return repo.finish(run.run_id, snapshot(run));
}
it('replays before expired identity and conflicts on changed client request', () => {
  const { repo, service, expire } = fixture();
  const run = service.start(initial, 'u1');
  expire();
  expect(service.start(initial, 'u1')).toMatchObject({
    run_id: run.run_id,
    replayed: true,
  });
  expect(() => service.start({ ...initial, goal: 'different' }, 'u1')).toThrow(
    'RESEARCH_OPERATION_CONFLICT',
  );
  expect(() =>
    service.start({ ...initial, operation_id: 'two' }, 'u2'),
  ).toThrow('RESEARCH_ALREADY_RUNNING');
  expect(repo.versions(run.dossier_id)).toHaveLength(0);
});
it.each(['failed', 'cancelled', 'restarted'])(
  'allows new initial after %s without a version and preserves original operation',
  (state) => {
    const { repo, service } = fixture();
    const first = service.start(initial, 'u1');
    if (state === 'failed') {
      repo.claim(first.run_id);
      repo.fail(first.run_id, 'SOURCE_FAILED');
    } else if (state === 'cancelled') {
      repo.cancel(first.run_id, 'u2');
    } else {
      repo.claim(first.run_id);
      repo.recover();
    }
    const replay = service.start(initial, 'u1');
    expect(replay.run_id).toBe(first.run_id);
    expect(() => service.start({ ...initial, goal: 'new' }, 'u1')).toThrow(
      'RESEARCH_OPERATION_CONFLICT',
    );
    const retry = service.start({ ...initial, operation_id: 'retry' }, 'u1');
    expect(retry.dossier_id).toBe(first.dossier_id);
    expect(() =>
      service.start({ ...initial, operation_id: 'competitor' }, 'u2'),
    ).toThrow('RESEARCH_ALREADY_RUNNING');
    complete(repo, retry);
    expect(repo.versions(first.dossier_id)).toHaveLength(1);
    expect(repo.getRun(first.run_id)?.status).toBe(
      state === 'cancelled' ? 'cancelled' : 'failed',
    );
    expect(() =>
      service.start({ ...initial, operation_id: 'again' }, 'u1'),
    ).toThrow('RESEARCH_ALREADY_EXISTS');
  },
);
it('freezes per-product sources and goals independently of the write baseline', () => {
  const { repo, service } = fixture();
  const r1 = service.start({ ...initial, goal: 'Creo目标' }, 'u1');
  const v1 = complete(repo, r1);
  const r2 = service.start(
    {
      mode: 'continue',
      dossier_id: r1.dossier_id,
      base_version_id: v1.version_id,
      products: ['cst'],
      goal: 'CST目标',
      operation_id: 'two',
    },
    'u2',
  );
  const v2 = complete(repo, r2);
  const r3 = service.start(
    {
      mode: 'continue',
      dossier_id: r1.dossier_id,
      base_version_id: v2.version_id,
      products: ['creo'],
      operation_id: 'three',
    },
    'u1',
  );
  expect(r3.request.product_base_versions).toEqual({ creo: v1.version_id });
  expect(r3.request.product_goals).toEqual({ creo: 'Creo目标' });
  expect(r3.base_version_id).toBe(v2.version_id);
  const v3 = complete(repo, r3);
  expect(repo.latestProducts(r1.dossier_id).cst?.version_id).toBe(
    v2.version_id,
  );
  expect(repo.latestProducts(r1.dossier_id).creo?.version_id).toBe(
    v3.version_id,
  );
  expect(
    service.start(
      {
        mode: 'continue',
        dossier_id: r1.dossier_id,
        base_version_id: v2.version_id,
        products: ['creo'],
        operation_id: 'three',
      },
      'u1',
    ).run_id,
  ).toBe(r3.run_id);
  expect(() =>
    service.start(
      {
        mode: 'continue',
        dossier_id: r1.dossier_id,
        base_version_id: v1.version_id,
        operation_id: 'stale',
      },
      'u1',
    ),
  ).toThrow('RESEARCH_VERSION_CONFLICT');
});
it('cancel wins over late results and terminal cancellation is idempotent', () => {
  const { repo, service } = fixture();
  const run = service.start(initial, 'u1');
  repo.claim(run.run_id);
  repo.cancel(run.run_id, 'u2');
  expect(() => repo.finish(run.run_id, snapshot(run))).toThrow(
    'RESEARCH_RUN_NOT_ACTIVE',
  );
  expect(repo.versions(run.dossier_id)).toEqual([]);
  expect(repo.cancel(run.run_id, 'u3').cancelled_by).toBe('u2');
});
it('rejects quota atomically without creating a dossier and does not alter failed history', () => {
  const { repo, service, db } = fixture({ maxQueued: 1, maxPerActor: 1 });
  const run = service.start(initial, 'u1');
  expect(() =>
    service.start(
      { ...initial, credit_code: 'OTHER', operation_id: 'two' },
      'u2',
    ),
  ).toThrow('RESEARCH_QUEUE_FULL');
  expect(
    db.prepare('SELECT count(*) n FROM company_research_dossiers').get(),
  ).toMatchObject({ n: 1 });
  repo.cancel(run.run_id, 'u2');
  expect(
    service.start({ ...initial, operation_id: 'retry' }, 'u1').dossier_id,
  ).toBe(run.dossier_id);
});
it('rejects unavailable templates without writes and incompatible stored versions disable writes', () => {
  const { repo, service, db } = fixture();
  expect(() =>
    service.start({ ...initial, template_id: 'product_sales_scenario' }, 'u1'),
  ).toThrow('RESEARCH_TEMPLATE_UNAVAILABLE');
  expect(
    db.prepare('SELECT count(*) n FROM company_research_runs').get(),
  ).toMatchObject({ n: 0 });
  const run = service.start(initial, 'u1');
  const version = complete(repo, run);
  db.prepare(
    'UPDATE company_research_versions SET snapshot_json=? WHERE version_id=?',
  ).run(
    JSON.stringify({ ...version.snapshot, schema_version: 99 }),
    version.version_id,
  );
  expect(() => service.read(version.version_id)).toThrow(
    'RESEARCH_VERSION_UNSUPPORTED',
  );
  expect(() =>
    service.start(
      { ...initial, credit_code: 'OTHER', operation_id: 'new' },
      'u1',
    ),
  ).toThrow('RESEARCH_VERSION_UNSUPPORTED');
  expect(service.start(initial, 'u1').run_id).toBe(run.run_id);
});
it('uses UTC as-of time and rejects a forged snapshot without leaving partial state', () => {
  const { repo, service } = fixture();
  const run = service.start(initial, 'u1');
  repo.claim(run.run_id);
  expect(() =>
    repo.finish(run.run_id, { ...snapshot(run), credit_code: 'OTHER' }),
  ).toThrow('RESEARCH_SNAPSHOT_MISMATCH');
  expect(repo.versions(run.dossier_id)).toHaveLength(0);
  expect(repo.getRun(run.run_id)?.status).toBe('running');
  const version = repo.finish(run.run_id, snapshot(run));
  const at = new Date(Date.parse(version.created_at) + 1000).toISOString();
  const offsetAt = new Date(Date.parse(at) - 8 * 60 * 60 * 1000)
    .toISOString()
    .replace('Z', '-08:00');
  expect(
    service.readProductContext(initial.credit_code, 'creo', offsetAt)
      .version_id,
  ).toBe(version.version_id);
});
it('preserves old business records when installing research tables twice', () => {
  const { db } = fixture();
  db.prepare(
    'INSERT INTO tokens(token_hash,user_id,enabled,created_at) VALUES (?,?,?,?)',
  ).run('hash', 'u1', 1, '2026-10-17T00:00:00Z');
  const before = db.prepare('SELECT * FROM tokens').all();
  initializeDatabase(db);
  initializeDatabase(db);
  expect(db.prepare('SELECT * FROM tokens').all()).toEqual(before);
});
it('enforces per-actor quota independently of queue and all users share cancellation', () => {
  const { repo, service, db } = fixture({ maxQueued: 20, maxPerActor: 1 });
  const first = service.start(initial, 'u1');
  expect(() =>
    service.start(
      { ...initial, credit_code: 'OTHER', operation_id: 'two' },
      'u1',
    ),
  ).toThrow('RESEARCH_USER_LIMIT');
  expect(
    db.prepare('SELECT count(*) n FROM company_research_dossiers').get(),
  ).toMatchObject({ n: 1 });
  expect(repo.cancel(first.run_id, 'u2').status).toBe('cancelled');
});
it('keeps complete inherited evidence groups even when their tags include other products', () => {
  const { repo, service } = fixture();
  const run = service.start(initial, 'u1');
  repo.claim(run.run_id);
  const s = snapshot(run);
  const base = {
    source_type: 'web',
    source_key: 'doc',
    title: '职位',
    quote: '熟练Creo',
    url: 'https://example.com/job',
    published_at: null,
    collected_at: '2026-10-17T00:00:00Z',
    valid_from: null,
    valid_to: null,
    company_scope: 'confirmed',
    signal_kind: 'job_requirement',
    product_keys: ['creo', 'cst'],
    locator: { url: 'https://example.com/job', publisher: '企业甲' },
  };
  const body = {
    ...s,
    evidence: [
      { ...base, evidence_id: 'job', required_evidence_ids: ['owner'] },
      {
        ...base,
        evidence_id: 'owner',
        product_keys: ['cst'],
        required_evidence_ids: [],
      },
    ],
    claims: [
      {
        claim_id: 'c1',
        kind: 'strong_signal',
        text: '该岗位有Creo技能需求',
        product_keys: ['creo'],
        evidence_ids: ['job'],
        temporal_scope: 'unknown',
        subject_key: initial.credit_code,
        predicate: 'requires_skill',
        object_key: 'creo',
      },
    ],
  };
  expect(() =>
    repo.finish(run.run_id, { ...body, evidence: body.evidence.slice(0, 1) }),
  ).toThrow();
  expect(repo.finish(run.run_id, body).snapshot.evidence).toHaveLength(2);
});
it('replays frozen templates when current template configuration changes', () => {
  const { repo, service, db } = fixture();
  const run = service.start(initial, 'u1');
  repo.cancel(run.run_id, 'u2');
  const upgraded = new CompanyResearchService(
    new ResearchRepository(db, {
      template: { id: 'company_research', version: 2 },
    }),
    { identityLookup: () => false },
  );
  expect(upgraded.start(initial, 'u1')).toMatchObject({
    run_id: run.run_id,
    template: { id: 'company_research', version: 1 },
    replayed: true,
  });
  const enabled = new CompanyResearchService(
    new ResearchRepository(db, {
      template: { id: 'company_research', version: 2 },
    }),
    { identityLookup: () => true },
  );
  expect(() =>
    enabled.start({ ...initial, operation_id: 'new' }, 'u1'),
  ).toThrow('RESEARCH_VERSION_UNSUPPORTED');
});
it('inherits per-product goals for mixed scope and overrides all only for explicit goal', () => {
  const { repo, service } = fixture();
  const first = service.start({ ...initial, goal: 'Creo目标' }, 'u1');
  const v1 = complete(repo, first);
  const cst = service.start(
    {
      mode: 'continue',
      dossier_id: first.dossier_id,
      base_version_id: v1.version_id,
      products: ['cst'],
      goal: 'CST目标',
      operation_id: 'cst',
    },
    'u2',
  );
  const v2 = complete(repo, cst);
  const mixed = service.start(
    {
      mode: 'continue',
      dossier_id: first.dossier_id,
      base_version_id: v2.version_id,
      products: ['solidworks', 'cst', 'creo'],
      operation_id: 'mixed',
    },
    'u2',
  );
  expect(mixed.request.product_base_versions).toEqual({
    creo: v1.version_id,
    cst: v2.version_id,
    solidworks: null,
  });
  expect(mixed.request.product_goals).toMatchObject({
    creo: 'Creo目标',
    cst: 'CST目标',
  });
  expect(mixed.request.effective_goal).toContain('Creo: Creo目标');
  repo.cancel(mixed.run_id, 'u1');
  const override = service.start(
    {
      mode: 'refresh',
      dossier_id: first.dossier_id,
      base_version_id: v2.version_id,
      products: ['creo', 'cst'],
      goal: '共同目标',
      operation_id: 'override',
    },
    'u1',
  );
  expect(override.request.product_goals).toEqual({
    creo: '共同目标',
    cst: '共同目标',
  });
});


it('accepts the same fixed per-product goals in a different key insertion order but rejects changed values', () => {
  const { repo } = fixture();
  const run = repo.begin({ ...initial, products: ['creo', 'cst'] }, 'u');
  repo.claim(run.run_id);
  const s = snapshot(run);
  s.product_goals = { cst: run.request.product_goals.cst, creo: run.request.product_goals.creo };
  expect(() => repo.finish(run.run_id, { ...s, product_goals: { ...s.product_goals, creo: '不同目标' } })).toThrow('RESEARCH_SNAPSHOT_MISMATCH');
  expect(repo.finish(run.run_id, s).snapshot.product_goals).toEqual(run.request.product_goals);
});
