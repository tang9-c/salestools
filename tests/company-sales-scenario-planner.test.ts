import { expect, it } from 'vitest';
import { planResearch } from '../src/research/planner.js';
import { ProductKeySchema } from '../src/research/contracts.js';
import {
  fixture,
  initial,
  AT,
} from './fixtures/company-sales-scenario/core.js';
it('uses controlled product-specific scene focus for all seven products without changing topic allowlist', () => {
  const f = fixture();
  try {
    const r = f.service.start(
      {
        ...initial,
        products: [...ProductKeySchema.options],
        template_id: 'product_sales_scenario',
      },
      'u',
    );
    const work = planResearch(r, {}, [], new Date(AT));
    const expected = {
      windchill: 'BOM',
      feigenbaum_qms: '追溯',
      creo: '装配',
      catia: '曲面',
      abaqus: '非线性',
      cst: '电磁',
      solidworks: '工程图',
    };
    for (const [product, term] of Object.entries(expected))
      expect(
        work.some(
          (w) =>
            w.product_keys.includes(product as any) &&
            w.focus_terms?.includes(term),
        ),
      ).toBe(true);
    expect(
      work.every((w) =>
        [
          'business',
          'engineering',
          'recruitment',
          'software',
          'quality',
          'procurement',
          'project',
        ].includes(w.topic),
      ),
    ).toBe(true);
  } finally {
    f.db.close();
  }
});
