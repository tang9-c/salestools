# Free-Form Industry Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the runtime P1/P2 industry enum and keyword classifier with one evidence-backed nullable free-text industry label that never affects product opportunity decisions.

**Architecture:** Ark produces `industryLabel` and `industryEvidenceIds` from selected research evidence. Contract and provenance validation enforce null/evidence consistency and confirmed legal-entity attribution; the report and audit layers only display or record the label, while the opportunity engine ignores it. A startup data migration normalizes legacy `result_json` without rewriting historical Markdown reports.

**Tech Stack:** Node.js 24+, TypeScript 7, Zod 4, official MCP SDK, Node `DatabaseSync` SQLite, Vitest 3.

## Global Constraints

- Remove `P1`, `P2`, `non_target`, and `unverified` from all new runtime industry data.
- Use `industryLabel: string | null` and `industryEvidenceIds: string[]` as the only runtime industry fields.
- A non-null label is trimmed and 2–40 characters long and cites at least one confirmed legal-entity evidence reference.
- A null label requires an empty `industryEvidenceIds`; insufficient or conflicting evidence produces `null`.
- Industry labels are descriptive only and never change opportunity level, recommended product, or confidence.
- Do not add an industry taxonomy, configurable priority list, dual-write compatibility field, MCP tool, or SQLite column.
- Historical Markdown remains unchanged; legacy `result_json` is normalized once at startup.
- Preserve all existing subject-attribution, evidence-link, unsupported-inference, call-budget, and failure-degradation behavior.

---

## File Structure

- `src/contracts/evidence.ts`: defines the nullable label and EvidenceBundle consistency rule.
- `src/contracts/result-audit.ts`: records the nullable label in persisted audit JSON.
- `src/contracts/report.ts`: exposes the nullable label to the Markdown renderer.
- `src/db/database.ts`: migrates legacy audit JSON at startup.
- `src/upstream/ark/prompt.ts`: asks Ark for one evidence-backed free-text label.
- `src/upstream/ark/evidence-validator.ts`: enforces industry provenance and target-subject attribution.
- `src/orchestration/assessment-runner.ts`: removes keyword supplementation and writes the label to audit output.
- `src/report/build-report-model.ts`: carries the label without creating opportunity gaps.
- `src/report/render-markdown.ts`: renders `行业：<label>` or `行业：待核实`.
- `src/logging/logger.ts`: emits `industry_label` instead of `industry_classification`.
- `src/industry/classify-industry.ts`: deleted; no replacement classifier is created.
- `tests/industry-classification.test.ts`: deleted; behavior is replaced by contract, Ark, report, and opportunity tests.

---

### Task 1: Normalize Historical Assessment Audit JSON

**Files:**
- Modify: `src/db/database.ts`
- Modify: `tests/db.test.ts`

**Interfaces:**
- Consumes: rows in `assessments(assessment_id, result_json)` created by the current release.
- Produces: `migrateLegacyIndustryAudits(database: DatabaseSync): void`, invoked by `initializeDatabase` after the `result_json` column exists.

- [ ] **Step 1: Write the failing migration tests**

Add tests that insert one legacy audit and one new audit before calling the migration through `initializeDatabase`:

