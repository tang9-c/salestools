import {
  isQccUnavailableLinkAuditGap,
  ResearchBundleSchema,
  type ResearchBundle,
  type ResearchItem,
} from '../../contracts/index.js';
import { buildSearchPlan, type SearchQuery } from '../search/search-plan.js';

export const ARK_HISTORICAL_FINANCING_GAP = '方舟融资专槽有日期时仅保留最新记录、均无日期时按来源顺序保留一条；其他融资记录未送入整理，未选不代表不存在';
export const ARK_COMPACT_BUNDLE_MAX_BYTES = 6_656;
export const ARK_REQUEST_MAX_BYTES = 12_288;

const INITIAL_SUMMARY_BYTES = 512;
const INITIAL_DEMAND_CONTENT_BYTES = 1_536;
const INITIAL_SUPPORT_CONTENT_BYTES = 1_024;
const SHRINK_STEP_BYTES = 256;
const MAX_EXCERPT_WINDOWS = 4;
const MIN_WINDOW_BYTES = 256;

type EvidenceTextCategory = 'financing' | 'procurement' | 'recruitment' | 'technical' | 'support';
export type ArkEvidenceCategory = 'industry' | 'technology' | 'timing' | 'capacity';

export interface ArkPayloadSelection {
  readonly bundle: ResearchBundle;
  readonly originalCount: number;
  readonly selectedCount: number;
  readonly excludedCount: number;
  readonly categoryCounts: Readonly<Record<ArkEvidenceCategory, number>>;
  readonly researchBytes: number;
}

type KeywordRule = {
  readonly pattern: RegExp;
  readonly weight: number;
  readonly categoryBoost?: Partial<Record<EvidenceTextCategory, number>>;
};

const KEYWORD_RULES: readonly KeywordRule[] = [
  {
    pattern: /\b(?:windchill|feigenbaum(?:\s+qms)?|qms|creo|pro\s*\/?\s*e|catia|abaqus|cst(?:\s+studio(?:\s+suite)?)?|solid\s*works|plm|pdm|bom|capa)\b/giu,
    weight: 180,
    categoryBoost: { procurement: 30, recruitment: 30, technical: 40 },
  },
  {
    pattern: /(?:采购意向|计划\s*采购|拟\s*采购|即将\s*采购|有\s*采购需求|存在\s*采购需求|准备\s*采购)/giu,
    weight: 170,
    categoryBoost: { procurement: 60 },
  },
  {
    pattern: /(?:采购公告|招标公告|中标公告|采购文件|采购项目|采购合同)/giu,
    weight: 100,
    categoryBoost: { procurement: 50 },
  },
  {
    pattern: /(?:有限元|非线性|材料失效|参数化|工程变更|配置管理|质量追溯|供应商质量|射频|天线|雷达|微波|电磁|仿真|emc|emi)/giu,
    weight: 120,
    categoryBoost: { recruitment: 30, technical: 60 },
  },
  {
    pattern: /(?:融资|投资方|融资轮次|融资金额|扩产|研发中心建设|数字化项目)/giu,
    weight: 70,
    categoryBoost: { financing: 80 },
  },
  {
    pattern: /(?:招聘|职位|岗位|任职要求|工作职责|招标|中标|公告)/giu,
    weight: 15,
    categoryBoost: { recruitment: 10 },
  },
];

type ScoredWindow = {
  start: number;
  end: number;
  score: number;
  ruleIds: Set<number>;
};

