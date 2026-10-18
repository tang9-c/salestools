import type { ProductKey } from '../../contracts/evidence.js';
export * from './sales-scenario-contracts.js';
export const SALES_SCENARIO_DEFAULT_GOALS: Readonly<
  Record<ProductKey, string>
> = {
  windchill:
    '核实产品数据、BOM、变更、版本和协作场景，评估有证据的新购、替换与补充探索路径',
  feigenbaum_qms:
    '核实来料、过程、供应商质量和追溯流程，评估有证据的新购、替换与补充探索路径',
  creo: '核实机械设计、装配、变型与设计协同场景，评估有证据的新购、替换与补充探索路径',
  catia:
    '核实复杂产品、曲面及系统设计活动，评估有证据的新购、替换与补充探索路径',
  abaqus:
    '核实结构、材料、接触及非线性分析任务，评估有证据的新购、替换与补充探索路径',
  cst: '核实电磁、天线、射频及EMC验证任务，评估有证据的新购、替换与补充探索路径',
  solidworks:
    '核实机械设计、产品开发、工程图和协作场景，评估有证据的新购、替换与补充探索路径',
};

import type { ResearchClaim, ResearchEvidence } from '../contracts.js';
import {
  evidenceDependencyGroup,
  validateClaim,
  hasUseLimitation,
} from '../evidence.js';
import {
  SalesScenarioResultSchema,
  hasPrivateScenarioText,
  type SalesScenarioResult,
} from './sales-scenario-contracts.js';
import { COMPANY_RESEARCH_SYSTEM_PROMPT } from './company-research.js';
export const SALES_SCENARIO_QUESTIONS: Readonly<
  Record<
    ProductKey,
    {
      topic: 'engineering' | 'quality';
      terms: readonly string[];
      question: string;
    }
  >
