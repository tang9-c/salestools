import {
  COMPANY_RESEARCH_TOPICS,
  COMPANY_RESEARCH_SYSTEM_PROMPT,
} from './company-research.js';
import {
  DEFAULT_RESEARCH_GOAL,
  RESEARCH_TEMPLATE,
  RESEARCH_METHOD_VERSION,
  type ProductKey,
} from '../contracts.js';
import {
  PRODUCT_SALES_SCENARIO_TEMPLATE_REF,
  SALES_SCENARIO_DEFAULT_GOALS,
  SALES_SCENARIO_QUESTIONS,
  salesScenarioSystemPrompt,
  validateScenarioPaths,
} from './product-sales-scenario.js';
export function getResearchTemplate(ref: { id: string; version: number }) {
  if (ref.version !== 1) throw new Error('RESEARCH_VERSION_UNSUPPORTED');
  if (ref.id === 'company_research')
    return {
      ref: RESEARCH_TEMPLATE,
      method_version: RESEARCH_METHOD_VERSION,
      defaultGoal: (_product: ProductKey) => DEFAULT_RESEARCH_GOAL,
      questions: COMPANY_RESEARCH_TOPICS,
      systemPrompt: (_stage: 'collect' | 'final') =>
        COMPANY_RESEARCH_SYSTEM_PROMPT,
    };
  if (ref.id === 'product_sales_scenario')
    return {
      ref: PRODUCT_SALES_SCENARIO_TEMPLATE_REF,
      method_version: 'research-sales-scenario@1',
      defaultGoal: (product: ProductKey) =>
        SALES_SCENARIO_DEFAULT_GOALS[product],
      questions: SALES_SCENARIO_QUESTIONS,
      systemPrompt: salesScenarioSystemPrompt,
      validateResult: validateScenarioPaths,
    };
  throw new Error('RESEARCH_TEMPLATE_UNAVAILABLE');
}