```ts
it('normalizes legacy industry classification audit JSON without changing report markdown', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA_SQL);
  const legacy = {
    industryClassification: 'P1',
    industryEvidenceIds: ['industry-source'],
    evidenceSelection: selectionAudit,
    opportunities: opportunityAudits,
  };
  database.prepare(`INSERT INTO assessments (
    assessment_id, cache_key, requested_by, legal_name, credit_code,
    status, report_markdown, result_json, created_at
  ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`)
    .run('legacy', 'legacy-key', 'tester', '历史公司', '91310000LEGACY0001',
      '# 历史报告\n\n- 行业优先级：P1', JSON.stringify(legacy), NOW);

  initializeDatabase(database);

  const row = database.prepare(
    'SELECT report_markdown, result_json FROM assessments WHERE assessment_id = ?',
  ).get('legacy') as { report_markdown: string; result_json: string };
  expect(row.report_markdown).toContain('行业优先级：P1');
  expect(JSON.parse(row.result_json)).toMatchObject({
    industryLabel: null,
    industryEvidenceIds: [],
  });
  expect(JSON.parse(row.result_json)).not.toHaveProperty('industryClassification');
});

it('leaves an already migrated industry label audit unchanged', () => {
  const current = {
    industryLabel: '工业机器人本体制造',
    industryEvidenceIds: ['industry-source'],
    evidenceSelection: selectionAudit,
    opportunities: opportunityAudits,
  };
  // Insert, initialize, then assert exact JSON equality.
});
```

- [ ] **Step 2: Run the tests and verify the legacy case fails**

Run:

```bash
rtk npm test -- --run tests/db.test.ts
```

Expected: the legacy row still contains `industryClassification` and does not contain `industryLabel`.

- [ ] **Step 3: Implement the bounded startup data migration**

Add this migration shape to `src/db/database.ts`; malformed unrelated JSON is left untouched so database initialization does not destroy stored reports:

```ts
type StoredAuditRow = { assessment_id: string; result_json: string };

export function migrateLegacyIndustryAudits(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT assessment_id, result_json
    FROM assessments
    WHERE result_json IS NOT NULL
  `).all() as StoredAuditRow[];
  const update = database.prepare(
    'UPDATE assessments SET result_json = ? WHERE assessment_id = ?',
  );

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.result_json);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const audit = parsed as Record<string, unknown>;
    if (!Object.hasOwn(audit, 'industryClassification') || Object.hasOwn(audit, 'industryLabel')) continue;
    const { industryClassification: _legacy, ...rest } = audit;
    update.run(JSON.stringify({
      ...rest,
      industryLabel: null,
      industryEvidenceIds: [],
    }), row.assessment_id);
  }
}
```

Call `migrateLegacyIndustryAudits(database)` at the end of `initializeDatabase`, after adding the `result_json` column when necessary.

- [ ] **Step 4: Run database tests and typecheck**

```bash
rtk npm test -- --run tests/db.test.ts
rtk npm run typecheck
```

Expected: all database tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the migration**

```bash
rtk git add src/db/database.ts tests/db.test.ts
rtk git commit -m "feat: migrate legacy industry audits"
```

---

### Task 2: Replace the Runtime Industry Contract and Ark Boundary

**Files:**
- Modify: `src/contracts/evidence.ts`
- Modify: `src/contracts/result-audit.ts`
- Modify: `src/contracts/report.ts`
- Modify: `src/upstream/ark/prompt.ts`
- Modify: `src/upstream/ark/evidence-validator.ts`
- Modify: `src/orchestration/assessment-runner.ts`
- Modify: `src/report/build-report-model.ts`
- Modify: `src/report/render-markdown.ts`
- Modify: `src/logging/logger.ts`
- Delete: `src/industry/classify-industry.ts`
- Delete: `tests/industry-classification.test.ts`
- Modify: `tests/contracts.test.ts`
- Modify: `tests/ark-adapter.test.ts`
- Modify: `tests/evidence-validator.test.ts`
- Modify: `tests/assessment-runner.test.ts`
- Modify: `tests/report.test.ts`
- Modify: `tests/logging.test.ts`
- Modify: `tests/opportunity.test.ts`
- Modify: `tests/recruitment-signals.test.ts`
- Modify: `tests/db.test.ts`
- Modify: `tests/assessment-service.test.ts`
- Modify: `tests/mcp-e2e.test.ts`
- Modify: `tests/fixtures/ark-evidence.json`

**Interfaces:**
- Consumes: `ResearchBundle` evidence selected by the existing payload budget.
- Produces: `IndustryLabelSchema`, `EvidenceBundle.industryLabel`, `ReportModel.industryLabel`, and `AssessmentResultAudit.industryLabel`.
- Removes: `IndustryClassificationSchema`, `IndustryClassification`, `supplementIndustryClassification`, and every runtime `industryClassification` property.

- [ ] **Step 1: Write failing contract, Ark, report, logger, and invariance tests**

Add focused contract tests:

```ts
it('accepts an evidence-backed free-form industry label', () => {
  expect(EvidenceBundleSchema.parse({
    ...bundle,
    industryLabel: '消费级与工业级 3D 打印设备',
    industryEvidenceIds: ['industry-source'],
  }).industryLabel).toBe('消费级与工业级 3D 打印设备');
});

