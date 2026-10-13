import { z } from 'zod';
import { UtcTimestampSchema } from './identity.js';

const text = z.string().trim().min(1);
const httpUrl = z.url().refine(value => /^https?:\/\//u.test(value), 'Expected an absolute HTTP(S) URL');
const textArray = z.array(text).default([]).transform(values => [...new Set(values)]);
const urlArray = z.array(httpUrl).default([]).transform(values => [...new Set(values)]);

function dateInterval(value: string): [number, number] {
  const [year, month, day] = value.split('-').map(Number);
  const firstDate = new Date(0);
  firstDate.setUTCFullYear(year!, (month ?? 1) - 1, day ?? 1);
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year!, month ?? 12, 0);
  const lastDate = new Date(0);
  lastDate.setUTCFullYear(year!, (month ?? 12) - 1, day ?? lastDay.getUTCDate());
  const first = firstDate.getTime();
  const last = lastDate.getTime();
  return [first, last];
}

export const PartialDateSchema = z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u)
  .refine(value => {
    const [year, month, day] = value.split('-').map(Number);
    if (!year || (month !== undefined && (month < 1 || month > 12))) return false;
    if (day === undefined) return true;
    const lastDay = new Date(0);
    lastDay.setUTCFullYear(year!, month!, 0);
    return day >= 1 && day <= lastDay.getUTCDate();
  }, 'Expected a valid YYYY, YYYY-MM or YYYY-MM-DD date');

const CountrySchema = z.object({ '@type': z.literal('Country'), name: text }).strict();
const PlaceSchema = z.object({ '@type': z.literal('Place'), name: text, address: text.optional() }).strict();
const OccupationSchema = z.object({
  '@type': z.literal('Occupation'), name: text, description: text.optional(),
}).strict();
const CredentialSchema = z.object({
  '@type': z.literal('EducationalOccupationalCredential'), name: text,
  credentialCategory: text.optional(), educationalLevel: text.optional(),
  description: text.optional(), url: httpUrl.optional(),
}).strict();
const ContactPointSchema = z.object({
  '@type': z.literal('ContactPoint'), contactType: text,
  telephone: textArray, email: textArray, url: httpUrl.optional(),
}).strict().refine(value => value.telephone.length > 0 || value.email.length > 0 || value.url !== undefined,
  'ContactPoint needs a telephone, email or URL');
const IdentifierSchema = z.object({
  '@type': z.literal('PropertyValue'), propertyID: text, value: text,
}).strict();

function uniqueObjects<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const commonProperties = {
  name: text,
  alternateName: textArray,
  description: text.optional(),
  telephone: textArray,
  email: textArray,
  address: text.optional(),
  url: httpUrl.optional(),
  sameAs: urlArray,
};

const PersonPropertiesBaseSchema = z.object({
  ...commonProperties,
  jobTitle: text.optional(),
  skills: textArray,
  givenName: text.optional(),
  familyName: text.optional(),
  additionalName: text.optional(),
  honorificPrefix: text.optional(),
  honorificSuffix: text.optional(),
  birthDate: PartialDateSchema.optional(),
  deathDate: PartialDateSchema.optional(),
  gender: text.optional(),
  nationality: z.array(CountrySchema).default([]).transform(uniqueObjects),
  birthPlace: PlaceSchema.optional(),
  homeLocation: PlaceSchema.optional(),
  workLocation: z.array(PlaceSchema).default([]).transform(uniqueObjects),
  knowsAbout: textArray,
  knowsLanguage: textArray,
  award: textArray,
  hasOccupation: z.array(OccupationSchema).default([]).transform(uniqueObjects),
  hasCredential: z.array(CredentialSchema).default([]).transform(uniqueObjects),
  contactPoint: z.array(ContactPointSchema).default([]).transform(uniqueObjects),
  faxNumber: textArray,
  image: httpUrl.optional(),
  disambiguatingDescription: text.optional(),
}).strict();

