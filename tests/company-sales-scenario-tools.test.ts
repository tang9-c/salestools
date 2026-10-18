import { CompanyResearchService } from '../src/research/service.js';
import { expect, it } from 'vitest';
import { fixture as http, initial } from './fixtures/company-research/http.js';
import { scenarioResult } from './fixtures/company-sales-scenario/core.js';
function output(body: any) {
  const user = JSON.parse(body.messages[1].content);
  if (user.stage !== 'final') return { claims: [], gaps: [], queries: [] };
  const result = scenarioResult(user.product_scope);
  const e = user.materials.find((e: any) => e.signal_kind === 'direct_use');
  const claims = e
    ? [
        {
          claim_id: 'visible-scene',
          kind: 'supported',
          text: e.quote,
          product_keys: ['creo'],
          evidence_ids: [e.evidence_id],
          temporal_scope: 'historical',
          subject_key: null,
          predicate: null,
          object_key: null,
        },
      ]
    : [];
  if (e) result.products[0]!.scene_claim_ids = ['visible-scene'];
  return { claims, gaps: [], queries: [], template_result: result };
}
it('returns full scenario through existing six HTTP tools with zero upstream reads and usable claim references', async () => {
  const f = await http();
  try {
    f.output(output);
    const r = await f.start({
      ...initial,
      template_id: 'product_sales_scenario',
    });
    expect(r.version_id).not.toBeNull();
    const before = f.requests.length;
    const data = await f.call('get_company_research', {
      dossier_id: r.dossier_id,
    });
    expect(data.template_result.kind).toBe('product_sales_scenario');
    expect(data.template_result.products).toHaveLength(1);
    expect(data.summary).toContain('新购');
    expect(data.summary).toContain('替换');
    expect(data.summary).toContain('补充');
    expect(data.summary.length).toBeLessThanOrEqual(4000);
    const claim = data.template_result.products[0].scene_claim_ids[0];
    expect(claim).toBeDefined();
    const evidence = await f.call('get_company_research_evidence', {
      version_id: r.version_id,
      claim_id: claim,
    });
    expect(evidence.total).toBeGreaterThan(0);
    const list = await f.call('list_company_research_versions', {
      dossier_id: r.dossier_id,
    });
    expect(list.items[0].template.id).toBe('product_sales_scenario');
    const context = new CompanyResearchService(f.repo, {
      identityLookup: () => true,
    }).readProductContext(
      initial.credit_code,
      'creo',
      f.clock.wall().toISOString(),
      r.version_id!,
    );
    expect(context).not.toHaveProperty('template_result');
    expect(context.opportunity).toEqual(data.product_assessments[0]);
    expect(f.requests).toHaveLength(before);
  } finally {
    await f.close();
  }
});
it.each(['rationale', 'prerequisites', 'questions', 'unknowns'] as const)(
  'private %s is absent from stored snapshot, complete MCP response and logs',
  async (field) => {
    for (const secret of ['person@example.com', '13812345678']) {
      const logs: string[] = [];
      const f = await http({
        logSink: {
          write: (line) => {
            logs.push(String(line));
          },
        },
      });
      try {
        f.output((body) => {
          const raw = output(body) as any;
          if (raw.template_result) {
            const product = raw.template_result.products[0];
            if (field === 'unknowns') product.unknowns = [secret];
            else
              product.paths[0][field] =
                field === 'rationale' ? secret : [secret];
          }
          return raw;
        });
        const r = await f.start({
          ...initial,
          template_id: 'product_sales_scenario',
        });
        expect(r.status).toBe('partial');
        expect(r.version_id).not.toBeNull();
        const response = await (
          await f.client('shared')
        ).callTool({
          name: 'get_company_research',
          arguments: { dossier_id: r.dossier_id },
        });
        expect(response.isError).not.toBe(true);
        expect((response.structuredContent as any).template_result.kind).toBe(
          'product_sales_scenario',
        );
        const stored = String(
          (
            f.db
              .prepare(
                'SELECT snapshot_json FROM company_research_versions WHERE version_id=?',
              )
              .get(r.version_id!) as any
          ).snapshot_json,
        );
        expect(stored).not.toContain(secret);
        expect(JSON.stringify(response)).not.toContain(secret);
        expect(JSON.stringify(logs)).not.toContain(secret);
        expect(r.budget_usage.ark).toBeLessThanOrEqual(8);
      } finally {
        await f.close();
      }
    }
  },
);
