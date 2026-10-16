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

export type CrmIdentityConnection = { id: string; name: string };
export function crmCodeForName(name: string): 'qx' | 'st' | undefined {
  const code = name.trim().toLowerCase();
  return code === 'qx' || code === 'st' ? code : undefined;
}
export function findCrmConnection<T extends CrmIdentityConnection>(connections: readonly T[], code: string): T | undefined {
  const matches = connections.filter(connection => crmCodeForName(connection.name) === code);
  return matches.length === 1 ? matches[0] : undefined;
}
