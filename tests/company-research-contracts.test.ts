import { expect, it } from 'vitest';
import {
  StartResearchInputSchema,
  ResearchSnapshotSchema,
  normalizeResearchRequest,
} from '../src/research/contracts.js';
const initial = {
  mode: 'initial',
  legal_name: '企业甲',
  credit_code: '91310000123456789X',
  operation_id: 'one',
};
it('rejects client supplied server fields and mode-inappropriate identity', () => {
  for (const extra of [
    { actor: 'attacker' },
    { product_base_versions: {} },
    { template: { id: 'company_research', version: 2 } },
    { base_version_id: 'v' },
  ]) {
    expect(
      StartResearchInputSchema.safeParse({ ...initial, ...extra }).success,
    ).toBe(false);
  }
  expect(
    StartResearchInputSchema.safeParse({ ...initial, products: [] }).success,
  ).toBe(false);
  expect(
    StartResearchInputSchema.safeParse({
      ...initial,
      products: ['creo', 'creo'],
    }).success,
  ).toBe(false);
  expect(
    StartResearchInputSchema.safeParse({ ...initial, products: ['invented'] })
      .success,
  ).toBe(false);
});
it('normalizes scope order and whitespace but preserves omitted template selection', () => {
  expect(
    normalizeResearchRequest({
      ...initial,
      products: ['cst', 'creo'],
      goal: ' a ',
    }),
  ).toMatchObject({ products: ['creo', 'cst'], goal: 'a' });
  expect(normalizeResearchRequest(initial)).not.toHaveProperty('template_id');
});
it('rejects unknown schema and templates rather than decoding generic result', () => {
  expect(ResearchSnapshotSchema.safeParse({ schema_version: 2 }).success).toBe(
    false,
  );
});
it('rejects executable or local web evidence URLs and mismatched locator URL', async () => {
  const { ResearchEvidenceSchema } = await import(
    '../src/research/contracts.js'
  );
  const base = {
    evidence_id: 'e1',
    source_key: 's1',
    title: '职位',
    quote: '熟练Creo',
    source_type: 'web',
    url: 'https://example.com/job',
    published_at: null,
    collected_at: '2026-10-17T00:00:00Z',
    valid_from: null,
    valid_to: null,
    company_scope: 'confirmed',
    signal_kind: 'job_requirement',
    product_keys: ['creo'],
    required_evidence_ids: [],
    locator: { url: 'https://example.com/job', publisher: '企业甲' },
  };
  expect(ResearchEvidenceSchema.safeParse(base).success).toBe(true);
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,test',
  ])
    expect(
      ResearchEvidenceSchema.safeParse({
        ...base,
        url,
        locator: { ...base.locator, url },
      }).success,
    ).toBe(false);
  expect(
    ResearchEvidenceSchema.safeParse({
      ...base,
      locator: { ...base.locator, url: 'https://other.example/job' },
    }).success,
  ).toBe(false);
});
