import { z } from 'zod';

export const UtcTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  }, 'Expected a UTC timestamp emitted by Date.toISOString()');

export const IdentityProfileSchema = z.object({
  legalName: z.string(),
  creditCode: z.string(),
  formerNames: z.array(z.string()),
  aliases: z.array(z.string()),
  englishNames: z.array(z.string()),
  brands: z.array(z.string()),
  officialDomains: z.array(z.string()),
  registeredAddress: z.string().nullable(),
  parentLegalName: z.string().nullable(),
  subsidiaryLegalNames: z.array(z.string()),
}).strict();

export type IdentityProfile = z.infer<typeof IdentityProfileSchema>;
