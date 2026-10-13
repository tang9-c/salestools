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
  ProjectPropertiesSchema,
  normalizeRelationEndpoints,
  parseStoredContactEvidence,
} from '../src/contracts/contact-graph.js';
import { ImportCandidateSchema } from '../src/contracts/contact-import.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/contact-contracts/${name}.json`, import.meta.url), 'utf8'));
}

describe('shared contact graph contract', () => {
  const zohoProof = { evidence_id: 'ev_crm', subject_kind: 'entity', subject_id: 'p_crm',
    field_path: 'properties.name', value: 'CRM Person', source_type: 'zoho',
    source_connection_id: 'connection-a', source_module: 'Contacts', source_record_id: 'contact-a',
    locator_status: 'not_applicable', collected_at: '2026-10-13T00:00:00.000Z' };

  it('accepts located Zoho records without inventing a source URL', () => {
    expect(ContactEvidenceSchema.safeParse(zohoProof).success).toBe(true);
    expect(ContactEvidenceSchema.safeParse({ ...zohoProof, source_module: 'Accounts' }).success).toBe(true);
    expect(ContactEvidenceSchema.safeParse({ ...zohoProof, subject_kind: 'relation',
      subject_id: 'r_crm', field_path: 'properties.role.roleName', value: '经理' }).success).toBe(true);
  });

  it.each(['https://crm.example.test/Contacts/contact-a', 'https://[broken'])('rejects source_url on Zoho evidence even for %s', source_url => {
    expect(ContactEvidenceSchema.safeParse({ ...zohoProof, source_url }).success).toBe(false);
  });

  it('preserves the existing HTTP URL contract for web evidence', () => {
    const proof = { evidence_id: 'ev_web', subject_kind: 'entity', subject_id: 'p_web',
      field_path: 'properties.name', value: 'Web Person', source_type: 'web',
      locator_status: 'located', quote: 'Web Person', collected_at: '2026-10-13T00:00:00.000Z' };
    expect(ContactEvidenceSchema.safeParse({ ...proof, source_url: 'https://example.test/person' }).success).toBe(true);
    expect(ContactEvidenceSchema.safeParse({ ...proof, source_url: 'https://[broken' }).success).toBe(false);
  });

  it('reads prior CRM proof without mutating its ID or source while keeping new input strict', () => {
    const prior = { ...zohoProof, source_url: 'https://crm.example.test/Contacts/contact-a' };
    const parsed = parseStoredContactEvidence(prior);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected stored CRM proof');
    expect(parsed.data).toEqual(zohoProof);
    expect(prior.source_url).toBe('https://crm.example.test/Contacts/contact-a');
    expect(ContactEvidenceSchema.safeParse(prior).success).toBe(false);
    expect(parseStoredContactEvidence({ ...prior, source_record_id: ' ' }).success).toBe(false);
    expect(parseStoredContactEvidence({ ...prior, email: 'private@example.test' }).success).toBe(false);
    const web = { ...zohoProof, source_type: 'web', locator_status: 'located',
      source_connection_id: undefined, source_module: undefined, source_record_id: undefined,
      source_url: 'https://example.test/person', quote: 'CRM Person' };
    expect(parseStoredContactEvidence(web)).toEqual(ContactEvidenceSchema.safeParse(web));
  });

  it('rejects missing or invalid Zoho locators and unapproved source fields', () => {
    for (const key of ['source_connection_id', 'source_module', 'source_record_id']) {
      for (const invalid of [undefined, '', ' ']) {
        expect(ContactEvidenceSchema.safeParse({ ...zohoProof, [key]: invalid }).success).toBe(false);
      }
    }
    for (const extra of [{ source_module: 'Leads' }, { source_type: 'crm' },
      { source_url: 'zoho://Contacts/contact-a' }, { email: 'private@example.test' },
      { phone: '123' }, { source_owner: 'owner' }]) {
      expect(ContactEvidenceSchema.safeParse({ ...zohoProof, ...extra }).success).toBe(false);
    }
    expect(ContactEvidenceSchema.safeParse({ ...zohoProof, source_type: 'manual' }).success).toBe(false);
  });

  it('requires a located quote and content hash for pasted-text evidence', () => {
    const proof = { evidence_id: 'ev_text', subject_kind: 'entity', subject_id: 'p_1',
      field_path: 'properties.name', value: '林知远', source_type: 'text', text_sha256: 'a'.repeat(64),
      quote: '林知远', locator_status: 'located', collected_at: '2026-10-11T00:00:00.000Z' };
    expect(ContactEvidenceSchema.safeParse(proof).success).toBe(true);
    expect(ContactEvidenceSchema.safeParse({ ...proof, text_sha256: undefined }).success).toBe(false);
    expect(ContactEvidenceSchema.safeParse({ ...proof, quote: undefined }).success).toBe(false);
    expect(ContactEvidenceSchema.safeParse({ ...proof, locator_status: 'not_applicable' }).success).toBe(false);
    expect(ContactEvidenceSchema.safeParse({ ...proof, page: 1 }).success).toBe(false);
  });
  it('keeps personal education details on alumniOf rather than the school', () => {
    const base = { relation_id: 'r_education', source_id: 'p_1', target_id: 'o_1', relation_type: 'alumniOf',
      metadata: { version: 1, created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:00:00.000Z' } };
    expect(ContactRelationSchema.safeParse({ ...base, properties: { major: '软件工程', educationLevel: '本科', startDate: '2022', endDate: '2026' } }).success).toBe(true);
    expect(ContactRelationSchema.safeParse({ ...base, properties: {} }).success).toBe(true);
    expect(ContactRelationSchema.safeParse({ ...base, properties: { startDate: '2026', endDate: '2022' } }).success).toBe(false);
    expect(ContactRelationSchema.safeParse({ ...base, properties: { degreeAwarded: true } }).success).toBe(false);
    expect(OrganizationPropertiesSchema.safeParse({ name: '井冈山大学', major: '软件工程' }).success).toBe(false);
  });
  it('accepts old parsed blocks and optional Docling layout labels', () => {
    expect(ParsedBlockSchema.parse({ block_id: 'b1', text: '教育背景' }).text).toBe('教育背景');
    expect(ParsedBlockSchema.parse({ block_id: 'b2', text: '海岚大学', layout_label: 'text' }).layout_label).toBe('text');
  });
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

  it('accepts a documented Project and only its typed project path', () => {
    const metadata = { version: 1, created_at: '2026-09-26T00:00:00.000Z', updated_at: '2026-09-26T00:00:00.000Z' };
    expect(ContactEntitySchema.safeParse({ entity_id: 'j_1', label: 'Project', properties: { name: 'PLM 升级' }, metadata }).success).toBe(true);
    expect(ContactEntitySchema.safeParse({ entity_id: 'j_2', label: 'Project', properties: { description: '制造业系统升级' }, metadata }).success).toBe(true);
    expect(ProjectPropertiesSchema.safeParse({}).success).toBe(false);
    expect(ProjectPropertiesSchema.safeParse({ name: '项目', jobTitle: '顾问' }).success).toBe(false);
    expect(ImportCandidateSchema.safeParse({ candidate_id: 'j', label: 'Project', properties: { description: '系统升级' }, evidence: [], relation_suggestions: [], warnings: [], can_commit: true }).success).toBe(true);
    expect(ImportCandidateSchema.safeParse({ candidate_id: 'j', label: 'Project', properties: {}, evidence: [], relation_suggestions: [], warnings: [], can_commit: true }).success).toBe(false);
    const participation = { relation_id: 'r_1', source_id: 'p_1', target_id: 'j_1', relation_type: 'memberOf' as const, properties: { role: { '@type': 'OrganizationRole', roleName: '顾问' } }, metadata };
    const client = { relation_id: 'r_2', source_id: 'j_1', target_id: 'o_1', relation_type: 'clientOrganization' as const, properties: {}, metadata };
    expect(ContactRelationSchema.safeParse(participation).success).toBe(true);
    expect(ContactRelationSchema.safeParse(client).success).toBe(true);
    expect(normalizeRelationEndpoints(participation, 'Person', 'Project')).toEqual(participation);
    expect(normalizeRelationEndpoints(client, 'Project', 'Organization')).toEqual(client);
    expect(() => normalizeRelationEndpoints(client, 'Person', 'Organization')).toThrow();
    expect(() => normalizeRelationEndpoints({ ...participation, relation_type: 'worksFor' as const }, 'Person', 'Project')).toThrow();
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
    expect(ContactEvidenceSchema.safeParse({
      evidence_id: 'ev_role', subject_kind: 'relation', subject_id: 'r_1',
      field_path: 'properties.role.roleName', value: '销售经理', source_type: 'file',
      file_name: 'resume.pdf', file_sha256: 'a'.repeat(64), quote: '销售经理', page: 2,
      collected_at: '2026-09-26T00:00:00.000Z', locator_status: 'located',
    }).success).toBe(true);
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

  it('keeps a nameless extraction candidate when its source is not verified', () => {
    const candidate = ImportCandidateSchema.parse({
      candidate_id: 'c_1', label: 'Person', properties: { jobTitle: '经理' },
      extensions: { hobbies: [], instantMessaging: [] }, evidence: [],
      relation_suggestions: [], warnings: ['name_missing'], can_commit: false,
    });
    expect(candidate.properties).not.toHaveProperty('name');
    expect(candidate.can_commit).toBe(false);
  });

  it('accepts bounded field and relation review items without promoting them to properties', () => {
    const base = {
      candidate_id: 'c_1', label: 'Person', properties: { name: '陈晓' },
      evidence: [], relation_suggestions: [], warnings: [], can_commit: true,
    };
    const field = { kind: 'field', field_path: 'properties.skills', value: 'Java',
      reason: 'missing_evidence', page: 1, quote: 'Java' };
    const relation = { kind: 'relation', source_candidate_id: 'c_1', target_candidate_id: 'c_2',
      relation_type: 'worksFor', properties: {}, reason: 'ambiguous_owner' };
    const candidate = ImportCandidateSchema.parse({ ...base, review_items: [field, relation] });
    expect(candidate.review_items).toEqual([field, relation]);
    if (candidate.label !== 'Person') throw new Error('expected Person');
    expect(candidate.properties.skills).toEqual([]);
    expect(ImportCandidateSchema.parse(base).review_items).toEqual([]);
    expect(ImportCandidateSchema.safeParse({ ...base,
      review_items: [{ ...field, quote: 'x'.repeat(501) }],
    }).success).toBe(false);
    expect(ImportCandidateSchema.safeParse({ ...base,
      review_items: [{ ...field, reason: 'invented' }],
    }).success).toBe(false);
    expect(ImportCandidateSchema.safeParse({ ...base,
      review_items: Array.from({ length: 101 }, () => field),
    }).success).toBe(false);
    expect(ImportCandidateSchema.safeParse({ ...base,
      review_items: [{ ...field, value: '中'.repeat(700) }],
    }).success).toBe(false);
    const { value: _missingValue, ...incompleteField } = field;
    expect(ImportCandidateSchema.safeParse({ ...base,
      review_items: [incompleteField],
    }).success).toBe(false);
  });

  it('allows a nameless Person record with substantive skills while Organization still needs a name', () => {
    const person = fixture('person-valid') as { label: string; properties: Record<string, unknown> };
    const { name: _ignored, ...properties } = person.properties;
    expect(ContactEntitySchema.safeParse({ ...person, properties: { ...properties, skills: ['Python'] } }).success).toBe(true);
    const organization = fixture('organization-valid') as { properties: Record<string, unknown> };
    const { name: _organizationName, ...organizationProperties } = organization.properties;
    expect(ContactEntitySchema.safeParse({ ...organization, properties: organizationProperties }).success).toBe(false);
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
