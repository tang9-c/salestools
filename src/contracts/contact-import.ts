import { z } from 'zod';
import {
  ContactEvidenceSchema,
  ContactRelationTypeSchema,
  OrganizationPropertiesSchema,
  PersonCandidatePropertiesSchema,
  PersonExtensionsSchema,
} from './contact-graph.js';

const candidateText = z.string().trim().min(1);
const CandidateRelationSchema = z.object({
  source_candidate_id: candidateText,
  target_candidate_id: candidateText,
  relation_type: ContactRelationTypeSchema,
  properties: z.record(z.string(), z.unknown()),
  evidence: z.array(ContactEvidenceSchema).default([]),
  uncertain: z.boolean().default(false),
}).strict();

const candidateBase = {
  candidate_id: candidateText,
  evidence: z.array(ContactEvidenceSchema).default([]),
  relation_suggestions: z.array(CandidateRelationSchema).default([]),
  warnings: z.array(candidateText).default([]),
  can_commit: z.boolean(),
};

export const ImportCandidateSchema = z.discriminatedUnion('label', [
  z.object({
    ...candidateBase,
    label: z.literal('Person'),
    properties: PersonCandidatePropertiesSchema,
    extensions: PersonExtensionsSchema.default({ hobbies: [], instantMessaging: [] }),
  }).strict().superRefine((value, context) => {
    if (!value.properties.name && value.can_commit) {
      context.addIssue({ code: 'custom', path: ['can_commit'], message: 'Candidate without name is not committable' });
    }
  }),
  z.object({
    ...candidateBase,
    label: z.literal('Organization'),
    properties: OrganizationPropertiesSchema.extend({ name: candidateText.optional() }),
  }).strict().superRefine((value, context) => {
    if (!value.properties.name && value.can_commit) {
      context.addIssue({ code: 'custom', path: ['can_commit'], message: 'Candidate without name is not committable' });
    }
  }),
]);

export type ImportCandidate = z.infer<typeof ImportCandidateSchema>;