function validateLifeDates(value: { birthDate?: string; deathDate?: string }, context: z.RefinementCtx): void {
  if (value.birthDate && value.deathDate && dateInterval(value.birthDate)[0] > dateInterval(value.deathDate)[1]) {
    context.addIssue({ code: 'custom', path: ['deathDate'], message: 'Death date precedes birth date' });
  }
}

export const PersonPropertiesSchema = PersonPropertiesBaseSchema.partial({ name: true }).superRefine(validateLifeDates);
export const PersonCandidatePropertiesSchema = PersonPropertiesSchema;

export const OrganizationPropertiesSchema = z.object({
  ...commonProperties,
  legalName: text.optional(),
  identifier: z.array(IdentifierSchema).default([]).transform(uniqueObjects),
}).strict();

export const ProjectCandidatePropertiesSchema = z.object({
  name: text.optional(), description: text.optional(),
}).strict();
export const ProjectPropertiesSchema = ProjectCandidatePropertiesSchema.refine(
  value => Boolean(value.name || value.description), 'Project needs a name or description');

const InstantMessagingSchema = z.object({
  platform: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
  accountId: text,
  label: text.optional(),
}).strict();

export const PersonExtensionsSchema = z.object({
  nativePlace: text.optional(),
  hobbies: textArray,
  maritalStatus: z.object({
    status: z.enum(['never_married', 'married', 'divorced', 'widowed', 'other']),
    asOf: PartialDateSchema.optional(),
  }).strict().optional(),
  instantMessaging: z.array(InstantMessagingSchema).default([]).superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const key = `${value.platform}\0${value.accountId}`;
      if (seen.has(key)) context.addIssue({ code: 'custom', path: [index], message: 'Duplicate account' });
      seen.add(key);
    });
  }),
}).strict();

export const ContactMetadataSchema = z.object({
  version: z.int().positive(),
  created_at: UtcTimestampSchema,
  updated_at: UtcTimestampSchema,
  archived_at: UtcTimestampSchema.optional(),
  merged_into: text.optional(),
}).strict();

export const ContactEntitySchema = z.discriminatedUnion('label', [
  z.object({
    entity_id: text, label: z.literal('Person'), properties: PersonPropertiesSchema,
    extensions: PersonExtensionsSchema.default({ hobbies: [], instantMessaging: [] }),
    metadata: ContactMetadataSchema,
  }).strict(),
  z.object({
    entity_id: text, label: z.literal('Organization'), properties: OrganizationPropertiesSchema,
    metadata: ContactMetadataSchema,
  }).strict(),
  z.object({
    entity_id: text, label: z.literal('Project'), properties: ProjectPropertiesSchema,
    metadata: ContactMetadataSchema,
  }).strict(),
]);

export const ContactRelationTypeSchema = z.enum([
  'worksFor', 'alumniOf', 'affiliation', 'memberOf', 'clientOrganization', 'colleague', 'spouse', 'parent', 'children',
]);
export type ContactRelationType = z.infer<typeof ContactRelationTypeSchema>;

const OrganizationRoleSchema = z.object({
  '@type': z.literal('OrganizationRole'),
  roleName: text.optional(), startDate: PartialDateSchema.optional(), endDate: PartialDateSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.startDate && value.endDate && dateInterval(value.startDate)[0] > dateInterval(value.endDate)[1]) {
    context.addIssue({ code: 'custom', path: ['endDate'], message: 'End date precedes start date' });
  }
});

const RelationMetadataSchema = ContactMetadataSchema.omit({ merged_into: true });
const WorksForMetadataSchema = RelationMetadataSchema.extend({
  employment_status: z.enum(['current', 'ended', 'unknown']).default('unknown'),
  status_as_of: PartialDateSchema.optional(),
}).superRefine((value, context) => {
  if (value.employment_status === 'current' && (!value.status_as_of || value.status_as_of.length !== 10)) {
    context.addIssue({ code: 'custom', path: ['status_as_of'], message: 'Current status needs a full as-of date' });
  }
});

