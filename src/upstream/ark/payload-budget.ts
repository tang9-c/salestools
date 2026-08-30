import { ResearchBundleSchema, type ResearchBundle, type ResearchItem } from '../../contracts/index.js';
import { buildSearchPlan, type SearchQuery } from '../search/search-plan.js';

export const ARK_INPUT_BUDGET_GAP = '方舟输入受网关容量限制，仅选取4条代表证据，未选数据不代表不存在';
export const ARK_COMPACT_BUNDLE_MAX_BYTES = 6_656;
export const ARK_REQUEST_MAX_BYTES = 12_288;

const MAX_ITEMS = 4;
const INITIAL_SUMMARY_BYTES = 512;
const INITIAL_DEMAND_CONTENT_BYTES = 1_536;
const INITIAL_SUPPORT_CONTENT_BYTES = 1_024;
const SHRINK_STEP_BYTES = 256;

const IMPORTANT_EVIDENCE_PATTERN = new RegExp([
  '采购公告', '招标公告', '中标公告', '采购文件', '采购项目', '采购合同',
  '采购意向', '计划\\s*采购', '拟\\s*采购', '即将\\s*采购', '采购需求', '准备\\s*采购',
  '招聘', '职位', '岗位', '任职要求', '工作职责', '扩产', '融资', '投资方',
  'Windchill', 'Feigenbaum', 'QMS', 'Creo', 'Pro\\s*/?\\s*E', 'CATIA', 'Abaqus',
  'CST(?:\\s+Studio(?:\\s+Suite)?)?', 'Solid\\s*Works', 'PLM', 'PDM', 'BOM', 'CAPA',
  '有限元', '非线性', '仿真', '射频', '天线', '雷达', 'EMC', 'EMI', '参数化',
].join('|'), 'giu');

type ItemState = {
  readonly original: ResearchItem;
  item: ResearchItem;
  contentBudget: number;
  summaryBudget: number;
  readonly preferredContentBytes: number;
  readonly preserveFinancingContent: boolean;
};

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  let bytes = 0;
  let output = '';
  for (const codePoint of value) {
    const next = utf8Bytes(codePoint);
    if (bytes + next > maxBytes) break;
    output += codePoint;
    bytes += next;
  }
  return output;
}

function evidenceExcerpt(value: string, maxBytes: number): string | null {
  if (maxBytes <= 0) return null;
  if (utf8Bytes(value) <= maxBytes) return value;

  const matches = [...value.matchAll(IMPORTANT_EVIDENCE_PATTERN)];
  if (matches.length === 0) {
    const head = truncateUtf8(value, maxBytes);
    return head.length === 0 ? null : head;
  }

  const separator = '\n…\n';
  const headBudget = Math.min(384, Math.floor(maxBytes / 3));
  const head = truncateUtf8(value, headBudget);
  const remaining = Math.max(0, maxBytes - utf8Bytes(head) - utf8Bytes(separator));
  const firstMatch = matches[0]!;
  const start = Math.max(0, (firstMatch.index ?? 0) - 180);
  const lastNearbyMatch = matches.findLast(match => (match.index ?? 0) - start < 700) ?? firstMatch;
  const end = Math.min(value.length, (lastNearbyMatch.index ?? 0) + lastNearbyMatch[0].length + 220);
  const evidence = truncateUtf8(value.slice(start, end), remaining);
  if (head.length === 0) return evidence.length === 0 ? null : evidence;
  if (evidence.length === 0 || value.slice(0, head.length).includes(evidence)) return head;
  return `${head}${separator}${evidence}`;
}

function financingContent(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return JSON.stringify({
      occurredAt: parsed['occurredAt'] ?? null,
      typeOrRound: parsed['typeOrRound'] ?? null,
      disclosedAmount: parsed['disclosedAmount'] ?? null,
      investors: Array.isArray(parsed['investors']) ? parsed['investors'] : [],
    });
  } catch {
    return evidenceExcerpt(value, INITIAL_DEMAND_CONTENT_BYTES);
  }
}