type ItemState = {
  readonly original: ResearchItem;
  item: ResearchItem;
  contentBudget: number;
  summaryBudget: number;
  readonly preferredContentBytes: number;
  readonly preserveFinancingContent: boolean;
  readonly textCategory: EvidenceTextCategory;
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

function evidenceExcerpt(
  value: string,
  maxBytes: number,
  category: EvidenceTextCategory,
): string | null {
  if (maxBytes <= 0) return null;
  if (utf8Bytes(value) <= maxBytes) return value;

  const candidates: ScoredWindow[] = [];
  for (const [ruleId, rule] of KEYWORD_RULES.entries()) {
    for (const match of value.matchAll(rule.pattern)) {
      const index = match.index ?? 0;
      candidates.push({
        start: Math.max(0, index - 48),
        end: Math.min(value.length, index + match[0].length + 180),
        score: rule.weight + (rule.categoryBoost?.[category] ?? 0),
        ruleIds: new Set([ruleId]),
      });
    }
  }
  if (candidates.length === 0) {
    const head = truncateUtf8(value, maxBytes);
    return head.length === 0 ? null : head;
  }

  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  const clustered: ScoredWindow[] = [];
  for (const candidate of candidates) {
    const previous = clustered.at(-1);
    const combinedEnd = previous === undefined ? candidate.end : Math.max(previous.end, candidate.end);
    if (previous !== undefined
      && candidate.start <= previous.end + 24
      && combinedEnd - previous.start <= 360) {
      previous.end = combinedEnd;
      for (const ruleId of candidate.ruleIds) {
        if (!previous.ruleIds.has(ruleId)) {
          previous.score += candidate.score;
          previous.ruleIds.add(ruleId);
        }
      }
      continue;
    }
    clustered.push(candidate);
  }
  clustered.sort((left, right) => right.score - left.score || left.start - right.start);
  const nonOverlappingWindows: ScoredWindow[] = [];
  for (const window of clustered) {
    if (nonOverlappingWindows.every(selected => window.end <= selected.start || window.start >= selected.end)) {
      nonOverlappingWindows.push(window);
    }
  }

  const separator = '\n…\n';
  const windowCount = Math.max(1, Math.min(
    MAX_EXCERPT_WINDOWS,
    Math.floor(maxBytes / MIN_WINDOW_BYTES),
  ));
  const selectedWindows = nonOverlappingWindows.slice(0, windowCount);
  const fragments: string[] = [];
  let usedBytes = 0;
  for (const [index, window] of selectedWindows.entries()) {
    const separatorBytes = fragments.length === 0 ? 0 : utf8Bytes(separator);
    const available = maxBytes - usedBytes - separatorBytes;
    if (available <= 0) break;
    const remainingWindows = selectedWindows.length - index;
    const fragmentBudget = Math.floor(available / remainingWindows);
    const fragment = truncateUtf8(value.slice(window.start, window.end), fragmentBudget);
    if (fragment.length === 0) continue;
    fragments.push(fragment);
    usedBytes += separatorBytes + utf8Bytes(fragment);
  }
  return fragments.length === 0 ? null : fragments.join(separator);
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
    return evidenceExcerpt(value, INITIAL_DEMAND_CONTENT_BYTES, 'financing');
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

function latestFinancing(items: readonly ResearchItem[]): ResearchItem | undefined {
  return items
    .map((item, index) => ({
      item,
      index,
      timestamp: item.publishedAt === null ? null : Date.parse(item.publishedAt),
    }))
    .sort((left, right) => {
      if (left.timestamp === null && right.timestamp !== null) return 1;
      if (left.timestamp !== null && right.timestamp === null) return -1;
      if (left.timestamp !== null && right.timestamp !== null && left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp;
      }
      return left.index - right.index;
    })[0]?.item;
}

function evidenceCategory(
  item: ResearchItem,
  purposes: ReadonlyMap<string, SearchQuery['purpose']>,
): ArkEvidenceCategory | null {
  const purpose = searchPurpose(item, purposes);
  if ((item.source === 'qcc' && item.sourceKind === 'risk')
    || qccTool(item, 'get_financing_records')
    || qccTool(item, 'get_qualifications')
    || qccTool(item, 'get_annual_reports')
    || purpose === 'expansion_financing') return 'capacity';
  if (qccTool(item, 'get_recruitment_info')
    || qccTool(item, 'get_bidding_info')
    || purpose === 'recruitment'
    || purpose === 'procurement') return 'timing';
  if (item.sourceKind === 'ipr'
    || purpose === 'engineering'
    || purpose === 'software_ecosystem'
    || purpose === 'quality') return 'technology';
  if (qccTool(item, 'get_company_profile') || purpose === 'official_products') return 'industry';
  return null;
}

function selectItems(bundle: ResearchBundle): ResearchItem[] {
  const purposes = purposeByQuery(bundle);
  const unique = bundle.items.filter((item, index, items) => (
    items.findIndex(candidate => candidate.evidenceId === item.evidenceId) === index
  ));
  const financingItems = unique.filter(item => qccTool(item, 'get_financing_records'));
  const financing = latestFinancing(financingItems);
  const used = new Set<string>(financingItems.map(item => item.evidenceId));
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
  const candidates = [
    ...(financing === undefined ? [] : [financing]),
    ...qcc,
    ...search,
  ];
  const selected: ResearchItem[] = [];
  const selectedIds = new Set<string>();
  const select = (item: ResearchItem | undefined): void => {
    if (item === undefined || selectedIds.has(item.evidenceId)) return;
    selected.push(item);
    selectedIds.add(item.evidenceId);
  };
  select(financing);
  for (const category of ['industry', 'technology', 'timing', 'capacity'] as const) {
    select(candidates.find(item => evidenceCategory(item, purposes) === category));
  }

  const fallback = stableSort(
    candidates.filter(item => !selectedIds.has(item.evidenceId)),
    item => item.source === 'qcc'
      ? qccPriority(item) * 2
      : ((searchPurpose(item, purposes) === null ? 8 : SEARCH_PRIORITY[searchPurpose(item, purposes)!]) * 2 + 1),
  );
  for (const item of fallback) {
    select(item);
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

function evidenceTextCategory(
  item: ResearchItem,
  purposes: ReadonlyMap<string, SearchQuery['purpose']>,
): EvidenceTextCategory {
  if (qccTool(item, 'get_financing_records')) return 'financing';
  if (qccTool(item, 'get_bidding_info') || searchPurpose(item, purposes) === 'procurement') return 'procurement';
  if (qccTool(item, 'get_recruitment_info') || searchPurpose(item, purposes) === 'recruitment') return 'recruitment';
  const purpose = searchPurpose(item, purposes);
  if (item.sourceKind === 'ipr'
    || purpose === 'engineering'
    || purpose === 'software_ecosystem'
    || purpose === 'official_products') return 'technical';
  return 'support';
}

function buildState(
  item: ResearchItem,
  purposes: ReadonlyMap<string, SearchQuery['purpose']>,
): ItemState {
  const preserveFinancingContent = qccTool(item, 'get_financing_records');
  const textCategory = evidenceTextCategory(item, purposes);
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
    textCategory,
  };
}

function buildUnchangedState(
  item: ResearchItem,
  purposes: ReadonlyMap<string, SearchQuery['purpose']>,
): ItemState {
  const state = buildState(item, purposes);
  return {
    ...state,
    item,
    contentBudget: item.content === null ? 0 : utf8Bytes(item.content),
    summaryBudget: item.summary === null ? 0 : utf8Bytes(item.summary),
  };
}

function bundleBytes(bundle: ResearchBundle): number {
  return utf8Bytes(JSON.stringify(bundle));
}

function materialize(
  bundle: ResearchBundle,
  states: readonly ItemState[],
  capacityGap: string | null,
  includeHistoricalFinancingGap: boolean,
): ResearchBundle {
  return ResearchBundleSchema.parse({
    ...bundle,
    items: states.map(state => state.item),
    gaps: [...new Set([
      ...bundle.gaps.filter(gap => !isQccUnavailableLinkAuditGap(gap)),
      ...(capacityGap === null ? [] : [capacityGap]),
      ...(includeHistoricalFinancingGap ? [ARK_HISTORICAL_FINANCING_GAP] : []),
    ])],
  });
}

export function arkInputBudgetGap(selectedCount: number, originalCount: number): string {
  return `方舟输入受网关容量限制，仅保留 ${selectedCount}/${originalCount} 条代表证据，未选或缩短内容不代表不存在`;
}

function categoryCounts(
  states: readonly ItemState[],
  purposes: ReadonlyMap<string, SearchQuery['purpose']>,
): Record<ArkEvidenceCategory, number> {
  const counts: Record<ArkEvidenceCategory, number> = {
    industry: 0,
    technology: 0,
    timing: 0,
    capacity: 0,
  };
  for (const state of states) {
    const category = evidenceCategory(state.original, purposes);
    if (category !== null) counts[category] += 1;
  }
  return counts;
}

function shrinkContent(state: ItemState): boolean {
  if (state.preserveFinancingContent || state.original.content === null || state.contentBudget <= 0) return false;
  state.contentBudget = state.contentBudget > state.preferredContentBytes
    ? state.preferredContentBytes
    : Math.max(0, state.contentBudget - SHRINK_STEP_BYTES);
  state.item = {
    ...state.item,
    content: evidenceExcerpt(state.original.content, state.contentBudget, state.textCategory),
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
    summary: evidenceExcerpt(state.original.summary, state.summaryBudget, state.textCategory),
  };
  return true;
}

function cloneState(state: ItemState): ItemState {
  return {
    ...state,
    item: { ...state.item },
  };
}

function stateChanged(state: ItemState): boolean {
  return state.item.summary !== state.original.summary
    || state.item.content !== state.original.content;
}

export function compactResearchBundleForArk(
  bundleInput: ResearchBundle,
  requestMaxBytes = ARK_REQUEST_MAX_BYTES,
  measureBytes: (bundle: ResearchBundle) => number = bundleBytes,
): ArkPayloadSelection {
  const bundle = ResearchBundleSchema.parse(bundleInput);
  const purposes = purposeByQuery(bundle);
  const uniqueItems = bundle.items.filter((item, index, items) => (
    items.findIndex(candidate => candidate.evidenceId === item.evidenceId) === index
  ));
  const uniqueCount = uniqueItems.length;
  const result = (states: readonly ItemState[], compact: ResearchBundle): ArkPayloadSelection => ({
    bundle: compact,
    originalCount: uniqueCount,
    selectedCount: states.length,
    excludedCount: uniqueCount - states.length,
    categoryCounts: categoryCounts(states, purposes),
    researchBytes: bundleBytes(compact),
  });

  const allStates = uniqueItems.map(item => buildUnchangedState(item, purposes));
  const allCompact = materialize(bundle, allStates, null, false);
  if (measureBytes(allCompact) <= requestMaxBytes) {
    return result(allStates, allCompact);
  }

  const financingCount = new Set(bundle.items
    .filter(item => qccTool(item, 'get_financing_records'))
    .map(item => item.evidenceId)).size;
  const includeHistoricalFinancingGap = financingCount > 1;
  const orderedItems = selectItems(bundle);
  const compactFor = (states: readonly ItemState[]): ResearchBundle => {
    const capacityChanged = uniqueCount > states.length || states.some(stateChanged);
    return materialize(
      bundle,
      states,
      capacityChanged ? arkInputBudgetGap(states.length, uniqueCount) : null,
      includeHistoricalFinancingGap,
    );
  };

  const fitCandidate = (
    selected: readonly ItemState[],
    item: ResearchItem,
  ): ItemState[] | null => {
    const trial = [...selected.map(cloneState), buildState(item, purposes)];
    while (measureBytes(compactFor(trial)) > requestMaxBytes) {
      let shrunk = false;
      for (let index = trial.length - 1; index >= 0; index -= 1) {
        if (shrinkContent(trial[index]!)) {
          shrunk = true;
          break;
        }
      }
      if (!shrunk) {
        for (let index = trial.length - 1; index >= 0; index -= 1) {
          if (shrinkSummary(trial[index]!)) {
            shrunk = true;
            break;
          }
        }
      }
      if (!shrunk) {
        return null;
      }
    }
    return trial;
  };

  const reservationCategories = ['industry', 'technology', 'timing', 'capacity'] as const;
  const categoryCandidates = reservationCategories.map(category => (
    orderedItems.filter(item => evidenceCategory(item, purposes) === category)
  ));
  let greedyStates: ItemState[] = [];
  const greedyIds = new Set<string>();
  const tryGreedyReservation = (item: ResearchItem | undefined): boolean => {
    if (item === undefined || greedyIds.has(item.evidenceId)) return false;
    const trial = fitCandidate(greedyStates, item);
    if (trial === null) return false;
    greedyStates = trial;
    greedyIds.add(item.evidenceId);
    return true;
  };
  tryGreedyReservation(orderedItems.find(item => qccTool(item, 'get_financing_records')));
  for (const [categoryIndex, category] of reservationCategories.entries()) {
    if (greedyStates.some(state => evidenceCategory(state.original, purposes) === category)) continue;
    for (const item of categoryCandidates[categoryIndex]!) {
      if (tryGreedyReservation(item)) break;
    }
  }

  const greedyCoverage = greedyStates.length;
  const categoryBits: Record<ArkEvidenceCategory, number> = {
    industry: 1,
    technology: 2,
    timing: 4,
    capacity: 8,
  };
  type Reservation = { readonly states: ItemState[]; readonly requestBytes: number };
  const reservations: Array<Reservation | null> = Array.from({ length: 16 }, () => null);
  reservations[0] = { states: [], requestBytes: measureBytes(compactFor([])) };

  // Four category bits yield exactly 16 states. Each candidate transitions a snapshot of those
  // masks once, so reservation work is O(candidate count * 16), never a Cartesian product.
  for (const item of orderedItems) {
    const category = evidenceCategory(item, purposes);
    if (category === null) continue;
    const bit = categoryBits[category];
    const previous = reservations.slice();
    for (let mask = 0; mask < previous.length; mask += 1) {
      const reservation = previous[mask];
      if (reservation === null || (mask & bit) !== 0) continue;
      const trial = fitCandidate(reservation.states, item);
      if (trial === null) continue;
      const requestBytes = measureBytes(compactFor(trial));
      const nextMask = mask | bit;
      const current = reservations[nextMask];
      if (current === null || requestBytes < current.requestBytes) {
        reservations[nextMask] = { states: trial, requestBytes };
      }
    }
  }

  const coverage = (mask: number): number => reservationCategories.reduce(
    (count, _category, index) => count + ((mask & (1 << index)) === 0 ? 0 : 1),
    0,
  );
  let bestMask = 0;
  // Ascending masks make equal-coverage category ties follow the fixed bit/category order above.
  for (let mask = 1; mask < reservations.length; mask += 1) {
    if (reservations[mask] !== null && coverage(mask) > coverage(bestMask)) bestMask = mask;
  }
  const bestReservation = reservations[bestMask];
  let states = coverage(bestMask) > greedyCoverage && bestReservation !== null
    ? bestReservation.states.map(cloneState)
    : greedyStates;
  const selectedIds = new Set(states.map(state => state.original.evidenceId));
  for (const item of orderedItems) {
    if (selectedIds.has(item.evidenceId)) continue;
    const trial = fitCandidate(states, item);
    if (trial === null) continue;
    states = trial;
    selectedIds.add(item.evidenceId);
  }

  const compact = compactFor(states);
  if (measureBytes(compact) > requestMaxBytes) {
    throw new RangeError('Ark compact ResearchBundle exceeds the immutable provenance byte budget');
  }
  return result(states, compact);
}
