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

  it('keeps same names separate without corroborating evidence', () => {
    expect(suggestMatches(candidate('陈晓', []), [existing('陈晓', [])])).toEqual([]);
  });

  it('uses name plus explicit shared organization as advice only', () => {
    const evidence = ContactEvidenceSchema.parse({ evidence_id: 'e1', subject_kind: 'entity', subject_id: 'p1',
      field_path: 'properties.name', value: '陈晓', source_type: 'file', file_name: 'older.pdf',
      file_sha256: 'a'.repeat(64), quote: '陈晓', page: 1, locator_status: 'located',
      collected_at: '2026-08-01T00:00:00.000Z' });
    const matches = suggestMatches(candidate('陈晓', []), [existing('陈晓', [])], {
      candidateOrganizations: ['星辰科技'], existingOrganizationsById: { p1: ['星辰科技'] },
      existingEvidenceById: { p1: [evidence] },
    });
    expect(matches[0].reasons).toEqual([{ kind: 'name_with_organization', value: '星辰科技' }]);
    expect(matches[0].existingUpdatedAt).toBe('2026-09-20T00:00:00.000Z');
    expect(matches[0].existingSources).toEqual([{ sourceType: 'file', fileName: 'older.pdf', collectedAt: '2026-08-01T00:00:00.000Z' }]);
  });
});
