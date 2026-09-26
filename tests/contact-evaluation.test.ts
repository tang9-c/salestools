import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractionPass, precision, recall, scoreAnswer, scoreExtraction,
  scoreSearch, summarizeQuality } from '../scripts/evaluate-contacts.js';

const fixtures = fileURLToPath(new URL('./fixtures/contact-evals/annotations.json', import.meta.url));

describe('fixed contact quality scorer', () => {
  it('counts omissions as FN, invented values as FP, and preserves phone suffixes and date precision', () => {
    const truth = { id: 'case-1', file: 'case-1.pdf', kind: 'text_pdf', pages: [
      { page: 1, text: 'Mira Chen | Helio Works | +86 10 5555 0101 ext 208 | 2021-03' },
    ], facts: [
      { owner: 'mira', field: 'name', value: 'Mira Chen', page: 1, quote: 'Mira Chen' },
      { owner: 'mira', field: 'telephone', value: '+86 10 5555 0101 ext 208', page: 1,
        quote: '+86 10 5555 0101 ext 208' },
      { owner: 'mira', field: 'startDate', value: '2021-03', page: 1, quote: '2021-03' },
    ], relations: [], complexity: [] } as const;
    const prediction = { candidates: [{ candidate_id: 'c1', properties: {
      name: 'Ｍｉｒａ  Chen', telephone: ['+86 10 5555 0101 ext 209'], startDate: '2021-03-01',
    }, evidence: [
      { field_path: 'properties.name', value: 'Ｍｉｒａ  Chen', page: 1, quote: 'Mira Chen' },
    ], relation_suggestions: [] }] };
    const result = scoreExtraction(prediction, truth);
    expect(result.counts).toEqual({ tp: 1, fp: 2, fn: 2 });
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('telephone'), expect.stringContaining('startDate'),
    ]));
    expect(precision(1, 2)).toBeCloseTo(1 / 3);
    expect(recall(1, 2)).toBeCloseTo(1 / 3);
    expect(extractionPass(94, 6, 10)).toBe(false);
  });

  it('hard-fails an unsupported relation even when other fields match', () => {
    const truth = { id: 'relation', file: 'relation.pdf', kind: 'text_pdf',
      pages: [{ page: 1, text: 'Avery Moss works at Cedar Labs.' }],
      facts: [{ owner: 'avery', field: 'name', value: 'Avery Moss', page: 1, quote: 'Avery Moss' }],
      relations: [], complexity: ['multi_person'] } as const;
    const result = scoreExtraction({ candidates: [{ candidate_id: 'c1',
      properties: { name: 'Avery Moss' }, evidence: [{ field_path: 'properties.name',
        value: 'Avery Moss', page: 1, quote: 'Avery Moss' }],
      relation_suggestions: [{ source_candidate_id: 'c1', target_candidate_id: 'c2',
        relation_type: 'spouse', evidence: [] }] }] }, truth);
    expect(result.fabricatedRelations).toBe(1);
    expect(result.passes).toBe(false);
  });

  it('hard-fails wrong pages and quotes that are absent from the source', () => {
    const truth = { id: 'page', file: 'page.pdf', kind: 'text_pdf',
      pages: [{ page: 1, text: 'Mira Chen' }, { page: 2, text: 'Helio Works' }],
      facts: [{ owner: 'mira', field: 'name', value: 'Mira Chen', page: 1, quote: 'Mira Chen' }],
      relations: [], complexity: ['cross_page'] } as const;
    const result = scoreExtraction({ candidates: [{ candidate_id: 'c1',
      properties: { name: 'Mira Chen' }, evidence: [{ field_path: 'properties.name',
        value: 'Mira Chen', page: 2, quote: 'Mira Chen' }], relation_suggestions: [] }] }, truth);
    expect(result.counts).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(result.evidenceErrors).toEqual([expect.stringContaining('page')]);
    expect(result.passes).toBe(false);
  });

  it('does not accept an uncited relation or silently collapse duplicate people', () => {
    const truth = { id: 'roles', file: 'roles.pdf', kind: 'text_pdf',
      pages: [{ page: 1, text: 'Avery Moss works for Cedar Labs.' }],
      facts: [{ owner: 'avery', field: 'name', value: 'Avery Moss', page: 1, quote: 'Avery Moss' },
        { owner: 'cedar', field: 'name', value: 'Cedar Labs', page: 1, quote: 'Cedar Labs' }],
      relations: [{ source: 'avery', target: 'cedar', type: 'worksFor', page: 1,
        quote: 'Avery Moss works for Cedar Labs' }], complexity: [] } as const;
    const result = scoreExtraction({ candidates: [
      { candidate_id: 'p1', properties: { name: 'Avery Moss' }, evidence: [{ field_path: 'properties.name',
        value: 'Avery Moss', page: 1, quote: 'Avery Moss' }], relation_suggestions: [{
          source_candidate_id: 'p1', target_candidate_id: 'o1', relation_type: 'worksFor', evidence: [],
        }] },
      { candidate_id: 'p2', properties: { name: 'Avery Moss' }, evidence: [], relation_suggestions: [] },
      { candidate_id: 'o1', properties: { name: 'Cedar Labs' }, evidence: [{ field_path: 'properties.name',
        value: 'Cedar Labs', page: 1, quote: 'Cedar Labs' }], relation_suggestions: [] },
    ] }, truth);
    expect(result.counts.fp).toBeGreaterThan(0);
    expect(result.evidenceErrors).toEqual([expect.stringContaining('relation')]);
    expect(result.passes).toBe(false);
  });

  it('scores role dates at their annotated precision', () => {
    const truth = { id: 'date', file: 'date.pdf', kind: 'text_pdf',
      pages: [{ page: 1, text: 'Jordan Hale works for Boreal Tech from 2024-02.' }],
      facts: [{ owner: 'jordan', field: 'name', value: 'Jordan Hale', page: 1, quote: 'Jordan Hale' },
        { owner: 'boreal', field: 'name', value: 'Boreal Tech', page: 1, quote: 'Boreal Tech' }],
      relations: [{ source: 'jordan', target: 'boreal', type: 'worksFor', page: 1,
        quote: 'Jordan Hale works for Boreal Tech from 2024-02', role: { startDate: '2024-02' } }],
      complexity: ['date_precision'] } as const;
    const result = scoreExtraction({ candidates: [
      { candidate_id: 'p1', properties: { name: 'Jordan Hale' }, evidence: [{ field_path: 'properties.name',
        value: 'Jordan Hale', page: 1, quote: 'Jordan Hale' }], relation_suggestions: [{
          source_candidate_id: 'p1', target_candidate_id: 'o1', relation_type: 'worksFor',
          properties: { role: { startDate: '2024-02-01' } },
          evidence: [{ page: 1, quote: 'Jordan Hale works for Boreal Tech from 2024-02' }],
        }] },
      { candidate_id: 'o1', properties: { name: 'Boreal Tech' }, evidence: [{ field_path: 'properties.name',
        value: 'Boreal Tech', page: 1, quote: 'Boreal Tech' }], relation_suggestions: [] },
    ] }, truth);
    expect(result.counts).toEqual({ tp: 3, fp: 1, fn: 1 });
    expect(result.failures).toEqual(expect.arrayContaining([expect.stringContaining('startDate')]));
  });

  it('rejects a correct employment date without its own page evidence', () => {
    const truth = { id: 'role-proof', file: 'role.pdf', kind: 'text_pdf',
      pages: [{ page: 1, text: 'Jordan Hale works for Boreal Tech from 2024-02.' }],
      facts: [
        { owner: 'jordan', field: 'name', value: 'Jordan Hale', page: 1, quote: 'Jordan Hale' },
        { owner: 'boreal', field: 'name', value: 'Boreal Tech', page: 1, quote: 'Boreal Tech' },
      ],
      relations: [{ source: 'jordan', target: 'boreal', type: 'worksFor', page: 1,
        quote: 'Jordan Hale works for Boreal Tech', role: { startDate: '2024-02' } }],
      complexity: ['evidence_location'] } as const;
    const result = scoreExtraction({ candidates: [
      { candidate_id: 'p', properties: { name: 'Jordan Hale' },
        evidence: [{ field_path: 'properties.name', value: 'Jordan Hale', page: 1, quote: 'Jordan Hale' }],
        relation_suggestions: [{ source_candidate_id: 'p', target_candidate_id: 'o',
          relation_type: 'worksFor', properties: { role: { startDate: '2024-02' } },
          evidence: [{ page: 1, quote: 'Jordan Hale works for Boreal Tech' }] }] },
      { candidate_id: 'o', properties: { name: 'Boreal Tech' },
        evidence: [{ field_path: 'properties.name', value: 'Boreal Tech', page: 1, quote: 'Boreal Tech' }],
        relation_suggestions: [] },
    ] }, truth);
    expect(result.counts).toEqual({ tp: 4, fp: 0, fn: 0 });
    expect(result.evidenceErrors).toEqual(expect.arrayContaining([expect.stringContaining('role.startDate')]));
    expect(result.passes).toBe(false);
  });

  it('rejects a person extracted as an organization even when the name and citation match', () => {
    const truth = { id: 'kind', file: 'kind.pdf', kind: 'text_pdf',
      pages: [{ page: 1, text: 'Mira Chen' }], entities: [{ id: 'mira', label: 'Person' }],
      facts: [{ owner: 'mira', field: 'name', value: 'Mira Chen', page: 1, quote: 'Mira Chen' }],
      relations: [], complexity: [] } as const;
    const result = scoreExtraction({ candidates: [{ candidate_id: 'c1', label: 'Organization',
      properties: { name: 'Mira Chen' }, evidence: [{ field_path: 'properties.name',
        value: 'Mira Chen', page: 1, quote: 'Mira Chen' }], relation_suggestions: [] }] }, truth);
    expect(result.labelErrors).toBe(1);
    expect(result.passes).toBe(false);
  });

  it('requires semantic target in top five without giving keyword fallback credit', () => {
    expect(scoreSearch({ items: [{ entity_id: 'wrong' }, { entity_id: 'wanted' }],
      mode_used: 'semantic' }, 'wanted').passes).toBe(true);
    expect(scoreSearch({ items: [{ entity_id: 'wanted' }], mode_used: 'keyword' }, 'wanted').passes).toBe(false);
    expect(scoreSearch({ items: Array.from({ length: 5 }, (_, index) => ({ entity_id: String(index) }))
      .concat({ entity_id: 'wanted' }), mode_used: 'semantic' }, 'wanted').passes).toBe(false);
  });

  it('fails the quality gate when a citation does not support its claim', () => {
    const truth = { status: 'answered', citations: [{ file_name: 'case.pdf', page: 2,
      quote: 'Mira Chen works at Helio Works.' }], facts: [{ predicate: 'worksFor',
        subject: 'Mira Chen', object: 'Helio Works' }] } as const;
    expect(scoreAnswer({ status: 'answered', answer: 'Mira Chen works at Helio Works.',
      citations: [{ evidence_id: 'missing', file_name: 'case.pdf', page: 1,
        quote: 'not in the document' }], facts: [{ subject_id: 'mira', predicate: 'worksFor',
          object: 'Helio Works', evidence_id: 'missing' }] }, truth).passes).toBe(false);
    expect(scoreAnswer({ status: 'answered', answer: 'Mira Chen works at Helio Works.',
      citations: [{ evidence_id: 'ev-1', file_name: 'case.pdf', page: 2,
        quote: 'Mira Chen works at Helio Works.' }], facts: [{ subject_id: 'mira', predicate: 'worksFor',
          object: 'Helio Works', evidence_id: 'ev-1' }] }, truth).passes).toBe(true);
    expect(scoreAnswer({ status: 'answered', answer: 'Mira Chen works at Helio Works.',
      citations: [{ evidence_id: 'ev-2', file_name: 'case.pdf', page: 2, quote: 'Mira Chen' }],
      facts: [{ subject_id: 'mira', predicate: 'worksFor', object: 'Helio Works', evidence_id: 'ev-2' }] },
    truth).passes).toBe(false);
    expect(scoreAnswer({ status: 'answered', answer: 'Mira Chen works at Helio Works.',
      citations: [{ evidence_id: 'fabricated-id', file_name: 'case.pdf', page: 2,
        quote: 'Mira Chen works at Helio Works.' }], facts: [{ subject_id: 'mira', predicate: 'worksFor',
          object: 'Helio Works', evidence_id: 'fabricated-id' }] },
    { ...truth, allowedEvidenceIds: ['ev-1'] }).passes).toBe(false);
  });

  it('requires all gates, including exact answer statuses and zero fabrication', () => {
    expect(summarizeQuality({ tp: 95, fp: 5, fn: 10 },
      Array.from({ length: 10 }, () => ({ passes: true })),
      Array.from({ length: 10 }, () => ({ passes: true, fabricatedCitations: 0 })), 0)).toMatchObject({
      passes: true, precision: 0.95, recall: expect.any(Number), semanticTop5: 10,
    });
    expect(summarizeQuality({ tp: 95, fp: 5, fn: 10 },
      Array.from({ length: 10 }, (_, i) => ({ passes: i < 8 })),
      Array.from({ length: 10 }, () => ({ passes: true, fabricatedCitations: 0 })), 0).passes).toBe(false);
  });

  it('pins exactly twelve synthetic files and ten search and answer cases', () => {
    const dataset = JSON.parse(readFileSync(fixtures, 'utf8')) as {
      documents: Array<{ file: string; kind: string }>; semantic: unknown[]; answers: unknown[];
    };
    expect(dataset.documents).toHaveLength(12);
    expect(dataset.semantic).toHaveLength(10);
    expect(dataset.answers).toHaveLength(10);
    expect(dataset.documents.reduce<Record<string, number>>((counts, document) => {
      counts[document.kind] = (counts[document.kind] ?? 0) + 1;
      expect(readFileSync(fileURLToPath(new URL(`./fixtures/contact-documents/${document.file}`, import.meta.url))).length)
        .toBeGreaterThan(100);
      return counts;
    }, {})).toEqual({ text_pdf: 4, scanned_pdf: 4, image: 4 });
  });
});
