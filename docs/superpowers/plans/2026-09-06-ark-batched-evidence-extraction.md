# Ark Batched Evidence Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Process all eligible QCC and Doubao evidence through byte-bounded Ark batches, merge validated facts deterministically, and report partial batch failures without silently discarding evidence.

**Architecture:** Add a pure byte-aware batch planner around the existing single-request compactor, then let `AssessmentRunner` execute each prepared batch with the existing retry policy. Merge successful `EvidenceBundle` values locally through a provenance-preserving module; scoring and Markdown continue to consume one merged bundle.

**Tech Stack:** Node.js 24, TypeScript 7, Zod 4, Vitest 3, existing Ark chat-completions client and SQLite JSON audit storage.

**Spec:** `docs/superpowers/specs/2026-09-06-ark-batched-evidence-extraction-design.md`

## Global Constraints

- Every serialized Ark request remains at or below `ARK_REQUEST_MAX_BYTES`, default `12_288`.
- Add only `MAX_ARK_BATCHES`, default `8`; reuse the existing one-retry policy.
- Default `MAX_ARK_CALLS=16` and `MAX_TOTAL_UPSTREAM_CALLS=32` so eight retryable batches can each receive one retry.
- One failed Ark batch does not fail the assessment when another batch succeeds; all Ark batches failing does.
- No new database table, worker, queue, final LLM merge, raw-response storage, or MCP top-level field.
- Historical `result_json` without batch audit fields remains readable.
- Industry labels remain display-only and do not affect opportunity evaluation.
- Production code is written only after the corresponding test has failed for the expected missing behavior.

---

### Task 1: Configuration and backward-compatible batch audit

**Files:**
- Modify: `.env.example`
- Modify: `src/config.ts`
- Modify: `src/contracts/result-audit.ts`
- Modify: `src/logging/logger.ts`
- Modify: `src/index.ts`
- Test: `tests/config.test.ts`
- Test: `tests/contracts.test.ts`
- Test: `tests/logging.test.ts`

**Interfaces:**
- Produces: `AppConfig.maxArkBatches: number`.
- Produces optional/defaulted `EvidenceSelectionAudit` fields: `batchCount`, `successfulBatchCount`, `failedBatchCount`, `processedCount`, `unprocessedCount`, `deduplicatedCount`.
- Produces: optional `batchIndex` on `UpstreamAttemptLog`, rendered as `batch_index` only for batched Ark calls.

- [ ] **Step 1: Write failing configuration tests**

Update the default assertion in `tests/config.test.ts` and add budget validation:

```ts
expect(loadConfig(valid as NodeJS.ProcessEnv)).toMatchObject({
  maxArkBatches: 8,
  maxArkCalls: 16,
  maxTotalUpstreamCalls: 32,
});

expect(() => loadConfig({
  ...valid,
  MAX_QCC_CALLS: '8',
  MAX_SEARCH_CALLS: '8',
  MAX_ARK_CALLS: '16',
  MAX_TOTAL_UPSTREAM_CALLS: '31',
} as NodeJS.ProcessEnv)).toThrow('Invalid configuration: MAX_TOTAL_UPSTREAM_CALLS');
```

- [ ] **Step 2: Write failing audit compatibility and logging tests**

In `tests/contracts.test.ts`, prove an old audit parses with zero-valued defaults and a new audit enforces consistent counts:

```ts
const historical = AssessmentResultAuditSchema.parse(resultAudit);
expect(historical.evidenceSelection).toMatchObject({
  batchCount: 1,
  successfulBatchCount: 1,
  failedBatchCount: 0,
  processedCount: historical.evidenceSelection.selectedCount,
  unprocessedCount: 0,
  deduplicatedCount: 0,
});
```

