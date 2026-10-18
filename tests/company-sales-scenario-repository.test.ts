import { expect, it } from 'vitest';
import { ResearchRepository } from '../src/research/repository.js';
import { fixture, initial } from './fixtures/company-sales-scenario/core.js';
it('requires selected products on sales initial without writing rows and permits failed initial retry', () => {
  const f = fixture();
  try {
    expect(() =>
      f.service.start(
        {
          ...initial,
          products: undefined,
          template_id: 'product_sales_scenario',
        },
        'u',
      ),
    ).toThrow('RESEARCH_PRODUCTS_REQUIRED');
    expect(
      f.db.prepare('SELECT count(*) n FROM company_research_runs').get(),
    ).toMatchObject({ n: 0 });
    const r = f.service.start(
      { ...initial, template_id: 'product_sales_scenario' },
      'u',
    );
    f.repo.cancel(r.run_id, 'other');
    expect(
      f.service.start(
        { ...initial, template_id: 'product_sales_scenario' },
        'u',
      ).run_id,
    ).toBe(r.run_id);
    const next = f.service.start(
      {
        ...initial,
        operation_id: 'retry',
        template_id: 'product_sales_scenario',
      },
      'u',
    );
    expect(next.dossier_id).toBe(r.dossier_id);
    expect(next.request.method_version).toBe('research-sales-scenario@1');
  } finally {
    f.db.close();
  }
});
it('selects template from dossier head but inherits goals only from matching per-product template', () => {
  const f = fixture();
  try {
    const a = f.service.start({ ...initial, goal: '原Creo通用目标' }, 'u');
    const v1 = f.finish(a);
    const input = {
      mode: 'continue',
      dossier_id: a.dossier_id,
      base_version_id: v1.version_id,
      operation_id: 'cst',
      template_id: 'product_sales_scenario',
      products: ['cst'],
      goal: 'CST专题目标',
    };
    expect(() =>
      f.service.start({ ...input, products: undefined }, 'u'),
    ).toThrow('RESEARCH_PRODUCTS_REQUIRED');
    const b = f.service.start(input, 'u');
    const v2 = f.finish(b);
    const c = f.service.start(
      {
        mode: 'continue',
        dossier_id: a.dossier_id,
        base_version_id: v2.version_id,
        operation_id: 'creo',
        products: ['creo'],
      },
      'other',
    );
    expect(c.request.template.id).toBe('product_sales_scenario');
    expect(c.request.product_base_versions.creo).toBe(v1.version_id);
    expect(c.request.product_goals.creo).not.toBe('原Creo通用目标');
    expect(c.request.product_goals.creo).not.toBe('CST专题目标');
    const v3 = f.finish(c);
    const d = f.service.start(
      {
        mode: 'continue',
        dossier_id: a.dossier_id,
        base_version_id: v3.version_id,
        operation_id: 'same',
        products: ['cst'],
      },
      'u',
    );
    expect(d.request.product_goals.cst).toBe('CST专题目标');
    const v4 = f.finish(d);
    expect(() =>
      f.service.start(
        {
          mode: 'continue',
          dossier_id: a.dossier_id,
          base_version_id: v4.version_id,
          operation_id: 'back',
          template_id: 'company_research',
        },
        'u',
      ),
    ).toThrow('RESEARCH_PRODUCTS_REQUIRED');
    const e = f.service.start(
      {
        mode: 'continue',
        dossier_id: a.dossier_id,
        base_version_id: v4.version_id,
        operation_id: 'back',
        template_id: 'company_research',
        products: ['creo'],
        goal: '覆盖目标',
      },
      'u',
    );
    expect(e.request.product_goals.creo).toBe('覆盖目标');
    expect(e.request.method_version).toBe('research@1');
  } finally {
    f.db.close();
  }
});
it('replays accepted sales operations before resolving an unsupported current default', () => {
  const f = fixture();
  try {
    const input = { ...initial, template_id: 'product_sales_scenario' };
    const r = f.service.start(input, 'u');
    f.repo.cancel(r.run_id, 'u');
    const newer = new ResearchRepository(f.db, {
      template: { id: 'company_research', version: 2 },
    });
    expect(newer.begin(input, 'u').run_id).toBe(r.run_id);
    expect(() => newer.begin({ ...input, goal: 'different' }, 'u')).toThrow(
      'RESEARCH_OPERATION_CONFLICT',
    );
    const other = newer.begin({ ...input, operation_id: 'other' }, 'other');
    expect(other.actor).toBe('other');
  } finally {
    f.db.close();
  }
});
