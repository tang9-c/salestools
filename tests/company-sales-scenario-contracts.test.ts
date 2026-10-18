import { expect, it } from 'vitest';
import {
  parseResearchSnapshot,
  ResearchSnapshotSchema,
  type ResearchRun,
} from '../src/research/contracts.js';
import {
  fixture,
  initial,
  snapshot,
  scenarioResult,
} from './fixtures/company-sales-scenario/core.js';
function body() {
  const f = fixture();
  try {
    const r = f.service.start(initial, 'u');
    return snapshot(r);
  } finally {
    f.db.close();
  }
}
it('accepts explicit sales snapshot branch without changing legacy object schema access', () => {
  const old = body();
  expect(parseResearchSnapshot(old).template.id).toBe('company_research');
  const topic = {
    ...old,
    template: { id: 'product_sales_scenario', version: 1 },
    method_version: 'research-sales-scenario@1',
    template_result: scenarioResult(['creo']),
  };
  expect(parseResearchSnapshot(topic).template_result.kind).toBe(
    'product_sales_scenario',
  );
  expect(ResearchSnapshotSchema.shape.template_result).toBeDefined();
});
it('rejects envelope/result mismatch, unknown versions, missing or duplicate paths and scope mismatch', () => {
  const b = body();
  const topic = {
    ...b,
    template: { id: 'product_sales_scenario', version: 1 },
    template_result: scenarioResult(['creo']),
  };
  expect(ResearchSnapshotSchema.safeParse(topic).success).toBe(true);
  expect(
    ResearchSnapshotSchema.safeParse({
      ...b,
      template_result: topic.template_result,
    }).success,
  ).toBe(false);
  expect(() =>
    parseResearchSnapshot({
      ...topic,
      template: { id: 'product_sales_scenario', version: 2 },
    }),
  ).toThrow('RESEARCH_VERSION_UNSUPPORTED');
  for (const paths of [
    topic.template_result.products[0]!.paths.slice(0, 2),
    Array(3).fill(topic.template_result.products[0]!.paths[0]),
  ]) {
    expect(
      ResearchSnapshotSchema.safeParse({
        ...topic,
        template_result: {
          ...topic.template_result,
          products: [{ ...topic.template_result.products[0], paths }],
        },
      }).success,
    ).toBe(false);
  }
  expect(
    ResearchSnapshotSchema.safeParse({
      ...topic,
      template_result: scenarioResult(['cst']),
    }).success,
  ).toBe(false);
});