> = {
  windchill: {
    topic: 'engineering',
    terms: ['BOM', '变更', '协作'],
    question: '核实产品数据、BOM、变更及版本协作的实际流程和限制',
  },
  feigenbaum_qms: {
    topic: 'quality',
    terms: ['追溯', '质量', '流程'],
    question: '核实来料、过程、供应商质量和问题闭环的实际流程',
  },
  creo: {
    topic: 'engineering',
    terms: ['装配', '变型', '设计'],
    question: '核实机械设计、装配、变型和协同活动',
  },
  catia: {
    topic: 'engineering',
    terms: ['曲面', '复杂产品', '设计'],
    question: '核实企业自身复杂产品和曲面设计活动',
  },
  abaqus: {
    topic: 'engineering',
    terms: ['非线性', '结构', '材料'],
    question: '核实内部结构、材料和非线性分析验证任务',
  },
  cst: {
    topic: 'engineering',
    terms: ['电磁', '天线', 'EMC'],
    question: '核实电磁、天线、射频和EMC验证任务',
  },
  solidworks: {
    topic: 'engineering',
    terms: ['工程图', '机械', '协作'],
    question: '核实机械产品开发、工程图及协作场景',
  },
};
export function salesScenarioSystemPrompt(stage: 'collect' | 'final'): string {
  const basePrompt =
    stage === 'final'
      ? COMPANY_RESEARCH_SYSTEM_PROMPT.replace(
          '严格包含claims、gaps、queries数组',
          '严格包含claims、gaps、queries数组和template_result对象',
        )
      : COMPANY_RESEARCH_SYSTEM_PROMPT;
  return (
    basePrompt +
    '\n当前固定模板为product_sales_scenario@1。产品问题仅为客户调查方向，不是产品能力或优势。' +
    (stage === 'collect'
      ? '采集阶段只输出claims/gaps/queries，不输出销售路径。'
      : '最终阶段仅输出claims/gaps/queries/template_result，queries必须为空。template_result为{kind:"product_sales_scenario",products:[{product,scene_claim_ids,software_claim_ids,known_blocker_claim_ids,unknowns,paths}]}。每产品paths必须包含new_purchase/replacement/complement各一条，字段为kind,state,rationale,supporting_claim_ids,contradicting_claim_ids,prerequisites,questions。state仅worth_exploring/insufficient/contradicted。路径是待验证假设，不是成交概率。只引用输入claims或本次合法claims的ID；不复制证据内容作为新事实。新购/补充需实际场景与明确新增/未满足活动，替换另需现有方案与明确限制，只有竞品或招聘不足以提出替换。个人技能、供应商使用、历史、过期和否定不能证明当前企业需要。assessed_at是服务端评估时间，不是来源发布时间。支持路径的原文需明确描述现状，具有不晚于assessed_at且最近30天内的可信发布时间；原文的过去时、旧年份与有效期限定必须保留。满足这些条件的历史标记claim可支持待验证探索，但不得把其时间字段提升为当前部署事实。worth_exploring与contradicted的rationale必须逐字引用一条相关、可信claim的完整text（不超过1000字），不能自行扩写事实；无法完整保留限定或证明语义时用insufficient并写缺口；不得使用单个痛点词提升，不声称我方更优或现有产品能力不足。所有新增自由文本禁止个人联系方式。历史claims必须保留原ID及限定，事实和假设分开。')
  );
}
export interface ScenarioValidationContext {
  claims: readonly ResearchClaim[];
  evidence: readonly ResearchEvidence[];
  scope: readonly ProductKey[];
  companyKey?: string;
  asOf?: Date;
}
export function parseScenarioFinal(
  raw: unknown,
  visibleClaims: readonly ResearchClaim[],
  evidence: readonly ResearchEvidence[],
  scope: readonly ProductKey[],
  companyKey?: string,
): SalesScenarioResult {
  try {
    const parsed = SalesScenarioResultSchema.parse(raw);
    if (
      hasPrivateScenarioText(parsed) ||
      parsed.products.length !== scope.length ||
      scope.some((p) => !parsed.products.some((x) => x.product === p))
    )
      throw new Error();
    const claims = new Map(visibleClaims.map((c) => [c.claim_id, c]));
    for (const product of parsed.products) {
      const refs = [
        ...product.scene_claim_ids,
        ...product.software_claim_ids,
        ...product.known_blocker_claim_ids,
        ...product.paths.flatMap((p) => [
          ...p.supporting_claim_ids,
          ...p.contradicting_claim_ids,
        ]),
      ];
      for (const id of refs) {
        const c = claims.get(id);
        if (
          !c ||
          !c.product_keys.includes(product.product) ||
          (c.subject_key !== null && c.subject_key !== companyKey) ||
          !validateClaim(c, evidence) ||
          c.evidence_ids.some(
            (id) =>
              !evidence.find((e) => e.evidence_id === id) ||
              !evidenceDependencyGroup(
                evidence.find((e) => e.evidence_id === id)!,
                evidence,
              ),
          )
        )
          throw new Error();
      }
    }
    return parsed;
  } catch {
    throw new Error('TEMPLATE_OUTPUT_INVALID');
  }
}
/** Evidence categories are necessary guards, never a complete free-text semantic proof. */
export function validateScenarioPaths(
  result: SalesScenarioResult,
  context: ScenarioValidationContext,
): { result: SalesScenarioResult; warnings: string[] } {
  const value = parseScenarioFinal(
    result,
    context.claims,
    context.evidence,
    context.scope,
    context.companyKey,
  );
  const claims = new Map(context.claims.map((c) => [c.claim_id, c]));
  const warnings: string[] = [];
  const trusted = (id: string) => {
    const c = claims.get(id);
    if (!c || c.kind !== 'supported' || c.temporal_scope === 'unknown')
      return false;
    const roots = context.evidence.filter((e) =>
      c.evidence_ids.includes(e.evidence_id),
    );
    const now = context.asOf ?? new Date();
    const explicitPresent = /目前|当前|正在|现有|主营|明确拒绝/u.test(c.text);
    const pastQualifier =
      /曾经|过去|此前|历史|当时|原先|曾在|曾使用/u.test(c.text) ||
      [...c.text.matchAll(/\b(20\d{2})年?/gu)].some(
        (m) => Number(m[1]) < now.getUTCFullYear(),
      );
    // A fresh, explicitly present-tense public statement can support a qualified
    // exploration even without valid_from. Its claim remains historical.
    const fresh =
      Number.isFinite(now.getTime()) &&
      roots.every((e) => {
        const published = e.published_at ? Date.parse(e.published_at) : NaN;
        return (
          Number.isFinite(published) &&
          published <= now.getTime() &&
          now.getTime() - published <= 30 * 86400000 &&
          (!e.valid_to || Date.parse(e.valid_to) >= now.getTime())
        );
      });
    return (
      roots.length > 0 &&
      fresh &&
      explicitPresent &&
      !pastQualifier &&
      roots.every(
        (e) =>
          e.company_scope === 'confirmed' &&
          !['associated_skill', 'supplier_project', 'job_requirement'].includes(
            e.signal_kind,
          ),
      ) &&
      roots.some((e) => e.quote.includes(c.text))
    );
  };
  const text = (ids: string[]) =>
    ids.filter(trusted).map((id) => claims.get(id)!.text);
  const sceneTerms: Record<ProductKey, RegExp> = {
    windchill: /BOM|产品数据|变更|版本管理|PLM|PDM/iu,
    feigenbaum_qms: /质量|追溯|来料|不合格/iu,
    creo: /机械|装配|变型|Creo|CAD/iu,
    catia: /曲面|复杂产品|CATIA/iu,
    abaqus: /结构|材料|接触|非线性|Abaqus/iu,
    cst: /电磁|天线|射频|EMC|CST/iu,
    solidworks: /机械|工程图|SolidWorks/iu,
  };
  const scene = (ids: string[], product: ProductKey) =>
    text(ids).some(
      (t) =>
        /(?:开展|进行|从事|负责|研发|设计|生产|制造|管理).{2,}/u.test(t) &&
        sceneTerms[product].test(t),
    );
  const need = (ids: string[]) =>
    text(ids).some((t) =>
      /(?:现有|目前|当前|仍).{0,35}(?:无法|不能满足|缺乏|未覆盖)|(?:启动|开展|新增).{1,30}(?:新项目|新增项目|新增产品|新产品项目)/u.test(
        t,
      ),
    );
  const existing = (ids: string[]) =>
    ids.some(
      (id) =>
        trusted(id) &&
        context.evidence.some(
          (e) =>
            claims.get(id)!.evidence_ids.includes(e.evidence_id) &&
            ['direct_use', 'project_use'].includes(e.signal_kind) &&
            !hasUseLimitation(e.quote),
        ),
    );
  for (const product of value.products)
    for (const path of product.paths) {
      let allowed = true;
      if (path.state === 'worth_exploring')
        allowed =
          scene(
            [...product.scene_claim_ids, ...path.supporting_claim_ids],
            product.product,
          ) &&
          text(path.supporting_claim_ids).includes(path.rationale) &&
          need(path.supporting_claim_ids) &&
          path.prerequisites.length > 0 &&
          path.questions.length > 0 &&
          (path.kind !== 'replacement' ||
            existing([
              ...product.software_claim_ids,
              ...path.supporting_claim_ids,
            ]));
      if (path.state === 'contradicted')
        allowed =
          text(path.contradicting_claim_ids).includes(path.rationale) &&
          text(path.contradicting_claim_ids).some((t) =>
            /(?:不启动|暂无.{0,10}计划|取消.{0,20}项目|明确拒绝)/u.test(t),
          );
      if (
        path.state === 'insufficient' &&
        ![
          '缺少已验证场景及路径前提',
          '专题分析未完成，当前依据不足以支持该路径',
          '现有可验证资料不足以支持该路径，需核实客户场景与成立前提',
          '尚缺可核实的客户场景、现有方案或路径前提，当前依据不足',
        ].includes(path.rationale)
      )
        path.rationale =
          '尚缺可核实的客户场景、现有方案或路径前提，当前依据不足';
      if (!allowed) {
        path.state = 'insufficient';
        path.rationale =
          '现有可验证资料不足以支持该路径，需核实客户场景与成立前提';
        path.questions = ['客户的实际活动、约束和后续安排是什么？'];
        warnings.push('TEMPLATE_OUTPUT_INVALID');
      }
    }
  return { result: value, warnings: [...new Set(warnings)] };
}

export function insufficientSalesScenario(
  scope: readonly ProductKey[],
): SalesScenarioResult {
  return {
    kind: 'product_sales_scenario',
    products: scope.map((product) => ({
      product,
      scene_claim_ids: [],
      software_claim_ids: [],
      known_blocker_claim_ids: [],
      unknowns: ['专题分析未完成，需核实客户场景与路径前提'],
      paths: (['new_purchase', 'replacement', 'complement'] as const).map(
        (kind) => ({
          kind,
          state: 'insufficient',
          rationale: '专题分析未完成，当前依据不足以支持该路径',
          supporting_claim_ids: [],
          contradicting_claim_ids: [],
          prerequisites: [],
          questions: ['客户的实际场景和未满足需求是什么？'],
        }),
      ),
    })),
  };
}