Add a `tests/logging.test.ts` assertion that an Ark attempt with `batchIndex: 2` emits `"batch_index":2` and does not log content.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
rtk npm test -- --run tests/config.test.ts tests/contracts.test.ts tests/logging.test.ts
```

Expected: FAIL because `MAX_ARK_BATCHES`, batch audit fields, and `batchIndex` do not exist.

- [ ] **Step 4: Implement the minimal configuration and schemas**

Add `MAX_ARK_BATCHES` to `CONFIG_KEYS` and the Zod config object, expose `maxArkBatches`, update defaults, and validate:

```ts
if (config.MAX_TOTAL_UPSTREAM_CALLS
    < config.MAX_QCC_CALLS + config.MAX_SEARCH_CALLS + config.MAX_ARK_CALLS) {
  context.addIssue({
    code: 'custom',
    path: ['MAX_TOTAL_UPSTREAM_CALLS'],
    message: 'total upstream calls must cover configured source budgets',
  });
}
```

Extend `EvidenceSelectionAuditSchema` with optional input fields, then transform omitted historical values from existing counts:

```ts
batchCount: z.number().int().nonnegative().optional(),
successfulBatchCount: z.number().int().nonnegative().optional(),
failedBatchCount: z.number().int().nonnegative().optional(),
processedCount: z.number().int().nonnegative().optional(),
unprocessedCount: z.number().int().nonnegative().optional(),
deduplicatedCount: z.number().int().nonnegative().optional(),
```

Transform historical input before refinement:

```ts
const normalized = {
  ...selection,
  batchCount: selection.batchCount ?? 1,
  successfulBatchCount: selection.successfulBatchCount ?? 1,
  failedBatchCount: selection.failedBatchCount ?? 0,
  processedCount: selection.processedCount ?? selection.selectedCount,
  unprocessedCount: selection.unprocessedCount ?? selection.excludedCount,
  deduplicatedCount: selection.deduplicatedCount ?? 0,
};
```

Then require:

```ts
successfulBatchCount + failedBatchCount === batchCount
processedCount + unprocessedCount + deduplicatedCount === originalCount
processedCount <= selectedCount
```

Add `batchIndex?: number` to logging input and conditionally render it. Pass `maxArkBatches` from `createApplication` into `AssessmentRunner`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same focused command. Expected: all selected tests PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add .env.example src/config.ts src/contracts/result-audit.ts src/logging/logger.ts src/index.ts tests/config.test.ts tests/contracts.test.ts tests/logging.test.ts
rtk git commit -m "feat: configure ark evidence batches"
```

---

### Task 2: Deterministic URL deduplication and byte-bounded batch planning

**Files:**
- Create: `src/upstream/ark/batch-plan.ts`
- Modify: `src/upstream/ark/client.ts`
- Modify: `src/upstream/ark/payload-budget.ts`
- Test: `tests/ark-batch-plan.test.ts`
- Test: `tests/ark-adapter.test.ts`

**Interfaces:**
- Consumes: `compactResearchBundleForArk(bundle, requestMaxBytes, measureBytes)`.
- Produces:

```ts
export interface ArkBatchPlan {
  readonly batches: readonly ArkPlannedBatch[];
  readonly originalCount: number;
  readonly candidateCount: number;
  readonly deduplicatedCount: number;
  readonly unplannedItems: readonly ResearchItem[];
}

export interface ArkPlannedBatch {
  readonly bundle: ResearchBundle;
  readonly selection: ArkPayloadSelection;
  readonly requestBytes: number;
}

export function planArkBatches(
  bundle: ResearchBundle,
  maxBatches: number,
  requestMaxBytes: number,
  measureBytes: (bundle: ResearchBundle) => number,
): ArkBatchPlan;
```

- Produces: `ArkEvidenceService.planBatches(bundle, maxBatches): ArkBatchPlan` using the real serialized request envelope for `measureBytes`.

- [ ] **Step 1: Write failing deduplication tests**

Create `tests/ark-batch-plan.test.ts` with real `ResearchBundle` objects. Assert:

```ts
const plan = planArkBatches(bundleWithDuplicateSearchUrls(), 8, 12_288, serializedBytes);
expect(plan.originalCount).toBe(4);
expect(plan.candidateCount).toBe(3);
expect(plan.deduplicatedCount).toBe(1);
expect(plan.batches.flatMap(batch => batch.bundle.items)).toContainEqual(
  expect.objectContaining({ evidenceId: 'same-url-with-longer-content' }),
);
expect(plan.batches.flatMap(batch => batch.bundle.items).filter(item => item.source === 'qcc')).toHaveLength(2);
```

Use URL normalization that drops fragments, lowercases the host, removes the default port, and preserves path/query. Same-domain different paths must not deduplicate.

- [ ] **Step 2: Write failing multi-batch and no-progress tests**

Generate 92 compact evidence items and assert:

