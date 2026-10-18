import { ArkResearchModel } from '../src/research/model.js';
import { scenarioResult } from './fixtures/company-sales-scenario/core.js';
// Remote CI only: this test starts the real Rust Store binary. Missing binary MUST fail.
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { ContactGraphClient } from '../src/contacts/graph-client.js';
import { initializeDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { AssessmentRepository } from '../src/db/assessment-repository.js';
import { CompanyLinkRepository } from '../src/db/company-link-repository.js';
import { CompanyContextService } from '../src/companies/company-context-service.js';
import { GraphEvidenceCollector } from '../src/research/graph-evidence.js';
import { ResearchRepository } from '../src/research/repository.js';
import { CompanyResearchService } from '../src/research/service.js';
import { ResearchRunner } from '../src/research/runner.js';
import { buildResult } from '../src/research/opportunity-adapter.js';
import { PROFILE, CODE } from './fixtures/company-context.js';
import { TestClock } from './company-research-test-clock.js';
const binary = fileURLToPath(
  new URL('../rust/contact-graph/target/debug/contact-graph', import.meta.url),
);
const at = '2026-10-17T00:00:00.000Z';
const name = PROFILE.identity.legalName;
const proof = (field_path: string, value: unknown, quote?: string) => ({
  field_path,
  value,
  source_type: 'file',
  collected_at: at,
  locator_status: 'located',
  file_name: 'synthetic-cv.pdf',
  file_sha256: 'a'.repeat(64),
  ...(quote ? { quote } : {}),
});

it.each([
  ['skill', 'associated_skill'],
  ['direct', 'direct_use'],
  ['project', 'project_use'],
  ['supplier', 'supplier_project'],
] as const)(
  'real Rust Store %s → collector → production runner/builder → fixed result',
  async (kind, expected) => {
    await access(binary, constants.X_OK); // ENOENT/EACCES is a hard failure, never skip or compile here.
    const directory = await mkdtemp(join(tmpdir(), 'research-native-'));
    const graph = new ContactGraphClient({
      command: binary,
      dbPath: join(directory, 'graph.sqlite'),
    });
    const db = initializeDatabase(
      new DatabaseSync(join(directory, 'service.sqlite')),
    );
    try {
      const profiles = new ProfileRepository(db);
      profiles.upsert({
        ...PROFILE,
        collectedAt: at,
        basicProfile: { ...PROFILE.basicProfile, collected_at: at },
      });
      const companyContext = new CompanyContextService({
        graph,
        profiles,
        assessments: new AssessmentRepository(db),
        links: new CompanyLinkRepository(db),
        now: () => new Date(at),
        profileTtlDays: 30,
      });
      const entity = async (
        label: string,
        operation: string,
        properties: Record<string, unknown>,
      ) =>
        (
          await graph.request<{ entity_id: string }>('save_contact', {
            label,
            actor: 'synthetic',
            operation_id: operation,
            set_properties: properties,
            evidence: Object.entries(properties).flatMap(([key, value]) =>
              (Array.isArray(value) ? value : [value]).map((item) =>
                proof(
                  `properties.${key}`,
                  item,
                  typeof item === 'string' ? item : JSON.stringify(item),
                ),
              ),
            ),
          })
        ).entity_id;
      const relation = async (
        operation: string,
        source_id: string,
        target_id: string,
        relation_type: string,
        quote: string,
      ) =>
        graph.request('save_relation', {
          actor: 'synthetic',
          operation_id: operation,
          source_id,
          target_id,
          relation_type,
          properties:
            relation_type === 'worksFor'
              ? {
                  role: {
                    '@type': 'OrganizationRole',
                    roleName: '工程师',
                    startDate: '2020',
                    endDate: '2022',
                  },
                }
              : {},
          metadata:
            relation_type === 'worksFor' ? { employment_status: 'ended' } : {},
          evidence: [
            proof('$relation', { source_id, target_id, relation_type }, quote),
            ...(relation_type === 'worksFor'
              ? [
                  proof('properties.role.roleName', '工程师', quote),
                  proof('properties.role.startDate', '2020', quote),
                  proof('properties.role.endDate', '2022', quote),
                ]
              : []),
          ],
        });
      const org = await entity('Organization', 'company', {
        name,
        identifier: [
          { '@type': 'PropertyValue', propertyID: 'credit_code', value: CODE },
        ],
      });
      const supplier = await entity('Organization', 'supplier', {
        name: '合成供应商',
      });
      const person = await entity('Person', 'person', {
        name: '合成人物甲',
        skills: ['Creo'],
      });
      await relation(
        'employment',
        person,
        kind === 'supplier' ? supplier : org,
        'worksFor',
        kind === 'direct'
          ? `合成人物甲2020至2022年在${name}担任工程师使用Creo设计`
          : `合成人物甲在${kind === 'supplier' ? '合成供应商' : name}任工程师`,
      );
      if (kind === 'project' || kind === 'supplier') {
        const project = await entity('Project', 'project', {
          name: '合成项目P',
          description:
            kind === 'project'
              ? `${name}内部合成项目P使用Creo设计`
              : '合成供应商在合成项目P使用Creo设计',
        });
        await relation(
          'membership',
          person,
          project,
          'memberOf',
          '合成人物甲是合成项目P成员',
        );
        if (kind === 'supplier')
          await relation(
            'client',
            project,
            org,
            'clientOrganization',
            `合成项目P客户是${name}`,
          );
      }
      // A spouse with personal skills must never become company deployment evidence.
      const relative = await entity('Person', 'relative', {
        name: '家庭成员乙',
        skills: ['Creo'],
      });
      await relation(
        'family',
        person,
        relative,
        'spouse',
        '合成人物甲与家庭成员乙为配偶',
      );
      const collector = new GraphEvidenceCollector({
        organizations: companyContext,
        now: () => new Date(at),
      });
      const repo = new ResearchRepository(db);
      const run = repo.begin(
        {
          mode: 'initial',
          legal_name: name,
          credit_code: CODE,
          products: ['creo'],
          operation_id: kind,
        },
        'synthetic',
      );
      let scenarioDispatches = 0;
      const runner = new ResearchRunner({
        repository: repo,
        clock: new TestClock(),
        resultBuilder: buildResult,
        sources: (context) => ({
          async collectQcc() {
            return {
              evidence: [],
              checks: [],
              source_status: [],
              warnings: [],
            };
          },
          async search() {
            return {
              evidence: [],
              checks: [],
              source_status: [],
              warnings: [],
            };
          },
          async collectGraph(_work, signal) {
            const batch = await collector.collect(
              { credit_code: CODE, legal_name: name },
              ['creo'],
              {
                signal,
                request: (op, payload) =>
                  context.policy.graph((s) => graph.request(op, payload, s)),
              },
            );
            return { ...batch, checks: [] };
          },
          async close() {},
        }),
        model: (context) =>
          context.run.request.template.id === 'product_sales_scenario'
            ? new ArkResearchModel(
                {
                  url: 'https://synthetic.invalid/model',
                  credential: 'synthetic',
                  model: 'synthetic',
                  template: context.run.request.template,
                  context: {
                    company_identity: { legal_name: name, credit_code: CODE },
                    effective_goal: context.run.request.effective_goal,
                    product_goals: context.run.request.product_goals,
                  },
                  fetchFn: async (_url, init) => {
                    scenarioDispatches++;
                    const user = JSON.parse(
                      JSON.parse(String(init!.body)).messages[1].content,
                    );
                    const result = scenarioResult(user.product_scope);
                    for (const product of result.products)
                      product.scene_claim_ids = (user.claims ?? [])
                        .filter((c: any) =>
                          c.product_keys.includes(product.product),
                        )
                        .slice(0, 1)
                        .map((c: any) => c.claim_id);
                    return Response.json({
                      choices: [
                        {
                          message: {
                            content: JSON.stringify({
                              claims: [],
                              gaps: [],
                              queries: [],
                              ...(user.stage === 'final'
                                ? { template_result: result }
                                : {}),
                            }),
                          },
                        },
                      ],
                    });
                  },
                },
                context.policy,
              )
            : {
                async analyze() {
                  return { claims: [], gaps: [], queries: [] };
                },
                async close() {},
              },
      });
      await runner.run(run.run_id, new AbortController().signal);
      const finished = repo.getRun(run.run_id)!;
      expect(finished.version_id, JSON.stringify(finished)).toBeTruthy();
      const version = repo.getVersion(finished.version_id!)!;
      const service = new CompanyResearchService(repo, {
        identityLookup: () => true,
      });
      const evidence = service.read(version.version_id);
      const root = evidence.evidence.find((e) => e.signal_kind === expected);
      expect(root, JSON.stringify(version.snapshot)).toBeDefined();
      expect(root!.required_evidence_ids.length).toBeGreaterThan(0);
      for (const id of root!.required_evidence_ids)
        expect(
          version.snapshot.evidence.some((e) => e.evidence_id === id),
        ).toBe(true);
      expect(version.snapshot.evidence.every((e) => e.url === null)).toBe(true);
      expect(JSON.stringify(version.snapshot)).not.toContain('家庭成员乙');
      if (kind === 'skill' || kind === 'supplier')
        expect(
          version.snapshot.claims.some(
            (c) => c.kind === 'supported' && c.predicate === 'uses',
          ),
        ).toBe(false);
      expect(
        version.snapshot.claims.some(
          (c) => c.temporal_scope === 'current_supported',
        ),
      ).toBe(false);
      const scenarioRun = repo.begin(
        {
          mode: 'continue',
          dossier_id: run.dossier_id,
          base_version_id: version.version_id,
          operation_id: 'scenario-' + kind,
          template_id: 'product_sales_scenario',
          products: ['creo'],
        },
        'synthetic',
      );
      await runner.run(scenarioRun.run_id, new AbortController().signal);
      const scenarioDone = repo.getRun(scenarioRun.run_id)!;
      expect(
        scenarioDone.version_id,
        JSON.stringify(scenarioDone),
      ).toBeTruthy();
      const scenarioSnapshot = service.read(scenarioDone.version_id!);
      expect(scenarioDispatches).toBeGreaterThan(0);
      expect(scenarioSnapshot.template_result.kind).toBe(
        'product_sales_scenario',
      );
      if (scenarioSnapshot.template_result.kind === 'product_sales_scenario')
        expect(
          scenarioSnapshot.template_result.products[0]!.paths.every(
            (p) => p.state === 'insufficient',
          ),
        ).toBe(true);
      expect(scenarioSnapshot.evidence.every((e) => e.url === null)).toBe(true);
      expect(scenarioSnapshot.product_assessments).toEqual(
        version.snapshot.product_assessments,
      );
      expect(JSON.stringify(scenarioSnapshot)).not.toContain('家庭成员乙');
      if (kind === 'skill' || kind === 'supplier')
        expect(
          scenarioSnapshot.claims.some(
            (c) => c.kind === 'supported' && c.predicate === 'uses',
          ),
        ).toBe(false);
    } finally {
      await graph.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
