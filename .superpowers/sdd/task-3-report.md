# Task 3 Report: Compact assessment result audit

## Status

Completed with strict TDD. The implementation persists a derived-only assessment audit in `assessments.result_json`, carries the Ark payload selection through the runner, and emits one allowlisted decision log event without changing MCP response contracts.

## RED evidence

- DB RED: `npm test -- --run tests/db.test.ts` failed because a legacy `assessments` table had no `result_json` column.
- Runner/logging RED: `npm test -- --run tests/assessment-runner.test.ts tests/logging.test.ts` failed because the runner did not persist `resultAudit` and `JsonlLogger.logAssessmentDecision` did not exist.

## Implementation

- Added strict `AssessmentResultAuditSchema` / `AssessmentResultAudit` containing only:
  - industry classification and evidence IDs;
  - selected evidence IDs, original/selected/excluded counts, four category counts, research/request byte counts;
  - exactly one derived level and evidence-ID list for each of the seven products.
- Added nullable `result_json TEXT` to new schemas and an idempotent `PRAGMA table_info` + `ALTER TABLE` migration for existing tables. Existing completed legacy rows remain readable with `resultAudit: null`.
- Extended `AssessmentCompletion` with required `resultAudit`; repository writes validated JSON atomically with the completed report and parses it on read.
- Changed the runner dependency to `extractWithAudit`, derives the compact audit from `ArkPayloadSelection`, persists it, then emits an ordinary `assessment_decision` event.
- Decision logging emits only identifiers, classifications, counts, byte sizes, category counts, and product levels. Logging sink failure cannot reverse an already persisted completed assessment.
- Updated application/test Ark dependencies to the audited interface. MCP schemas and service responses were not changed.

## Data minimization verification

- The audit contract is strict and has no source text, summary, report body, prompt, or raw response fields.
- DB and runner tests inspect serialized `result_json` and reject `summary`, `content`, `raw`, `response`, and `reportMarkdown` markers.
- Logging tests inject source content, summary, and raw response fields and verify none are serialized.

## Verification

- Focused Task 3 tests: 33/33 passed.
- Related integration tests: 47/47 passed, including lifecycle and MCP end-to-end coverage.
- Full suite: 22 files, 575/575 tests passed.
- Typecheck: `tsc --noEmit` passed.
- Build: `tsc -p tsconfig.build.json` passed.
- Diff check: `git diff --check` passed.

## Self-review

- Migration is sequentially idempotent and compatible with the prior `assessments` layout.
- Repository validation prevents arbitrary JSON from being written through `completeAssessment`.
- Seven-product completeness and selection-count arithmetic are enforced by Zod refinements.
- The existing Ark `extract` compatibility method remains available, while the assessment runner requires the audited method.
- No public MCP output fields were added; the existing end-to-end contract test passes unchanged.

## Concerns

- Node prints its existing experimental SQLite warning during tests; there are no test failures or new runtime warnings from this change.
