# Remove Positive Decision Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a product opportunity to reach “高” without externally unverifiable positive decision-right evidence, while retaining explicit negative decision and group-procurement blockers.

**Architecture:** Keep the existing Ark-to-`EvidenceBundle` boundary and deterministic seven-product evaluator. Change only the high-opportunity predicate and its explanatory output; negative blocker recognition remains in the same evaluator.

**Tech Stack:** Node.js 24, TypeScript, Vitest, Zod

## Global Constraints

- Positive independent decision-right evidence is not required for “高”.
- Explicit negative decision or group-procurement evidence remains a blocker.
- One recent, direct, confirmed recruitment fact naming a product or engineering method can still produce “中”.
- Industry labels remain display-only.
- Do not add configuration, scores, database fields, or model calls.

---

### Task 1: Remove the positive decision-right gate

**Files:**
- Modify: `tests/opportunity.test.ts`
- Modify: `src/opportunity/evaluate-product.ts`

**Interfaces:**
- Consumes: `evaluateOpportunities(evidence: EvidenceBundle, now: Date): OpportunityAssessment`
- Produces: unchanged `OpportunityAssessment`; only the deterministic level decision changes.

- [ ] **Step 1: Write the failing high-opportunity regression test**

Add this test after the existing high-case table test:

```ts
it.each(cases)('$product: positive decision-right evidence is not required for 高', entry => {
  const input = completeHighCase(entry);
  input.evidence = input.evidence.filter(item => item.evidenceId !== 'decision');
  input.facts = input.facts.filter(item => item.kind !== 'decision_power');

  const result = evaluateOpportunities(input, NOW);

  expect(result.products.find(row => row.product === entry.product)?.level).toBe('高');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk npm test -- --run tests/opportunity.test.ts
```

Expected: the new seven table cases fail with received level `中`, proving the current positive `decisionSupport` gate is active.

- [ ] **Step 3: Remove only the positive decision requirement**

In `src/opportunity/evaluate-product.ts`:

1. Delete `POSITIVE_DECISION_KEYWORDS`.
2. Delete `positiveDecisionFact(...)`.
3. Delete calculation of `decisionSupport`.
4. Remove `&& decisionSupport` from the high predicate.
5. Change the high reason to:

```ts
reasons.push('复杂度、近期时机与预算证据齐备');
```

6. Delete this medium-level gap:

```ts
if (!decisionSupport) gaps.push('独立决策权待核实');
```

Do not change `negativeSupportKind`, `NEGATIVE_DECISION_PATTERN`, `GENERAL_BLOCKER_KEYWORDS`, or `blockerDescriptions`.

- [ ] **Step 4: Verify GREEN and existing behavior**

Run:

```bash
rtk npm test -- --run tests/opportunity.test.ts
```

Expected: all opportunity tests pass, including:

- the new no-positive-decision high cases;
- `uses an explicit PDM recruitment statement even when Ark omits productTags`, which remains `中`;
- explicit negative decision support cases, which remain blocked and `低`.

- [ ] **Step 5: Commit the rule change**

```bash
rtk git add tests/opportunity.test.ts src/opportunity/evaluate-product.ts
rtk git commit -m "fix: remove positive decision gate from high opportunity"
```

---

### Task 2: Align documentation and verify the complete application

**Files:**
- Modify: `docs/superpowers/specs/2026-08-28-target-customer-assessment-mcp-v0.1-design.md`

**Interfaces:**
- Consumes: the high/middle/low/unverified behavior implemented in Task 1.
- Produces: canonical v0.1 documentation aligned with runtime behavior.

- [ ] **Step 1: Update the canonical decision rules**

Make these exact semantic changes:

- Replace “企业预算能力与独立决策权” with “企业预算能力，以及明确的采购或决策阻碍”.
- Replace the factor heading “预算与决策权” with “预算与明确阻碍”.
- State that absent public decision-right evidence is neutral and does not create a rating gap.
- Keep explicit “无独立采购权” and “集团统一采购” as blockers.
- In the “高” rule, require budget support and no known blocker, but not positive decision-right proof.
- In the “中” rule, remove missing decision rights from the reasons a case remains medium.

- [ ] **Step 2: Check for stale runtime language**

Run:

```bash
rtk rg -n "decisionSupport|独立决策权待核实|预算与决策权证据齐备" src tests
```

Expected: no matches.

- [ ] **Step 3: Run complete verification**

Run:

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
```

Expected: 22 test files and all tests pass; typecheck, build, and diff check exit successfully.

- [ ] **Step 4: Commit documentation**

```bash
rtk git add docs/superpowers/specs/2026-08-28-target-customer-assessment-mcp-v0.1-design.md docs/superpowers/plans/2026-09-04-remove-positive-decision-gate.md
rtk git commit -m "docs: align opportunity decision requirements"
```
