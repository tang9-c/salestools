import { describe, expect, it } from 'vitest';
import { suggestMatches, normalizePhoneForSuggestion } from '../src/contacts/identity-match.js';
import { ContactEntitySchema, ContactEvidenceSchema, ImportCandidateSchema } from '../src/contracts/index.js';

const candidate = (name: string, telephone: string[], email: string[] = []) => ImportCandidateSchema.parse({
  candidate_id: 'c1', label: 'Person' as const, properties: { name, telephone, email },
  extensions: { hobbies: [], instantMessaging: [] }, evidence: [], relation_suggestions: [], warnings: [], can_commit: true,
});
const existing = (name: string, telephone: string[], contactPoint: object[] = []) => ContactEntitySchema.parse({
  entity_id: 'p1', label: 'Person' as const,
  properties: { name, telephone, contactPoint }, extensions: { hobbies: [], instantMessaging: [] },
  metadata: { version: 1, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z' },
});

describe('identity suggestions', () => {
  it('shows conflicting single values for review without changing either profile', () => {
    const incoming = candidate('陈晓', []), old = existing('陈晓', []);
    if (incoming.label !== 'Person' || old.label !== 'Person') throw new Error('Expected person fixture');
    incoming.properties.jobTitle = '经理'; old.properties.jobTitle = '工程师';
    const matches = suggestMatches(incoming, [old]);
    expect(matches[0].fieldDifferences).toEqual([{ fieldPath: 'properties.jobTitle',
      existingValue: '工程师', candidateValue: '经理' }]);
    expect(old.properties.jobTitle).toBe('工程师');
  });
  it('suggests possible rename on exact known-self phone without auto-merging or percentages', () => {
    const matches = suggestMatches(candidate('陈新', ['+86 (138) 0013-8000']), [existing('陈旧', ['+8613800138000'])]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ candidateName: '陈新', existingName: '陈旧', entityId: 'p1' });
    expect(JSON.stringify(matches)).not.toMatch(/probability|percent|merge/i);
  });

  it('excludes shared/assistant numbers and suffix-only or inferred country-code matches', () => {
    expect(suggestMatches(candidate('甲', ['13800138000']), [existing('乙', ['+8613800138000'])])).toEqual([]);
    expect(suggestMatches(candidate('甲', ['13800138000']), [existing('乙', [], [
      { '@type': 'ContactPoint', contactType: 'assistant', telephone: ['13800138000'], email: [] },
    ])])).toEqual([]);
    expect(normalizePhoneForSuggestion('+86 (138) 0013-8000')).toBe('+8613800138000');
  });

  it('suggests same names for review without treating them as the same person', () => {
    expect(suggestMatches(candidate('陈晓', []), [existing('陈晓', [])])[0].reasons)
      .toEqual([{ kind: 'same_name', value: '陈晓' }]);
  });

  it('uses name plus explicit shared organization as advice only', () => {
    const evidence = ContactEvidenceSchema.parse({ evidence_id: 'e1', subject_kind: 'entity', subject_id: 'p1',
      field_path: 'properties.name', value: '陈晓', source_type: 'file', file_name: 'older.pdf',
      file_sha256: 'a'.repeat(64), quote: '陈晓', page: 1, locator_status: 'located',
      collected_at: '2026-08-01T00:00:00.000Z' });
    const matches = suggestMatches(candidate('陈晓', []), [existing('陈晓', [])], {
      candidateOrganizations: [{ id: 'o1', name: '星辰科技' }], existingOrganizationsById: { p1: ['o1'] },
      existingEvidenceById: { p1: [evidence] },
    });
    expect(matches[0].reasons).toEqual([{ kind: 'name_with_organization', value: '星辰科技' }]);
    expect(matches[0].existingUpdatedAt).toBe('2026-09-20T00:00:00.000Z');
    expect(matches[0].existingSources).toEqual([{ sourceType: 'file', fileName: 'older.pdf', collectedAt: '2026-08-01T00:00:00.000Z' }]);
  });
  it('does not treat equally named but different organization nodes as the same employer', () => {
    const matches = suggestMatches(candidate('陈晓', []), [existing('陈晓', [])], {
      candidateOrganizations: [{ id: 'o1', name: '星辰科技' }], existingOrganizationsById: { p1: ['o2'] },
    });
    expect(matches[0].reasons).toEqual([{ kind: 'same_name', value: '陈晓' }]);
  });
});
