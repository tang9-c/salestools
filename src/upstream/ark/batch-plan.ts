import {
  ResearchBundleSchema,
  type ResearchBundle,
  type ResearchItem,
} from '../../contracts/index.js';
import {
  arkInputBudgetGap,
  compactResearchBundleForArk,
  type ArkPayloadSelection,
} from './payload-budget.js';

export interface ArkPlannedBatch {
  readonly bundle: ResearchBundle;
  readonly selection: ArkPayloadSelection;
  readonly requestBytes: number;
}

export interface ArkBatchPlan {
  readonly batches: readonly ArkPlannedBatch[];
  readonly originalCount: number;
  readonly candidateCount: number;
  readonly deduplicatedCount: number;
  readonly unplannedItems: readonly ResearchItem[];
}

function normalizedWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function richness(item: ResearchItem): number {
  return Buffer.byteLength([
    item.title,
    item.summary ?? '',
    item.content ?? '',
  ].join('\n'), 'utf8');
}

function deduplicate(items: readonly ResearchItem[]): ResearchItem[] {
  const candidates: ResearchItem[] = [];
  const evidenceIds = new Set<string>();
  const webUrlIndexes = new Map<string, number>();

  for (const item of items) {
    if (evidenceIds.has(item.evidenceId)) continue;
    evidenceIds.add(item.evidenceId);

    const normalizedUrl = item.source === 'doubao_search' && item.url !== null
      ? normalizedWebUrl(item.url)
      : null;
    if (normalizedUrl === null) {
      candidates.push(item);
      continue;
    }

    const existingIndex = webUrlIndexes.get(normalizedUrl);
    if (existingIndex === undefined) {
      webUrlIndexes.set(normalizedUrl, candidates.length);
      candidates.push(item);
      continue;
    }
    if (richness(item) > richness(candidates[existingIndex]!)) {
      candidates[existingIndex] = item;
    }
  }
  return candidates;
}

function withoutBatchCapacityGap(bundle: ResearchBundle, selectedCount: number, originalCount: number): ResearchBundle {
  const generatedGap = arkInputBudgetGap(selectedCount, originalCount);
  return ResearchBundleSchema.parse({
    ...bundle,
    gaps: bundle.gaps.filter(gap => gap !== generatedGap),
  });
}

export function planArkBatches(
  bundleInput: ResearchBundle,
  requestMaxBytes: number,
  measureBytes: (bundle: ResearchBundle) => number,
): ArkBatchPlan {
  const bundle = ResearchBundleSchema.parse(bundleInput);
  const planningBundle = ResearchBundleSchema.parse({ ...bundle, gaps: [] });
  const candidates = deduplicate(planningBundle.items);
  let remaining = [...candidates];
  const batches: ArkPlannedBatch[] = [];
  const unplannedItems: ResearchItem[] = [];

  if (remaining.length === 0) {
    const selection = compactResearchBundleForArk(planningBundle, requestMaxBytes, measureBytes);
    batches.push({ bundle: selection.bundle, selection, requestBytes: measureBytes(selection.bundle) });
  }

  while (remaining.length > 0) {
    const remainingBundle = ResearchBundleSchema.parse({ ...planningBundle, items: remaining });
    const compacted = compactResearchBundleForArk(
      remainingBundle,
      requestMaxBytes,
      measureBytes,
    );
    if (compacted.bundle.items.length === 0) {
      unplannedItems.push(remaining.shift()!);
      continue;
    }

    const batchBundle = withoutBatchCapacityGap(
      compacted.bundle,
      compacted.selectedCount,
      compacted.originalCount,
    );
    const requestBytes = measureBytes(batchBundle);
    const selection: ArkPayloadSelection = {
      ...compacted,
      bundle: batchBundle,
      researchBytes: Buffer.byteLength(JSON.stringify(batchBundle), 'utf8'),
    };
    batches.push({ bundle: batchBundle, selection, requestBytes });

    const selectedIds = new Set(batchBundle.items.map(item => item.evidenceId));
    remaining = remaining.filter(item => !selectedIds.has(item.evidenceId));
  }

  unplannedItems.push(...remaining);
  return {
    batches,
    originalCount: bundle.items.length,
    candidateCount: candidates.length,
    deduplicatedCount: bundle.items.length - candidates.length,
    unplannedItems,
  };
}
