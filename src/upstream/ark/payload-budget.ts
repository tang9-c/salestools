import { ResearchBundleSchema, type ResearchBundle, type ResearchItem } from '../../contracts/index.js';
import { buildSearchPlan, type SearchQuery } from '../search/search-plan.js';

export const ARK_INPUT_BUDGET_GAP = '方舟输入受网关容量限制，仅选取4条代表证据，未选数据不代表不存在';

const MAX_ITEMS = 4;
const MAX_TITLE_CHARS = 80;
const MAX_SUMMARY_CHARS = 100;

type Selector = (item: ResearchItem) => boolean;

function searchSelector(plan: SearchQuery[], purpose: SearchQuery['purpose']): Selector {
  const queries = plan.filter(query => query.purpose === purpose).map(query => query.Query);
  return item => item.source === 'doubao_search'
    && item.query !== null
    && queries.includes(item.query);
}

function qccToolSelector(tool: string): Selector {
  return item => item.source === 'qcc' && item.evidenceId.includes(`-${tool}-`);
}

function truncateCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('');
}

function compactItem(item: ResearchItem): ResearchItem {
  return {
    ...item,
    title: truncateCodePoints(item.title, MAX_TITLE_CHARS),
    summary: item.summary === null ? null : truncateCodePoints(item.summary, MAX_SUMMARY_CHARS),
    content: null,
  };
}

export function compactResearchBundleForArk(bundle: ResearchBundle): ResearchBundle {
  const plan = buildSearchPlan(bundle.identity);
  const primary: Selector[] = [
    qccToolSelector('get_company_profile'),
    qccToolSelector('get_recruitment_info'),
    searchSelector(plan, 'official_products'),
    searchSelector(plan, 'recruitment'),
  ];
  const fallback: Selector[] = [
    item => item.source === 'qcc' && item.sourceKind === 'risk',
    item => item.source === 'qcc' && item.sourceKind === 'ipr',
    qccToolSelector('get_bidding_info'),
    searchSelector(plan, 'software_ecosystem'),
    searchSelector(plan, 'expansion_financing'),
  ];
  const selected: ResearchItem[] = [];
  const selectedIds = new Set<string>();
  const addFirst = (selector: Selector): void => {
    if (selected.length >= MAX_ITEMS) return;
    const item = bundle.items.find(candidate => !selectedIds.has(candidate.evidenceId) && selector(candidate));
    if (item === undefined) return;
    selected.push(item);
    selectedIds.add(item.evidenceId);
  };

  for (const selector of primary) addFirst(selector);
  for (const selector of fallback) addFirst(selector);
  for (const item of bundle.items) {
    if (selected.length >= MAX_ITEMS) break;
    if (selectedIds.has(item.evidenceId)) continue;
    selected.push(item);
    selectedIds.add(item.evidenceId);
  }

  return ResearchBundleSchema.parse({
    ...bundle,
    items: selected.map(compactItem),
    gaps: new Set(bundle.items.map(item => item.evidenceId)).size > MAX_ITEMS
      ? [...new Set([...bundle.gaps, ARK_INPUT_BUDGET_GAP])]
      : bundle.gaps,
  });
}