```ts
const plan = planArkBatches(ninetyTwoItems, 8, 12_288, serializedBytes);
expect(plan.batches.length).toBeGreaterThan(1);
expect(plan.batches.length).toBeLessThanOrEqual(8);
expect(new Set([
  ...plan.batches.flatMap(batch => batch.bundle.items.map(item => item.evidenceId)),
  ...plan.unplannedItems.map(item => item.evidenceId),
]).size).toBe(plan.candidateCount);
for (const batch of plan.batches) {
  expect(serializedBytes(batch.bundle)).toBe(batch.requestBytes);
  expect(batch.requestBytes).toBeLessThanOrEqual(12_288);
}
```

Add one item whose immutable metadata cannot fit and assert it appears exactly once in `unplannedItems`; planning terminates without producing an empty batch.

- [ ] **Step 3: Run the new test and verify RED**

Run:

```bash
rtk npm test -- --run tests/ark-batch-plan.test.ts
```

Expected: FAIL because `batch-plan.ts` and `planArkBatches` do not exist.

- [ ] **Step 4: Implement URL deduplication**

In `batch-plan.ts`, deduplicate `evidenceId` first. For Doubao items sharing a normalized URL, rank by:

```ts
const informationBytes = Buffer.byteLength(
  [item.content ?? '', item.summary ?? '', item.title].join('\n'),
  'utf8',
);
```

Keep the larger value; break ties by original order. Never URL-deduplicate QCC items or items with `url=null`.

- [ ] **Step 5: Implement iterative byte planning**

Repeatedly call the existing compactor on the remaining candidates. Strip only the generated `arkInputBudgetGap()` from each outgoing batch; preserve trusted source gaps. Remove selected IDs from the remaining set. If no IDs are selected, move the first remaining item to `unplannedItems` and continue. Stop after `maxBatches`; append all remaining candidates to `unplannedItems`.

Special case an empty input as one empty batch so the existing fact-free report path remains intact.

- [ ] **Step 6: Expose real-envelope planning from the Ark client**

Add:

```ts
planBatches(bundle: ResearchBundle, maxBatches: number): ArkBatchPlan {
  return planArkBatches(
    bundle,
    maxBatches,
    this.options.requestMaxBytes ?? ARK_REQUEST_MAX_BYTES,
    candidate => Buffer.byteLength(serializeArkRequest(this.options.model, candidate), 'utf8'),
  );
}
```

Add an adapter test proving every planned batch remains under the limit for a long model name.

- [ ] **Step 7: Run tests and verify GREEN**

```bash
rtk npm test -- --run tests/ark-batch-plan.test.ts tests/ark-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add src/upstream/ark/batch-plan.ts src/upstream/ark/client.ts src/upstream/ark/payload-budget.ts tests/ark-batch-plan.test.ts tests/ark-adapter.test.ts
rtk git commit -m "feat: plan byte bounded ark batches"
```

---

### Task 3: Provenance-safe evidence merging and material status resolution

**Files:**
- Create: `src/upstream/ark/merge-evidence.ts`
- Test: `tests/ark-evidence-merge.test.ts`

**Interfaces:**
- Consumes successful batch pairs and item outcomes:

```ts
export interface SuccessfulArkBatch {
  readonly input: ResearchBundle;
  readonly evidence: EvidenceBundle;
}

export interface ArkMergeInput {
  readonly original: ResearchBundle;
  readonly successful: readonly SuccessfulArkBatch[];
  readonly failedEvidenceIds: readonly string[];
  readonly unplannedEvidenceIds: readonly string[];
}

export function mergeArkEvidence(input: ArkMergeInput): EvidenceBundle;
```

- Produces one `EvidenceBundle` that passes `EvidenceBundleSchema` and `validateEvidenceProvenance(original, merged)`.

- [ ] **Step 1: Write failing merge tests**

Create tests proving:

```ts
expect(merged.evidence.map(item => item.evidenceId)).toEqual(['e-1', 'e-2']);
expect(merged.facts[0]?.evidenceIds).toEqual(['e-1', 'e-2']);
expect(merged.facts[0]?.strength).toBe('direct');
```

The two facts may merge only when normalized statement, kind, sorted product tags, strength, entity scope, entity match, and match basis are equal. Add a negative test in which `supporting` and `direct` remain separate.

- [ ] **Step 2: Write failing financing and industry tests**

Assert identical financing summaries merge evidence IDs; distinct summaries remain separate. Assert the first confirmed industry label wins and a later different label adds:

```text
多批次行业标签冲突：机器人仓储设备 / 智能物流装备
```

