import { z } from 'zod';

export const UserIdSchema = z.string().min(1).max(128)
  .refine(value => value === value.trim() && !/\p{C}/u.test(value));
export const EmailSchema = z.string().trim().toLowerCase().email().max(254);
export const CrmCodeSchema = z.enum(['qx', 'st']);
export const TokenIdentitySchema = z.object({
  email: EmailSchema,
  crmConnectionId: CrmCodeSchema,
  crmOrgId: z.string().regex(/^\d+$/),
  crmUserId: z.string().regex(/^\d+$/),
}).strict();
export type TokenIdentity = z.infer<typeof TokenIdentitySchema>;
