# Ark Evidence and Opportunity Report Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dynamically pack categorized evidence into the Ark byte budget, always render the seven-product assessment, and persist a compact auditable result.

**Architecture:** Keep collection, extraction, deterministic opportunity evaluation, and rendering as separate modules. Extend the Ark payload-budget module to return both a compact bundle and selection statistics; carry those statistics through the runner into a compact stored result without changing the public MCP response.

**Tech Stack:** Node.js 24 runtime, TypeScript, Vitest, `node:sqlite`, Zod, existing Ark/QCC/Doubao adapters.

## Global Constraints

- Default `ARK_REQUEST_MAX_BYTES` is 12,288 and is configurable through `.env`.
- No fixed evidence-item count and no raw upstream response persistence.
- Selection and opportunity evaluation must be deterministic for identical input.
- QCC `partial`, unavailable links, financing failure, and annual-report failure are not global scoring vetoes.
- Every production behavior change follows a failing-test-first cycle.

---

### Task 1: Dynamic categorized Ark evidence packing

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `src/upstream/ark/payload-budget.ts`
- Modify: `src/upstream/ark/client.ts`
- Modify: `src/upstream/ark/prompt.ts`
- Test: `tests/config.test.ts`
- Test: `tests/ark-adapter.test.ts`

**Interfaces:**
- Produces: `compactResearchBundleForArk(bundle, requestMaxBytes): ArkPayloadSelection`
- `ArkPayloadSelection` contains `bundle`, `originalCount`, `selectedCount`, `excludedCount`, `categoryCounts`, and `researchBytes`.
- `ArkEvidenceService.lastSelection` is not exposed; `extractWithAudit(bundle)` returns `{ evidence, selection, requestBytes }` for the runner while `extract(bundle)` remains compatible for tests and callers.

- [ ] Write failing config tests proving `ARK_REQUEST_MAX_BYTES` defaults to 12,288 and rejects values too small to contain the immutable request.
- [ ] Run `npm test -- --run tests/config.test.ts` and confirm the new assertions fail because the key is unknown.
- [ ] Add the parsed positive integer to `AppConfig`, `.env.example`, and Ark construction.
- [ ] Write failing Ark tests proving more than four compact items fit, industry/technology/timing/capacity coverage is reserved, selection is stable, and the final request stays below the supplied budget.
- [ ] Run `npm test -- --run tests/ark-adapter.test.ts` and confirm failures reference the fixed four-item behavior.
- [ ] Replace `MAX_ITEMS` selection with deterministic category reservation and byte-driven candidate fitting; generate `N/M` capacity copy only when content is shortened or items are excluded.
- [ ] Run `npm test -- --run tests/config.test.ts tests/ark-adapter.test.ts` and confirm all pass.
- [ ] Commit with `git commit -m "fix: dynamically pack ark evidence"`.

### Task 2: Always render the full opportunity assessment

**Files:**
- Modify: `src/report/render-markdown.ts`
- Modify: `src/report/build-report-model.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Produces: one `renderMarkdown(model)` path for both recommended and unrecommended assessments.
- Produces: `classifyReportGap(gap): 'rating' | 'enhancement' | 'audit'` for presentation only.

- [ ] Write a failing report test where all products are `待核实` and assert the Markdown contains the customer summary, all seven labels, “暂不推荐”, key evidence, and three gap sections.
- [ ] Run `npm test -- --run tests/report.test.ts` and confirm it fails because `renderDegraded` hides the matrix.
- [ ] Replace the degraded renderer with the common full renderer, conditionally rendering recommendation-specific roles/questions only when a product exists.
- [ ] Add deterministic gap classification for industry/subject/conflict gaps, budget/timing/decision gaps, and source/link/capacity gaps.
- [ ] Run `npm test -- --run tests/report.test.ts` and update the existing intentional snapshot to the approved full structure.
- [ ] Commit with `git commit -m "fix: show opportunities in unverified reports"`.

### Task 3: Persist compact result audit and decision logs

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/database.ts`
- Modify: `src/db/assessment-repository.ts`
- Modify: `src/orchestration/assessment-runner.ts`
- Modify: `src/logging.ts`
- Modify: `src/contracts/report.ts` or create `src/contracts/result-audit.ts`
- Test: `tests/db.test.ts`
- Test: `tests/assessment-runner.test.ts`
- Test: `tests/logging.test.ts`

**Interfaces:**
- Produces: `AssessmentResultAuditSchema` and `AssessmentResultAudit` with only derived classifications, evidence IDs, counts, category counts, and byte counts.
- Extends `completeAssessment` input with `resultAudit` and stores it as `result_json`.

- [ ] Write a failing DB migration test opening a legacy schema without `result_json`, then assert the column is added and a valid audit round-trips.
- [ ] Run `npm test -- --run tests/db.test.ts` and confirm the column/query assertions fail.
- [ ] Add the idempotent migration, Zod contract, repository serialization and parsing.
- [ ] Write a failing runner test asserting selected evidence IDs/counts and seven opportunities are persisted without source content.
- [ ] Write a failing logging test asserting one sanitized decision event contains counts, byte sizes and product levels.
- [ ] Run the focused tests and confirm the new runner/logging assertions fail before wiring.
- [ ] Carry `ArkPayloadSelection` through the Ark service and assessment runner, construct the audit after evaluation, persist it, and emit the ordinary log event.
- [ ] Run `npm test -- --run tests/db.test.ts tests/assessment-runner.test.ts tests/logging.test.ts` and confirm all pass.
- [ ] Commit with `git commit -m "feat: persist assessment decision audit"`.

### Task 4: Capacity calibration and release verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-01-ark-evidence-report-fix-design.md` only if measured results refine the default.
- Test: all existing and new test files.

**Interfaces:**
- Consumes: production `.env` credentials without printing them.
- Produces: no new runtime interface; records only sanitized byte/count/latency results.

- [ ] Run `npm test -- --run`, `npm run typecheck`, `npm run build`, and `git diff --check`; require zero failures.
- [ ] Run the existing real-upstream assessment harness at 12KB using the authorized legal company and record only status, duration, selected count, request bytes and contract validity.
- [ ] Repeat at 24KB and 48KB only if the previous size succeeds; stop at the first upstream rejection and do not print credentials or source content.
- [ ] Keep 12KB as default unless a larger size succeeds repeatedly and improves category coverage without invalid output.
- [ ] Document `ARK_REQUEST_MAX_BYTES`, the always-visible matrix, `result_json`, and the single-replica SQLite constraint in `README.md`.
- [ ] Re-run the full verification commands after documentation/config changes.
- [ ] Commit with `git commit -m "docs: document ark evidence audit controls"`.