The winning `industryEvidenceIds` must remain attached to its own label.

- [ ] **Step 3: Write failing material-state tests**

Use material items whose content is `{"material":"..."}` and verify:

- a successful cited item has no “待模型整理” gap;
- a successful uncited item receives `模型未从该材料提炼出可采信事实：<evidenceId>`;
- a failed item receives `材料未完成模型整理（批次失败）：<evidenceId>`;
- an unplanned item receives `材料未完成模型整理（容量上限）：<evidenceId>`;
- QCC unavailable-link gaps remain unchanged.

- [ ] **Step 4: Run tests and verify RED**

```bash
rtk npm test -- --run tests/ark-evidence-merge.test.ts
```

Expected: FAIL because the merge module does not exist.

- [ ] **Step 5: Implement deterministic merge**

Implement stable ordered maps for evidence, facts, financing, conflicts, and gaps. A referenced material ID is any ID appearing in `industryEvidenceIds`, fact `evidenceIds`, or financing `evidenceIds`. Remove only these transient input messages:

```ts
const TRANSIENT_MATERIAL_GAP = /^(?:招聘使用非结构化材料整理|.+使用非结构化材料，待模型整理)$/u;
```

Never merge facts with different attribution or strength, and never manufacture evidence references for uncited input items.

- [ ] **Step 6: Validate the merged bundle against original provenance**

Finish `mergeArkEvidence` with:

```ts
const merged = EvidenceBundleSchema.parse(candidate);
return validateEvidenceProvenance(input.original, merged);
```

- [ ] **Step 7: Run tests and verify GREEN**

Run the focused merge test. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add src/upstream/ark/merge-evidence.ts tests/ark-evidence-merge.test.ts
rtk git commit -m "feat: merge ark evidence batches"
```

---

### Task 4: Execute batches in AssessmentRunner with partial-failure degradation

**Files:**
- Modify: `src/orchestration/assessment-runner.ts`
- Modify: `src/upstream/ark/client.ts`
- Modify: `src/index.ts`
- Test: `tests/assessment-runner.test.ts`
- Test: `tests/mcp-e2e.test.ts`

**Interfaces:**
- Consumes: `ark.planBatches(research, maxArkBatches)` and existing `ark.extractWithAudit(batch)`.
- Consumes: `mergeArkEvidence(...)`.
- Produces: completed reports with Ark source status `completed|partial`, or failed assessment when no Ark batch succeeds.

- [ ] **Step 1: Update test doubles and write failing all-success test**

Extend the runner test Ark double with `planBatches`. Prepare three batches and assert all three are passed to `extractWithAudit` and their facts appear in the opportunity evaluator input.

Assert audit output:

```ts
expect(stored.resultAudit?.evidenceSelection).toMatchObject({
  batchCount: 3,
  successfulBatchCount: 3,
  failedBatchCount: 0,
  processedCount: 6,
  unprocessedCount: 0,
});
expect(stored.sourceStatus?.ark).toBe('completed');
```

- [ ] **Step 2: Write failing partial and total failure tests**

For three planned batches, throw retryable `NETWORK_ERROR` twice for batch 2. Assert batches 1 and 3 still run, assessment completes, Ark is `partial`, and the report contains the failed-batch gap.

Then make every batch fail and assert assessment status is `failed` with `模型事实整理不可用`.

- [ ] **Step 3: Write failing budget and empty-input tests**

Assert a batch that receives `BUDGET_EXHAUSTED` is counted as failed/unprocessed without retrying unrelated completed batches. Preserve the current empty ResearchBundle behavior as one Ark call and a completed unverified report.

- [ ] **Step 4: Run focused runner tests and verify RED**

```bash
rtk npm test -- --run tests/assessment-runner.test.ts tests/mcp-e2e.test.ts
```

Expected: FAIL because `AssessmentRunner` calls Ark only once and has no batch plan.

- [ ] **Step 5: Implement sequential batch execution**

Add `maxArkBatches` to `AssessmentRunnerOptions`. Replace the single Ark call with:

```ts
const plan = this.options.ark.planBatches(research, this.options.maxArkBatches);
const successful: SuccessfulArkBatch[] = [];
const failedEvidenceIds: string[] = [];

