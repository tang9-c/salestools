import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ContactEntitySchema,
  ContactEvidenceSchema,
  ContactRelationSchema,
  OrganizationPropertiesSchema,
  ParsedBlockSchema,
  PersonExtensionsSchema,
  PersonPropertiesSchema,
  normalizeRelationEndpoints,
} from '../src/contracts/contact-graph.js';
import { ImportCandidateSchema } from '../src/contracts/contact-import.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/contact-contracts/${name}.json`, import.meta.url), 'utf8'));
}

describe('shared contact graph contract', () => {
  it('normalizes complete Person arrays and preserves two different WeChat accounts', () => {
    const person = ContactEntitySchema.parse(fixture('person-valid'));
    expect(person.label).toBe('Person');
    if (person.label !== 'Person') throw new Error('expected Person');
    expect(person.properties.name).toBe('陈晓');
    expect(person.properties.email).toEqual(['chen@example.com', 'chen.work@example.com']);
    expect(person.properties.skills).toEqual([]);
    expect(person.properties.nationality).toEqual([]);
    expect(person.extensions.instantMessaging).toHaveLength(2);
  });

  it('accepts organization identifiers but rejects a Person-only property on an Organization', () => {
    const organization = ContactEntitySchema.parse(fixture('organization-valid'));
    expect(organization.label).toBe('Organization');
    if (organization.label !== 'Organization') throw new Error('expected Organization');
    expect(organization.properties.identifier).toEqual([
      { '@type': 'PropertyValue', propertyID: 'CN-USCC', value: '91310000EXAMPLE' },
    ]);
    expect(ContactEntitySchema.safeParse({
      ...organization,
      properties: { ...organization.properties, gender: '女' },
    }).success).toBe(false);
  });

  it('rejects unknown business fields, nested keys and invalid dates', () => {
    expect(ContactEntitySchema.safeParse(fixture('person-invalid-unknown')).success).toBe(false);
    const person = fixture('person-valid') as { properties: Record<string, unknown> };
    expect(ContactEntitySchema.safeParse({
      ...person,
      properties: { ...person.properties, birthDate: '2026-02-30' },
    }).success).toBe(false);
    expect(ContactEntitySchema.safeParse({
      ...person,
      properties: { ...person.properties, birthPlace: { '@type': 'Place', name: '上海', invented: 'x' } },
    }).success).toBe(false);
  });

  it('keeps independent worksFor episodes and normalizes children direction', () => {
    const relation = ContactRelationSchema.parse(fixture('worksfor-valid'));
    expect(relation.relation_type).toBe('worksFor');
    const child = normalizeRelationEndpoints({
      relation_type: 'children', source_id: 'p_parent', target_id: 'p_child', properties: {},
    }, 'Person', 'Person');
    expect(child).toMatchObject({ relation_type: 'parent', source_id: 'p_child', target_id: 'p_parent' });
    const invalid = fixture('relation-invalid-endpoint') as {
      relation: Parameters<typeof normalizeRelationEndpoints>[0];
      source_label: 'Organization'; target_label: 'Person';
    };
    expect(() => normalizeRelationEndpoints(invalid.relation, invalid.source_label, invalid.target_label)).toThrow();
  });

  it('accepts value-specific evidence and rejects a malformed parsed block', () => {
    expect(ContactEvidenceSchema.parse({
      evidence_id: 'ev_1', subject_kind: 'entity', subject_id: 'p_1',
      field_path: 'properties.email', value: 'chen@example.com', source_type: 'manual',
      collected_at: '2026-09-26T00:00:00.000Z', confirmed_by: 'user-a',
      confirmed_at: '2026-09-26T00:00:00.000Z', locator_status: 'not_applicable',
    }).value).toBe('chen@example.com');
    expect(ParsedBlockSchema.parse(fixture('block-valid')).page).toBe(2);
    expect(ParsedBlockSchema.safeParse(fixture('block-invalid')).success).toBe(false);
  });

  it('rejects a birth interval wholly after the death interval', () => {
    const person = fixture('person-valid') as { properties: Record<string, unknown> };
    expect(ContactEntitySchema.safeParse({
      ...person,
      properties: { ...person.properties, birthDate: '2025', deathDate: '2024' },
    }).success).toBe(false);
  });

  it('rejects evidence paths for fields outside the whitelist', () => {
    expect(ContactEvidenceSchema.safeParse({
      evidence_id: 'ev_bad', subject_kind: 'entity', subject_id: 'p_1',
      field_path: 'properties.bio', value: 'invented', source_type: 'manual',
      collected_at: '2026-09-26T00:00:00.000Z', locator_status: 'not_applicable',
    }).success).toBe(false);
  });

  it('keeps a nameless extraction candidate but marks it not committable', () => {
    const candidate = ImportCandidateSchema.parse({
      candidate_id: 'c_1', label: 'Person', properties: { jobTitle: '经理' },
      extensions: { hobbies: [], instantMessaging: [] }, evidence: [],
      relation_suggestions: [], warnings: ['name_missing'], can_commit: false,
    });
    expect(candidate.properties).not.toHaveProperty('name');
    expect(ImportCandidateSchema.safeParse({ ...candidate, can_commit: true }).success).toBe(false);
  });
});

describe('shared cross-language cases', () => {
  const cases = fixture('cases') as Array<{
    id: string; entrypoint: string; input: unknown; expected_valid: boolean;
  }>;
  const schemas = {
    person_properties: PersonPropertiesSchema,
    organization_properties: OrganizationPropertiesSchema,
    person_extensions: PersonExtensionsSchema,
    relation: ContactRelationSchema,
    evidence: ContactEvidenceSchema,
    parsed_block: ParsedBlockSchema,
  } as const;
  it.each(cases)('$id', ({ entrypoint, input, expected_valid }) => {
    const schema = schemas[entrypoint as keyof typeof schemas];
    if (!schema) throw new Error(`Unsupported fixture entrypoint: ${entrypoint}`);
    expect(schema.safeParse(input).success).toBe(expected_valid);
  });
});