const relationBase = {
  relation_id: text, source_id: text, target_id: text,
};

export const EducationPropertiesSchema = z.object({
  major: text.optional(), educationLevel: text.optional(),
  startDate: PartialDateSchema.optional(), endDate: PartialDateSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.startDate && value.endDate && dateInterval(value.startDate)[0] > dateInterval(value.endDate)[1]) {
    context.addIssue({ code: 'custom', path: ['endDate'], message: 'Education endDate precedes startDate' });
  }
});

export const ContactRelationSchema = z.union([
  z.object({
    ...relationBase, relation_type: z.literal('worksFor'),
    properties: z.object({ role: OrganizationRoleSchema }).strict(),
    metadata: WorksForMetadataSchema,
  }).strict().superRefine((value, context) => {
    if (value.metadata.employment_status === 'current' && value.properties.role.endDate) {
      context.addIssue({ code: 'custom', path: ['properties', 'role', 'endDate'], message: 'Current employment cannot have endDate' });
    }
  }),
  z.object({
    ...relationBase, relation_type: z.literal('alumniOf'),
    properties: EducationPropertiesSchema, metadata: RelationMetadataSchema,
  }).strict(),
  z.object({
    ...relationBase, relation_type: z.enum(['affiliation', 'memberOf', 'colleague', 'spouse', 'parent', 'children']),
    properties: z.object({}).strict(), metadata: RelationMetadataSchema,
  }).strict(),
  z.object({
    ...relationBase, relation_type: z.literal('memberOf'),
    properties: z.object({ role: OrganizationRoleSchema }).strict(), metadata: RelationMetadataSchema,
  }).strict(),
  z.object({
    ...relationBase, relation_type: z.literal('clientOrganization'),
    properties: z.object({}).strict(), metadata: RelationMetadataSchema,
  }).strict(),
]);

export function normalizeRelationEndpoints<T extends {
  relation_type: ContactRelationType; source_id: string; target_id: string; properties: unknown;
}>(relation: T, sourceLabel: 'Person' | 'Organization' | 'Project', targetLabel: 'Person' | 'Organization' | 'Project'): T {
  if (relation.source_id === relation.target_id) throw new Error('Self relations are not allowed');
  const valid = relation.relation_type === 'clientOrganization'
    ? sourceLabel === 'Project' && targetLabel === 'Organization'
    : relation.relation_type === 'memberOf'
      ? sourceLabel === 'Person' && (targetLabel === 'Organization' || targetLabel === 'Project')
        && (targetLabel === 'Project' || !Object.hasOwn(relation.properties ?? {}, 'role'))
      : sourceLabel === 'Person' && targetLabel === (
        ['worksFor', 'alumniOf', 'affiliation'].includes(relation.relation_type) ? 'Organization' : 'Person');
  if (!valid) {
    throw new Error('Invalid relation endpoint labels');
  }
  if (relation.relation_type === 'children') {
    return { ...relation, relation_type: 'parent', source_id: relation.target_id, target_id: relation.source_id };
  }
  if ((relation.relation_type === 'spouse' || relation.relation_type === 'colleague')
      && relation.source_id > relation.target_id) {
    return { ...relation, source_id: relation.target_id, target_id: relation.source_id };
  }
  return relation;
}

const propertyFields = new Set([
  'name', 'alternateName', 'description', 'telephone', 'email', 'address', 'url', 'sameAs',
  'jobTitle', 'skills', 'legalName', 'identifier', 'givenName', 'familyName', 'additionalName',
  'honorificPrefix', 'honorificSuffix', 'birthDate', 'deathDate', 'gender', 'nationality',
  'birthPlace', 'homeLocation', 'workLocation', 'knowsAbout', 'knowsLanguage', 'award',
  'hasOccupation', 'hasCredential', 'contactPoint', 'faxNumber', 'image', 'disambiguatingDescription',
]);
const evidenceField = z.string().refine(value => value === '$relation'
  || /^properties\.(major|educationLevel|startDate|endDate)$/u.test(value)
  || /^properties\.role\.(roleName|startDate|endDate)$/u.test(value)
  || (value.startsWith('properties.') && propertyFields.has(value.slice('properties.'.length)))
  || /^extensions\.(nativePlace|hobbies|maritalStatus|instantMessaging)$/u.test(value)
  || /^metadata\.(employment_status|status_as_of)$/u.test(value), 'Invalid evidence field path');