function qccTool(item: ResearchItem, tool: string): boolean {
  return item.source === 'qcc' && item.evidenceId.includes(`-${tool}-`);
}

function purposeByQuery(bundle: ResearchBundle): Map<string, SearchQuery['purpose']> {
  return new Map(buildSearchPlan(bundle.identity).map(query => [query.Query, query.purpose]));
}

function searchPurpose(
  item: ResearchItem,
  purposes: ReadonlyMap<string, SearchQuery['purpose']>,
): SearchQuery['purpose'] | null {
  return item.source === 'doubao_search' && item.query !== null
    ? purposes.get(item.query) ?? null
    : null;
}

function qccPriority(item: ResearchItem): number {
  if (qccTool(item, 'get_recruitment_info')) return 0;
  if (qccTool(item, 'get_bidding_info')) return 1;
  if (item.sourceKind === 'ipr') return 2;
  if (item.sourceKind === 'risk') return 3;
  if (qccTool(item, 'get_company_profile')) return 9;
  return 5;
}

const SEARCH_PRIORITY: Readonly<Record<SearchQuery['purpose'], number>> = {
  procurement: 0,
  recruitment: 1,
  engineering: 2,
  software_ecosystem: 3,
  official_products: 4,
  expansion_financing: 5,
  quality: 6,
};