for (const [index, batch] of plan.batches.entries()) {
  const result = await retryOnce(
    'ark',
    budget,
    () => this.options.ark.extractWithAudit(batch.bundle),
    this.retryOptions(task, index + 1),
  );
  if (result.status === 'completed') successful.push({ input: batch.bundle, evidence: result.value.evidence });
  else failedEvidenceIds.push(...batch.bundle.items.map(item => item.evidenceId));
}
```

Keep execution sequential in v0.1 to avoid changing concurrency or rate behavior.

- [ ] **Step 6: Merge results and build aggregate audit**

If `successful.length === 0`, fail the task. Otherwise call `mergeArkEvidence`, evaluate opportunities once, and set Ark status to `partial` when any batch failed or `plan.unplannedItems` is non-empty.

Aggregate selected IDs, category counts, research bytes, and request bytes from the planned batch metadata in stable order, including failed batches. `processedCount` counts unique items in successful batches; `unprocessedCount` counts failed-batch plus unplanned candidates; `deduplicatedCount` comes from the plan. Add `Ark 批次处理失败：F/B` when `F>0` and `Ark 容量上限未处理证据：N` when unplanned evidence remains.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the focused runner tests. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add src/orchestration/assessment-runner.ts src/upstream/ark/client.ts src/index.ts tests/assessment-runner.test.ts tests/mcp-e2e.test.ts
rtk git commit -m "feat: extract assessment evidence in ark batches"
```

---

### Task 5: Report wording, operational documentation, and full verification

**Files:**
- Modify: `src/report/build-report-model.ts`
- Modify: `src/report/render-markdown.ts`
- Modify: `tests/report.test.ts`
- Modify: `README.md`
- Modify: `docs/QUICKSTART.md`
- Modify: `docs/validation/real-e2e-result.md`

**Interfaces:**
- Consumes batch gaps and source status produced by Task 4.
- Produces Markdown that distinguishes successful processing, failed batches, capacity leftovers, and QCC link audit gaps.

- [ ] **Step 1: Write failing report tests**

Add assertions that:

- transient “待模型整理” text never appears after a successful cited material;
- `模型未从该材料提炼出可采信事实` is a rating/enhancement gap rather than a source-link audit gap;
- batch failure and capacity leftovers show exact counts;
- QCC missing direct links remain under “审计缺口” and do not appear in core opportunity reasons.

- [ ] **Step 2: Run report tests and verify RED**

```bash
rtk npm test -- --run tests/report.test.ts
```

Expected: FAIL on current gap wording/classification.

- [ ] **Step 3: Implement minimal report wording and classification**

Update `classifyReportGap` patterns so batch transport/capacity diagnostics are audit gaps, while “模型未提炼出可采信事实” remains a rating gap. Do not add a new Markdown section or MCP response field.

- [ ] **Step 4: Update environment and operating documentation**

Document:

```ini
MAX_ARK_BATCHES=8
MAX_ARK_CALLS=16
MAX_TOTAL_UPSTREAM_CALLS=32
```

Explain that `MAX_ARK_CALLS` counts attempts, not batches, and lowering it can intentionally produce an Ark `partial` report.

- [ ] **Step 5: Run the complete automated verification**

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
```

Expected: all tests PASS and every command exits 0.

- [ ] **Step 6: Commit automated changes**

```bash
rtk git add src/report/build-report-model.ts src/report/render-markdown.ts tests/report.test.ts README.md docs/QUICKSTART.md .env.example
rtk git commit -m "docs: explain ark batch processing"
```

- [ ] **Step 7: Run one authorized real assessment**

Use `广东安达智能装备股份有限公司` with credit code `91441900673133772K`, a fresh temporary SQLite database, local HTTP plus real upstream credentials, and one formal assessment. Do not print or commit credentials or raw upstream responses.

Record only:

- elapsed time;
- QCC, Doubao and Ark statuses;
- original, deduplicated, processed and unprocessed evidence counts;
- planned, successful and failed batch counts;
- whether every request stayed within the configured byte limit;
- whether evidence from more than the first batch reached the merged opportunity input;
- whether transient “待模型整理” wording was resolved accurately.

- [ ] **Step 8: Update validation record and commit**

Append the dated, sanitized result to `docs/validation/real-e2e-result.md`, then run:

```bash
rtk git add docs/validation/real-e2e-result.md
rtk git commit -m "test: validate batched ark extraction with real data"
```

- [ ] **Step 9: Re-run final verification after the validation commit**

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
rtk git status --short
```

Expected: all automated checks exit 0 and the worktree is clean.