it.each([
  { industryLabel: null, industryEvidenceIds: ['industry-source'] },
  { industryLabel: '3D 打印设备', industryEvidenceIds: [] },
  { industryLabel: 'A', industryEvidenceIds: ['industry-source'] },
  { industryLabel: '超出四十个字符的行业标签必须由这个测试构造为明确超过上限的完整字符串用于拒绝验证', industryEvidenceIds: ['industry-source'] },
])('rejects an inconsistent industry label: %j', invalidIndustry => {
  expect(() => EvidenceBundleSchema.parse({ ...bundle, ...invalidIndustry })).toThrow();
});
```

Add Ark prompt assertions:

```ts
expect(ARK_SYSTEM_PROMPT).toMatch(/industryLabel.*string\|null/s);
expect(ARK_SYSTEM_PROMPT).toMatch(/2.?40.*字符.*confirmed.*legal_entity/s);
expect(ARK_SYSTEM_PROMPT).not.toMatch(/P1|P2|non_target|行业优先级/u);
```

Add validator cases:

```ts
it('accepts a label cited only by confirmed legal-entity evidence', () => {
  const candidate = fixtureWith({
    industryLabel: '工业自动化装备',
    industryEvidenceIds: ['web-1'],
  });
  expect(validateArkEvidence(researchBundle(), candidate).industryLabel)
    .toBe('工业自动化装备');
});

it.each(['probable', 'unverified'] as const)(
  'rejects an industry label backed by %s subject attribution',
  entityMatch => {
    const research = researchBundleWithMatch(entityMatch);
    expect(() => validateArkEvidence(research, fixtureWith({
      industryLabel: '工业自动化装备',
      industryEvidenceIds: ['web-1'],
    }))).toThrow(ArkEvidenceValidationError);
  },
);
```

Add report and logger assertions:

```ts
expect(renderMarkdown(reportWith({ industryLabel: '消费级与工业级 3D 打印设备' })))
  .toContain('- 行业：消费级与工业级 3D 打印设备');
expect(renderMarkdown(reportWith({ industryLabel: null })))
  .toContain('- 行业：待核实');

expect(JSON.parse(logLine)).toMatchObject({ industry_label: '工业自动化装备' });
expect(JSON.parse(logLine)).not.toHaveProperty('industry_classification');
```

Add an explicit opportunity invariant using the same evidence object:

```ts
it('does not change any opportunity result when the descriptive industry label changes', () => {
  const base = completeHighCase(cases[0]!);
  const results = [
    { industryLabel: '机器人智能装备', industryEvidenceIds: ['recruitment'] },
    { industryLabel: '消费级电子设备', industryEvidenceIds: ['recruitment'] },
    { industryLabel: null, industryEvidenceIds: [] },
  ].map(industry => evaluateOpportunities({ ...base, ...industry }, NOW));
  expect(results[1]).toEqual(results[0]);
  expect(results[2]).toEqual(results[0]);
});
```

- [ ] **Step 2: Run focused tests and verify they fail against the enum contract**

```bash
rtk npm test -- --run tests/contracts.test.ts tests/ark-adapter.test.ts tests/evidence-validator.test.ts tests/report.test.ts tests/logging.test.ts tests/opportunity.test.ts
```

Expected: failures mention missing `industryLabel`, unexpected `industryClassification`, old prompt policy, or old Markdown/log keys.

- [ ] **Step 3: Implement the new Zod contracts**

In `src/contracts/evidence.ts`, replace the enum and EvidenceBundle fields:

```ts
export const IndustryLabelSchema = z.string().trim().min(2).max(40).nullable();

export const EvidenceBundleSchema = z.object({
  identity: IdentityProfileSchema,
  industryLabel: IndustryLabelSchema,
  industryEvidenceIds: z.array(z.string()),
  evidence: z.array(EvidenceReferenceSchema),
  facts: z.array(EvidenceFactSchema),
  financingRecords: z.array(FinancingRecordSchema),
  conflicts: z.array(z.string()),
  gaps: z.array(z.string()),
  collectedAt: UtcTimestampSchema,
}).strict().superRefine((bundle, context) => {
  const hasLabel = bundle.industryLabel !== null;
  const hasEvidence = bundle.industryEvidenceIds.length > 0;
  if (hasLabel !== hasEvidence) {
    context.addIssue({
      code: 'custom',
      path: ['industryEvidenceIds'],
      message: 'industry label and evidence IDs must either both be present or both be absent',
    });
  }
});