function stableSort<T>(values: readonly T[], priority: (value: T) => number): T[] {
  return values
    .map((value, index) => ({ value, index, priority: priority(value) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(entry => entry.value);
}

function selectItems(bundle: ResearchBundle): ResearchItem[] {
  const purposes = purposeByQuery(bundle);
  const unique = bundle.items.filter((item, index, items) => (
    items.findIndex(candidate => candidate.evidenceId === item.evidenceId) === index
  ));
  const financing = unique.find(item => qccTool(item, 'get_financing_records'));
  const used = new Set<string>(financing === undefined ? [] : [financing.evidenceId]);
  const qcc = stableSort(
    unique.filter(item => item.source === 'qcc' && !used.has(item.evidenceId)),
    qccPriority,
  );
  const search = stableSort(
    unique.filter(item => item.source === 'doubao_search' && !used.has(item.evidenceId)),
    item => {
      const purpose = searchPurpose(item, purposes);
      return purpose === null ? 8 : SEARCH_PRIORITY[purpose];
    },
  );
  const selected = financing === undefined ? [] : [financing];
  const sourceOrder: ResearchItem['source'][] = financing === undefined
    ? ['qcc', 'doubao_search', 'qcc', 'doubao_search']
    : ['doubao_search', 'qcc', 'doubao_search'];

  for (const source of sourceOrder) {
    if (selected.length >= MAX_ITEMS) break;
    const pool = source === 'qcc' ? qcc : search;
    const next = pool.find(item => !used.has(item.evidenceId));
    if (next === undefined) continue;
    selected.push(next);
    used.add(next.evidenceId);
  }

  const fallback = stableSort(
    unique.filter(item => !used.has(item.evidenceId)),
    item => item.source === 'qcc'
      ? qccPriority(item) * 2
      : ((searchPurpose(item, purposes) === null ? 8 : SEARCH_PRIORITY[searchPurpose(item, purposes)!]) * 2 + 1),
  );
  for (const item of fallback) {
    if (selected.length >= MAX_ITEMS) break;
    selected.push(item);
    used.add(item.evidenceId);
  }
  return selected;
}

function isDemandItem(item: ResearchItem, purposes: ReadonlyMap<string, SearchQuery['purpose']>): boolean {
  if (qccTool(item, 'get_financing_records')
    || qccTool(item, 'get_recruitment_info')
    || qccTool(item, 'get_bidding_info')) return true;
  const purpose = searchPurpose(item, purposes);
  return purpose === 'procurement'
    || purpose === 'recruitment'
    || purpose === 'engineering'
    || purpose === 'software_ecosystem';
}

function buildState(
  item: ResearchItem,
  purposes: ReadonlyMap<string, SearchQuery['purpose']>,
): ItemState {
  const preserveFinancingContent = qccTool(item, 'get_financing_records');
  const preferredContentBytes = isDemandItem(item, purposes)
    ? INITIAL_DEMAND_CONTENT_BYTES
    : INITIAL_SUPPORT_CONTENT_BYTES;
  const compactedFinancingContent = preserveFinancingContent ? financingContent(item.content) : item.content;
  return {
    original: item,
    item: {
      ...item,
      content: compactedFinancingContent,
    },
    contentBudget: compactedFinancingContent === null ? 0 : utf8Bytes(compactedFinancingContent),
    summaryBudget: item.summary === null ? 0 : utf8Bytes(item.summary),
    preferredContentBytes,
    preserveFinancingContent,
  };
}

function bundleBytes(bundle: ResearchBundle): number {
  return utf8Bytes(JSON.stringify(bundle));
}

function materialize(bundle: ResearchBundle, states: readonly ItemState[], includeCapacityGap: boolean): ResearchBundle {
  return ResearchBundleSchema.parse({
    ...bundle,
    items: states.map(state => state.item),
    gaps: includeCapacityGap
      ? [...new Set([...bundle.gaps, ARK_INPUT_BUDGET_GAP])]
      : bundle.gaps,
  });
}

function shrinkContent(state: ItemState): boolean {
  if (state.preserveFinancingContent || state.original.content === null || state.contentBudget <= 0) return false;
  state.contentBudget = state.contentBudget > state.preferredContentBytes
    ? state.preferredContentBytes
    : Math.max(0, state.contentBudget - SHRINK_STEP_BYTES);
  state.item = {
    ...state.item,
    content: evidenceExcerpt(state.original.content, state.contentBudget),
  };
  return true;
}

function shrinkSummary(state: ItemState): boolean {
  if (state.original.summary === null || state.summaryBudget <= 0) return false;
  state.summaryBudget = state.summaryBudget > INITIAL_SUMMARY_BYTES
    ? INITIAL_SUMMARY_BYTES
    : Math.max(0, state.summaryBudget - SHRINK_STEP_BYTES);
  state.item = {
    ...state.item,
    summary: evidenceExcerpt(state.original.summary, state.summaryBudget),
  };
  return true;
}

export function compactResearchBundleForArk(bundleInput: ResearchBundle): ResearchBundle {
  const bundle = ResearchBundleSchema.parse(bundleInput);
  const purposes = purposeByQuery(bundle);
  const uniqueCount = new Set(bundle.items.map(item => item.evidenceId)).size;
  const states = selectItems(bundle).map(item => buildState(item, purposes));
  let capacityChanged = uniqueCount > states.length || states.some(state => (
    state.item.summary !== state.original.summary || state.item.content !== state.original.content
  ));
  let compact = materialize(bundle, states, capacityChanged);

  while (bundleBytes(compact) > ARK_COMPACT_BUNDLE_MAX_BYTES) {
    let shrunk = false;
    for (let index = states.length - 1; index >= 0; index -= 1) {
      if (shrinkContent(states[index]!)) {
        shrunk = true;
        capacityChanged = true;
        break;
      }
    }
    if (!shrunk) {
      for (let index = states.length - 1; index >= 0; index -= 1) {
        if (shrinkSummary(states[index]!)) {
          shrunk = true;
          capacityChanged = true;
          break;
        }
      }
    }
    if (!shrunk && states.length > 1) {
      states.pop();
      capacityChanged = true;
      shrunk = true;
    }
    if (!shrunk) {
      throw new RangeError('Ark compact ResearchBundle exceeds the immutable provenance byte budget');
    }
    compact = materialize(bundle, states, capacityChanged);
  }

  return compact;
}
