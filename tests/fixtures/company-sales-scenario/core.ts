import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../../../src/db/database.js';
import { ResearchRepository } from '../../../src/research/repository.js';
import { CompanyResearchService } from '../../../src/research/service.js';
import type {
  ProductKey,
  ResearchRun,
} from '../../../src/research/contracts.js';
export const AT = '2026-10-17T00:00:00.000Z';
export const initial = {
  mode: 'initial' as const,
  legal_name: '企业甲',
  credit_code: '91310000123456789X',
  operation_id: 'first',
  products: ['creo'],
};
import type { SalesScenarioResult } from '../../../src/research/templates/sales-scenario-contracts.js';
export function scenarioResult(scope: ProductKey[]): SalesScenarioResult {
  return {
    kind: 'product_sales_scenario' as const,
    products: scope.map((product) => ({
      product,
      scene_claim_ids: [],
      software_claim_ids: [],
      known_blocker_claim_ids: [],
      unknowns: ['需要核实客户场景'],
      paths: (['new_purchase', 'replacement', 'complement'] as const).map(
        (kind) => ({
          kind,
          state: 'insufficient' as const,
          rationale: '缺少已验证场景及路径前提',
          supporting_claim_ids: [],
          contradicting_claim_ids: [],
          prerequisites: [],
          questions: ['客户有哪些尚未解决的工程问题？'],
        }),
      ),
    })),
  };
}
export function snapshot(run: ResearchRun): any {
  return {
    schema_version: 1,
    template: run.request.template,
    method_version: run.request.method_version,
    evaluator_version: 'opportunity@1',
    dossier_id: run.dossier_id,
    run_id: run.run_id,
    credit_code: initial.credit_code,
    legal_name: initial.legal_name,
    effective_goal: run.request.effective_goal,
    product_goals: run.request.product_goals,
    product_keys: run.request.product_keys,
    parent_version_id: run.base_version_id,
    evidence_base_version_ids: [
      ...new Set(
        Object.values(run.request.product_base_versions).filter(Boolean),
      ),
    ],
    template_result:
      run.request.template.id === 'product_sales_scenario'
        ? scenarioResult(run.request.product_keys)
        : { kind: 'company_research' },
    summary: '缺少已验证场景',
    evidence: [],
    facts: [],
    claims: [],
    gaps: [],
    product_assessments: [],
    coverage: run.request.product_keys.map((product) => ({
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
  };
}
export function fixture() {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  const repo = new ResearchRepository(db, { now: () => new Date(AT) });
  const service = new CompanyResearchService(repo, {
    identityLookup: () => true,
  });
  return {
    db,
    repo,
    service,
    finish(run: ResearchRun) {
      repo.claim(run.run_id);
      return repo.finish(run.run_id, snapshot(run));
    },
  };
}
