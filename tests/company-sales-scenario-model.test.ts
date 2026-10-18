import { expect, it } from 'vitest';
import { parseAnalysis, packModelRequest } from '../src/research/model.js';
import { ingestEvidence } from '../src/research/evidence.js';
import {
  ResearchSnapshotSchema,
  type ResearchClaim,
} from '../src/research/contracts.js';
import {
  AT,
  initial,
  scenarioResult,
  fixture,
  snapshot,
} from './fixtures/company-sales-scenario/core.js';
const template = { id: 'product_sales_scenario', version: 1 } as const;
const ctx = {
  company_identity: {
    legal_name: initial.legal_name,
    credit_code: initial.credit_code,
  },
  effective_goal: '核实设计场景',
  product_goals: { creo: '核实设计场景' },
};
const e = ingestEvidence(
  {
    source_type: 'web',
    url: 'https://example.com/design',
    publisher: '企业甲',
    content: '企业甲当前开展Creo机械产品设计，现有协作流程无法满足新增产品项目',
    collected_at: AT,
    published_at: AT,
    valid_from: AT,
    company_scope: 'confirmed',
  },
  {
    title: '工程活动',
    quote: '企业甲当前开展Creo机械产品设计，现有协作流程无法满足新增产品项目',
    product_keys: ['creo'],
    signal_kind: 'other',
  },
)!;
const claim: ResearchClaim = {
  claim_id: 'scene',
  kind: 'supported',
  text: e.quote,
  product_keys: ['creo'],
  evidence_ids: [e.evidence_id],
  temporal_scope: 'current_supported',
  subject_key: null,
  predicate: null,
  object_key: null,
};
function parse(raw: unknown, claims = [claim], materials = [e]) {
  return parseAnalysis(raw, materials, [], ['creo'], initial.credit_code, {
    template,
    stage: 'final',
    claims,
    asOf: new Date(AT),
  });
}
const raw = () => ({
  claims: [],
  gaps: [],
  queries: [],
  template_result: scenarioResult(['creo']),
});
it('final accepts visible verified historical claim IDs; collect never accepts scenario output', () => {
  const data = raw();
  data.template_result.products[0]!.scene_claim_ids = ['scene'];
  expect(parse(data).template_result?.kind).toBe('product_sales_scenario');
  expect(() =>
    parseAnalysis(data, [e], [], ['creo'], initial.credit_code, {
      template,
      stage: 'collect',
      claims: [claim],
    }),
  ).toThrow();
  expect(() =>
    parse({
      ...data,
      queries: [{ gap_id: 'g', topic: 'business', product_keys: ['creo'] }],
    }),
  ).toThrow();
});
it('never treats recruitment alone or associated/supplier use as replacement prerequisites', () => {
  for (const signal_kind of [
    'job_requirement',
    'associated_skill',
    'supplier_project',
  ] as const) {
    const data = raw();
    const p = data.template_result.products[0]!;
    p.scene_claim_ids = ['scene'];
    p.software_claim_ids = ['scene'];
    Object.assign(p.paths[1]!, {
      state: 'worth_exploring',
      supporting_claim_ids: ['scene'],
      rationale: '待验证现有流程限制',
      prerequisites: ['待验证实际需求'],
    });
    expect(
      parse(data, [claim], [{ ...e, signal_kind }]).template_result?.products[0]
        ?.paths[1]?.state,
    ).toBe('insufficient');
  }
});
it('accepts supported scene and explicit unmet activity as exploration, not a keyword pain', () => {
  const data = raw();
  data.template_result.products[0]!.scene_claim_ids = ['scene'];
  Object.assign(data.template_result.products[0]!.paths[0]!, {
    state: 'worth_exploring',
    supporting_claim_ids: ['scene'],
    rationale: claim.text,
    prerequisites: ['核实新增项目的范围'],
    questions: ['现有流程的具体约束是什么？'],
  });
  expect(parse(data).template_result?.products[0]?.paths[0]?.state).toBe(
    'worth_exploring',
  );
  const weak = { ...e, quote: '企业甲关注设计痛点', title: '活动' };
  expect(
    parse(data, [{ ...claim, text: weak.quote }], [weak]).template_result
      ?.products[0]?.paths[0]?.state,
  ).toBe('insufficient');
});
it.each(['rationale', 'prerequisites', 'questions', 'unknowns'] as const)(
  'rejects private %s at model and inherited snapshot storage boundaries',
  (field) => {
    for (const secret of ['person@example.com', '13812345678']) {
      const data = raw();
      const p = data.template_result.products[0]!;
      if (field === 'unknowns') p.unknowns = [secret];
      else if (field === 'rationale') p.paths[0]!.rationale = secret;
      else p.paths[0]![field] = [secret];
      expect(() => parse(data)).toThrow('TEMPLATE_OUTPUT_INVALID');
      const f = fixture();
      try {
        const run = f.service.start(
          { ...initial, template_id: 'product_sales_scenario' },
          'u',
        );
        const body = snapshot(run);
        body.template_result = data.template_result;
        expect(ResearchSnapshotSchema.safeParse(body).success).toBe(false);
      } finally {
        f.db.close();
      }
    }
  },
);
it('rejects unseen/cross-product/cross-company claims and keeps total serialized body bounded', () => {
  const data = raw();
  data.template_result.products[0]!.scene_claim_ids = ['not-visible'];
  expect(() => parse(data)).toThrow('TEMPLATE_OUTPUT_INVALID');
  data.template_result.products[0]!.scene_claim_ids = ['scene'];
  expect(() =>
    parse(data, [{ ...claim, subject_key: 'other-company' }]),
  ).toThrow('TEMPLATE_OUTPUT_INVALID');
  expect(() => parse(data, [{ ...claim, product_keys: ['cst'] }])).toThrow(
    'TEMPLATE_OUTPUT_INVALID',
  );
  const packed = packModelRequest('m', [e], [], ['creo'], ctx, 16000, {
    template,
    stage: 'final',
    claims: [claim],
    asOf: new Date(AT),
  });
  const body = JSON.parse(packed.body);
  const user = JSON.parse(body.messages[1].content);
  expect(user.claims).toEqual([claim]);
  expect(user.template).toEqual(template);
  expect(user.stage).toBe('final');
  expect(user.assessed_at).toBe(AT);
  expect(user.questions).toHaveLength(1);
  expect(user.questions[0].product).toBe('creo');
  expect(user.questions[0].question).toContain('装配');
  expect(Buffer.byteLength(packed.body)).toBeLessThanOrEqual(16000);
  const trimmed = packModelRequest(
    'm',
    [e],
    [],
    ['creo'],
    ctx,
    Buffer.byteLength(packed.body) - 100,
    { template, stage: 'final', claims: [claim], asOf: new Date(AT) },
  );
  expect(
    JSON.parse(JSON.parse(trimmed.body).messages[1].content).claims,
  ).toEqual([]);
});

