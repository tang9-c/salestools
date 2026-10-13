import { z } from 'zod';

export const ZohoConnectionIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/u);
export const ZohoRegionSchema = z.enum(['CN', 'US', 'EU', 'IN', 'AU', 'CA']);
export const ZohoConnectionSchema = z.object({
  id: ZohoConnectionIdSchema, name: z.string().trim().min(1), region: ZohoRegionSchema,
  clientId: z.string().trim().min(1), clientSecret: z.string().trim().min(1), refreshToken: z.string().trim().min(1),
}).strict();
export type ZohoConnection = z.infer<typeof ZohoConnectionSchema>;
export type ZohoQuery = {
  query: string;
  connectionIds?: string[];
  accountRecords?: Array<{ connectionId: string; accountId: string }>;
};

export const ZohoOwnerSchema = z.object({ id: z.string().nullable(), name: z.string().nullable() }).strict();
export const ZohoContactSchema = z.object({
  record_id: z.string().min(1), name: z.string().min(1), title: z.string().nullable(),
  contact_owner: ZohoOwnerSchema.nullable(), modified_at: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export const ZohoAccountCandidateSchema = z.object({
  account_id: z.string().min(1), company_name: z.string().min(1), account_owner: ZohoOwnerSchema.nullable(),
}).strict();
export const ZohoCompanySchema = ZohoAccountCandidateSchema.extend({
  connection_id: ZohoConnectionIdSchema, contacts: z.array(ZohoContactSchema),
}).strict();
export const ZohoStatusSchema = z.enum(['completed', 'needs_confirmation', 'partial', 'failed']);
export const ZohoConnectionStatusSchema = z.object({
  connection_id: ZohoConnectionIdSchema, name: z.string().min(1), status: ZohoStatusSchema,
  search_complete: z.boolean(), candidates: z.array(ZohoAccountCandidateSchema),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).nullable(),
}).strict();
export const ZohoContactsOutputSchema = z.object({
  status: ZohoStatusSchema, complete: z.boolean(), connections: z.array(ZohoConnectionStatusSchema),
  companies: z.array(ZohoCompanySchema), warnings: z.array(z.string()), collected_at: z.iso.datetime({ offset: true }),
}).strict();
export type ZohoOwner = z.infer<typeof ZohoOwnerSchema>;
export type ZohoContact = z.infer<typeof ZohoContactSchema>;
export type ZohoAccountCandidate = z.infer<typeof ZohoAccountCandidateSchema>;
export type ZohoCompany = z.infer<typeof ZohoCompanySchema>;
export type ZohoConnectionStatus = z.infer<typeof ZohoConnectionStatusSchema>;
export type ZohoContactsOutput = z.infer<typeof ZohoContactsOutputSchema>;