export const ContactEvidenceSchema = z.object({
  evidence_id: text,
  subject_kind: z.enum(['entity', 'relation']),
  subject_id: text,
  field_path: evidenceField,
  value: z.unknown().refine(value => value !== undefined && value !== null),
  value_path: text.optional(),
  source_type: z.enum(['file', 'web', 'manual', 'text', 'zoho']),
  source_connection_id: text.optional(),
  source_module: z.enum(['Accounts', 'Contacts']).optional(),
  source_record_id: text.optional(),
  file_name: text.optional(), file_sha256: text.optional(), source_url: httpUrl.optional(),
  text_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  quote: text.optional(), page: z.int().positive().optional(),
  locator_status: z.enum(['located', 'unavailable', 'not_applicable']),
  collected_at: UtcTimestampSchema,
  confirmed_by: text.optional(), confirmed_at: UtcTimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.source_type === 'zoho') {
    if (!value.source_connection_id || !value.source_module || !value.source_record_id
      || value.locator_status !== 'not_applicable'
      || value.file_name !== undefined || value.file_sha256 !== undefined
      || value.text_sha256 !== undefined || value.page !== undefined || value.quote !== undefined) {
      context.addIssue({ code: 'custom', message: 'Zoho evidence requires a CRM record locator without document metadata' });
    }
  } else if (value.source_connection_id !== undefined || value.source_module !== undefined || value.source_record_id !== undefined) {
    context.addIssue({ code: 'custom', message: 'CRM record locators require Zoho evidence' });
  }
  if (value.subject_kind === 'entity' && (value.field_path === '$relation'
    || /^properties\.(major|educationLevel|startDate|endDate)$/u.test(value.field_path)
    || value.field_path.startsWith('properties.role.')
    || value.field_path.startsWith('metadata.'))) {
    context.addIssue({ code: 'custom', message: 'Relation evidence path requires a relation subject' });
  }
  if (value.subject_kind === 'relation' && value.field_path !== '$relation'
    && !/^properties\.(major|educationLevel|startDate|endDate)$/u.test(value.field_path)
    && !value.field_path.startsWith('properties.role.')
    && !value.field_path.startsWith('metadata.')) {
    context.addIssue({ code: 'custom', message: 'Entity evidence path requires an entity subject' });
  }
  if (value.source_type === 'file' && (!value.file_name || !value.file_sha256)) {
    context.addIssue({ code: 'custom', message: 'File evidence requires file name and SHA-256' });
  }
  if (value.source_type === 'web' && !value.source_url) {
    context.addIssue({ code: 'custom', message: 'Web evidence requires source URL' });
  }
  if (value.source_type === 'manual' && value.locator_status !== 'not_applicable') {
    context.addIssue({ code: 'custom', message: 'Manual evidence has no document locator' });
  }
  if (value.source_type === 'text' && (!value.text_sha256 || !value.quote?.trim()
    || [...value.quote].length > 500 || value.locator_status !== 'located'
    || value.page !== undefined || value.file_name !== undefined || value.file_sha256 !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Text evidence requires a content hash and located quote, without file/page metadata' });
  }
});

export const ParsedBlockSchema = z.object({
  block_id: text, text, page: z.int().positive().optional(), source_ref: text.optional(),
  layout_label: text.optional(),
}).strict();

export type ContactEntity = z.infer<typeof ContactEntitySchema>;
export type ContactRelation = z.infer<typeof ContactRelationSchema>;
export type ContactEvidence = z.infer<typeof ContactEvidenceSchema>;
export type ParsedBlock = z.infer<typeof ParsedBlockSchema>;