it('downgrades invented purchase facts even when the cited scene and unmet need categories are valid', () => {
  const data = raw();
  const product = data.template_result.products[0]!;
  product.scene_claim_ids = ['scene'];
  Object.assign(product.paths[0]!, {
    state: 'worth_exploring',
    supporting_claim_ids: ['scene'],
    rationale: '企业甲已经批准采购100套Creo并确定供应商',
    prerequisites: ['核实需求'],
    questions: ['哪些需求尚未满足？'],
  });
  expect(parse(data).template_result?.products[0]?.paths[0]?.state).toBe(
    'insufficient',
  );
});
it('insufficient rationale cannot publish an affirmative customer purchase claim', () => {
  const data = raw();
  data.template_result.products[0]!.paths[0]!.rationale =
    '企业甲已经确定采购100套Creo';
  expect(
    parse(data).template_result?.products[0]?.paths[0]?.rationale,
  ).toContain('依据不足');
});
it('does not borrow mechanical design scenes for a CST path despite in-scope IDs', () => {
  const data = {
    claims: [],
    gaps: [],
    queries: [],
    template_result: scenarioResult(['cst']),
  };
  const p = data.template_result.products[0]!;
  p.scene_claim_ids = ['scene'];
  Object.assign(p.paths[0]!, {
    state: 'worth_exploring',
    supporting_claim_ids: ['scene'],
    rationale: claim.text,
    prerequisites: ['核实任务'],
    questions: ['有哪些电磁任务？'],
  });
  const result = parseAnalysis(
    data,
    [{ ...e, product_keys: ['cst'] }],
    [],
    ['cst'],
    initial.credit_code,
    { template, stage: 'final', claims: [{ ...claim, product_keys: ['cst'] }] },
  );
  expect(result.template_result?.products[0]?.paths[0]?.state).toBe(
    'insufficient',
  );
});
it('never exposes more than sixty historical claims in a single actual model body', () => {
  const claims = Array.from({ length: 61 }, (_, i) => ({
    ...claim,
    claim_id: 'claim-' + i,
  }));
  const packed = packModelRequest('m', [e], [], ['creo'], ctx, 100000, {
    template,
    stage: 'final',
    claims,
  });
  const user = JSON.parse(JSON.parse(packed.body).messages[1].content);
  expect(user.claims).toHaveLength(60);
  expect(user.claims.some((c: any) => c.claim_id === 'claim-60')).toBe(false);
});