export type IndustryLabel = z.infer<typeof IndustryLabelSchema>;
```

Delete both `IndustryClassificationSchema` and `IndustryClassification`. Apply the same `industryLabel` property and null/evidence consistency refinement to `AssessmentResultAuditSchema` and `ReportModelSchema`.

- [ ] **Step 4: Update the Ark output shape and prompt**

Change the shape to:

```ts
industryLabel: 'string|null',
industryEvidenceIds: ['string'],
```

Replace all fixed taxonomy instructions with:

```ts
'行业标签只描述已确认法定主体的主营产品与技术场景，不参与评分。',
'industryLabel 为 2–40 个字符的具体可读标签，例如“消费级与工业级 3D 打印设备”；不得输出优先级、行业代码或泛化的“科技行业”“制造业”。',
'industryLabel 只能引用 entityScope=legal_entity 且 entityMatch=confirmed 的证据；证据不足、冲突或只有集团/子公司/品牌证据时输出 null 和空 industryEvidenceIds。',
```

Update the empty-input instruction to require `industryLabel=null` and empty `industryEvidenceIds`.

- [ ] **Step 5: Enforce target-subject provenance in the Ark validator**

Replace the enum-specific validation with:

```ts
if (evidence.industryLabel !== null) {
  const industryReferences = evidence.industryEvidenceIds
    .map(evidenceId => referenceById.get(evidenceId));
  if (industryReferences.length !== evidence.industryEvidenceIds.length
    || industryReferences.some(reference => reference?.entityScope !== 'legal_entity'
      || reference.entityMatch !== 'confirmed')) {
    invalid('An industry label requires confirmed legal-entity evidence');
  }
}
```

For an empty ResearchBundle, count `evidence.industryLabel !== null` or non-empty industry evidence as a claimed fact.

- [ ] **Step 6: Replace runtime consumers and remove the classifier**

In `assessment-runner.ts`, remove the classifier import and parse Ark evidence directly:

```ts
const evidence = EvidenceBundleSchema.parse(extracted.value.evidence);
// ...
const resultAudit: AssessmentResultAudit = {
  industryLabel: evidence.industryLabel,
  industryEvidenceIds: evidence.industryEvidenceIds,
  evidenceSelection: { /* existing exact fields */ },
  opportunities: assessment.products.map(product => ({
    product: product.product,
    level: product.level,
    evidenceIds: product.evidenceIds,
  })),
};
```

Delete `src/industry/classify-industry.ts` and `tests/industry-classification.test.ts`.

In `build-report-model.ts`, remove the industry-dependent gap and emit:

```ts
industryLabel: evidence.industryLabel,
industryEvidenceIds: evidence.industryEvidenceIds,
```

In `render-markdown.ts`, render:

```ts
`- 行业：${model.industryLabel === null ? '待核实' : escapeInline(model.industryLabel)}`,
```

In `logger.ts`, emit:

```ts
industry_label: audit.industryLabel,
```

- [ ] **Step 7: Migrate every fixture and test builder to the new field**

Apply these deterministic replacements without changing product evidence:

- old `P1`, `P2`, or `non_target` fixtures with valid industry evidence become a concrete label such as `工业自动化装备` and keep their evidence IDs;
- old `unverified` fixtures become `industryLabel: null` and `industryEvidenceIds: []`;
- tests that previously varied P1/P2/non-target become the one explicit industry-label invariance test from Step 1;
- `tests/fixtures/ark-evidence.json` uses `"industryLabel": "工业自动化装备"` with its existing valid industry evidence ID.

Do not alter opportunity expectations except where the test asserted the removed enum or removed industry gap text.

- [ ] **Step 8: Run all affected tests and typecheck**

```bash
rtk npm test -- --run tests/contracts.test.ts tests/ark-adapter.test.ts tests/evidence-validator.test.ts tests/assessment-runner.test.ts tests/report.test.ts tests/logging.test.ts tests/opportunity.test.ts tests/recruitment-signals.test.ts tests/db.test.ts tests/assessment-service.test.ts tests/mcp-e2e.test.ts
rtk npm run typecheck
```

Expected: all listed tests pass, deleted industry-classification tests are absent, and TypeScript exits 0.

- [ ] **Step 9: Commit the runtime migration**

```bash
rtk git add src/contracts src/upstream/ark src/orchestration/assessment-runner.ts src/report src/logging/logger.ts src/db/database.ts tests
rtk git add -u src/industry tests/industry-classification.test.ts
rtk git commit -m "feat: replace industry priority with evidence label"
```

---

### Task 3: Synchronize Documentation and Validate the Complete System

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-28-target-customer-assessment-mcp-v0.1-design.md`
- Create: `docs/validation/2026-09-02-free-form-industry-label.md`

