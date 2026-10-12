import { expect, it } from "vitest";
import type { ContactEvidence } from "../src/contracts/index.js";
import {
  dedupeMaterials,
  validateContextRefs,
  filterConflictedEvidence,
} from "../src/companies/company-evidence.js";
const make = (ref: string, statement: string) => ({
  citation: {
    ref,
    source_type: "contact" as const,
    subject_id: "p1",
    quote: statement,
  },
  statement,
  source_key: "file:a",
  predicate: "worksFor",
  object: "甲公司",
});
it("deduplicates imports and preserves independent facts", () => {
  const items = dedupeMaterials([
    make("a", "任职"),
    make("b", "任职"),
    make("c", "2022年"),
  ]);
  expect(items).toHaveLength(2);
  expect(() => validateContextRefs(["missing"], items)).toThrow(
    "UNSUPPORTED_CONTEXT_REFERENCE",
  );
  expect(validateContextRefs(["a"], items)).toEqual([items[0].citation]);
});
const proof = (
  id: string,
  relation: string,
  field: string,
): ContactEvidence => ({
  evidence_id: id,
  subject_kind: "relation",
  subject_id: relation,
  field_path: field,
  value: id,
  quote: id,
  source_type: "manual",
  locator_status: "not_applicable",
  collected_at: "2026-10-12T00:00:00.000Z",
});
it("filters only disputed fields and preserves independent historical segments", () => {
  const a = proof("a", "r1", "properties.role.roleName"),
    b = proof("b", "r1", "properties.role.roleName"),
    c = proof("c", "r2", "$relation");
  expect(filterConflictedEvidence([a, b, c], [b])).toEqual({
    usable: [c],
    blocked: [a, b],
  });
  expect(filterConflictedEvidence([a, c], []).usable).toEqual([a, c]);
});
it("blocks every field of a disputed relationship", () => {
  const a = proof("a", "r1", "$relation"),
    b = proof("b", "r1", "properties.role.roleName");
  expect(filterConflictedEvidence([a, b], [a]).usable).toEqual([]);
});

it("preserves required assessment citations from one source while deduplicating the same citation", () => {
  const first = {
    ...make("assessment:r:A", "设备和维护"),
    citation: {
      ref: "assessment:r:A",
      source_type: "assessment" as const,
      subject_id: "company",
      evidence_id: "A",
      quote: "设备",
    },
  };
  const second = {
    ...first,
    citation: {
      ...first.citation,
      ref: "assessment:r:B",
      evidence_id: "B",
      quote: "维护",
    },
  };
  expect(dedupeMaterials([first, { ...first }, second])).toEqual([
    first,
    second,
  ]);
  expect(
    validateContextRefs(["assessment:r:A", "assessment:r:B"], [first, second]),
  ).toEqual([first.citation, second.citation]);
});