**Interfaces:**
- Consumes: completed runtime behavior from Task 2.
- Produces: canonical documentation and one real local-HTTP MCP validation record.

- [ ] **Step 1: Update canonical documentation**

Replace current-runtime P1/P2 language in the canonical v0.1 spec with these rules:

```markdown
- Ark may output one evidence-backed free-text `industryLabel`, or `null` when evidence is insufficient.
- `industryLabel` is descriptive metadata only and never changes opportunity level, recommendation, or confidence.
- Reports display `行业：待核实` when the label is null.
```

Update JSON examples from `industryClassification` to `industryLabel`. Keep historical validation documents unchanged because they record behavior observed before this migration.

- [ ] **Step 2: Run complete automated verification**

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
rtk rg -n "IndustryClassification|industryClassification|industry_classification|行业优先级|non_target" src tests README.md
```

Expected: tests, typecheck, build, and diff check pass; the final `rg` exits 1 with no matches. Prompt tests may mention literal `P1|P2` only inside negative assertions; if so, restrict the production scan to `src README.md` and verify tests contain only negative assertions.

- [ ] **Step 3: Create an ignored real-validation script**

Use `apply_patch` to create `.superpowers/free-form-industry-label-e2e.mjs`. It must:

- load the existing `.env` without printing it;
- use a temporary SQLite database;
- start the application on local HTTP;
- call `get_company_profile` for `深圳市智能派科技有限公司`;
- verify credit code `91440300326696829M`;
- submit exactly one `force_refresh=true` assessment;
- poll the same assessment for at most 10 minutes;
- print only assessment ID, elapsed seconds, source statuses, `overall_opportunity`, `recommended_product`, the rendered industry line, and whether the Markdown contains any removed P1/P2 terminology.

The output object must have this exact safe shape:

```js
{
  assessmentId,
  elapsedSeconds,
  status: report.status,
  sourceStatus: report.source_status,
  overallOpportunity: report.overall_opportunity,
  recommendedProduct: report.recommended_product,
  industryLine: markdown.split('\n').find(line => line.startsWith('- 行业：')) ?? null,
  containsRemovedIndustryPriority: /行业优先级|\bP1\b|\bP2\b|non_target/u.test(markdown),
}
```

The script must not print tokens, environment variables, ResearchBundle, QCC responses, webpage bodies, or Ark request/response payloads.

- [ ] **Step 4: Execute the one real assessment and record the result**

```bash
rtk node .superpowers/free-form-industry-label-e2e.mjs
```

Expected:

- exact legal entity and credit code are confirmed;
- the assessment reaches `completed` or records a specific real upstream failure without a second submission;
- a non-null industry line is backed by confirmed source evidence;
- a null label renders exactly `- 行业：待核实`;
- `containsRemovedIndustryPriority` is `false`;
- QCC, Doubao, and Ark statuses reflect actual outcomes without being rewritten as success.

Write `docs/validation/2026-09-02-free-form-industry-label.md` with the safe output, automated-test counts, and any remaining limitations. Do not paste raw upstream content.

- [ ] **Step 5: Remove temporary validation assets and re-run the final gate**

```bash
rtk rm -f .superpowers/free-form-industry-label-e2e.mjs
rtk rm -f /tmp/salestools-free-form-industry.sqlite
rtk rm -f /tmp/salestools-free-form-industry.sqlite-shm
rtk rm -f /tmp/salestools-free-form-industry.sqlite-wal
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
rtk git status --short
```

Expected: all checks pass; temporary assets are absent; Git status lists only the intended documentation changes.

- [ ] **Step 6: Commit documentation and validation evidence**

```bash
rtk git add README.md docs/superpowers/specs/2026-08-28-target-customer-assessment-mcp-v0.1-design.md docs/validation/2026-09-02-free-form-industry-label.md
rtk git commit -m "docs: record free-form industry label validation"
```

## Plan Self-Review

- Spec coverage: runtime enum removal, nullable label contract, confirmed-subject provenance, report/log/audit output, opportunity invariance, legacy audit migration, documentation, and real E2E each map to an explicit task.
- Placeholder scan: the plan contains no TODO, TBD, “similar to”, or undefined production interface.
- Type consistency: `industryLabel` is `string | null` and `industryEvidenceIds` is `string[]` in EvidenceBundle, ReportModel, AssessmentResultAudit, Ark output, runner, report, and logger.
- Scope: no new taxonomy, configuration, MCP tool, database column, or opportunity rule is introduced.
