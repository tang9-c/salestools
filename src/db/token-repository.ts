import type { DatabaseSync } from 'node:sqlite';
import { UtcTimestampSchema } from '../contracts/identity.js';
import type { TokenIdentity } from '../auth/token-identity.js';

export interface TokenInput {
  userId: string; tokenHash: string; enabled: boolean; createdAt: string;
  identity?: TokenIdentity;
}
export interface TokenMetadata {
  userId: string; enabled: boolean; createdAt: string;
  email: string | null; crmConnectionId: string | null;
  crmOrgId: string | null; crmUserId: string | null; updatedAt: string;
}
export interface TokenRecord extends TokenMetadata { tokenHash: string }
interface TokenRow {
  user_id: string; token_hash: string; enabled: number; created_at: string;
  email: string | null; crm_connection_id: string | null;
  crm_org_id: string | null; crm_user_id: string | null; updated_at: string | null;
}
function toRecord(row: TokenRow): TokenRecord {
  return { userId: row.user_id, tokenHash: row.token_hash, enabled: row.enabled === 1,
    createdAt: row.created_at, email: row.email, crmConnectionId: row.crm_connection_id,
    crmOrgId: row.crm_org_id, crmUserId: row.crm_user_id, updatedAt: row.updated_at ?? row.created_at };
}
function metadata(row: TokenRow): TokenMetadata {
  const { tokenHash: _hash, ...result } = toRecord(row); return result;
}
function storageError(error: unknown): never {
  if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new Error('TOKEN_IDENTITY_CONFLICT');
  throw error;
}
export class TokenRepository {
  constructor(private readonly database: DatabaseSync) {}
  insert(input: TokenInput): void {
    UtcTimestampSchema.parse(input.createdAt);
    const i = input.identity;
    try {
      this.database.prepare(`INSERT INTO tokens
        (user_id,token_hash,enabled,created_at,email,crm_connection_id,crm_org_id,crm_user_id,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(input.userId,input.tokenHash,input.enabled?1:0,input.createdAt,
          i?.email ?? null,i?.crmConnectionId ?? null,i?.crmOrgId ?? null,i?.crmUserId ?? null,input.createdAt);
    } catch (error) { storageError(error); }
  }
  findByHash(hash: string): TokenRecord | null {
    const row = this.database.prepare('SELECT * FROM tokens WHERE token_hash=?').get(hash) as TokenRow | undefined;
    return row ? toRecord(row) : null;
  }
  findByUserId(userId: string): TokenRecord | null {
    const row = this.database.prepare('SELECT * FROM tokens WHERE user_id=?').get(userId) as TokenRow | undefined;
    return row ? toRecord(row) : null;
  }
  findByEmail(email: string): TokenRecord | null {
    const row = this.database.prepare('SELECT * FROM tokens WHERE email=?').get(email) as TokenRow | undefined;
    return row ? toRecord(row) : null;
  }
  setEnabled(userId: string, enabled: boolean, at: string): number {
    return Number(this.database.prepare('UPDATE tokens SET enabled=?,updated_at=? WHERE user_id=? AND enabled<>?')
      .run(enabled?1:0,at,userId,enabled?1:0).changes);
  }
  replaceHash(userId: string, hash: string, at: string): void {
    if (!this.database.prepare('UPDATE tokens SET token_hash=?,updated_at=? WHERE user_id=?').run(hash,at,userId).changes)
      throw new Error('TOKEN_USER_NOT_FOUND');
  }
  updateIdentity(expected: TokenRecord, identity: TokenIdentity, at: string): void {
    try {
      const result = this.database.prepare(`UPDATE tokens SET email=?,crm_connection_id=?,crm_org_id=?,crm_user_id=?,updated_at=?
        WHERE user_id=? AND token_hash=? AND enabled=? AND email IS ? AND crm_connection_id IS ?
          AND crm_org_id IS ? AND crm_user_id IS ? AND COALESCE(updated_at,created_at)=?`)
        .run(identity.email,identity.crmConnectionId,identity.crmOrgId,identity.crmUserId,at,
          expected.userId,expected.tokenHash,expected.enabled?1:0,expected.email,expected.crmConnectionId,
          expected.crmOrgId,expected.crmUserId,expected.updatedAt);
      if (!result.changes) throw new Error('TOKEN_IDENTITY_CHANGED');
    } catch (error) { storageError(error); }
  }
  listPage(offset: number, limit: number): { items: TokenMetadata[]; nextOffset: number | null } {
    if (!Number.isSafeInteger(offset) || offset<0 || offset>Number.MAX_SAFE_INTEGER-100 || !Number.isSafeInteger(limit) || limit<1 || limit>100)
      throw new Error('Invalid token pagination');
    const rows = this.database.prepare('SELECT * FROM tokens ORDER BY created_at,user_id LIMIT ? OFFSET ?').all(limit+1,offset) as unknown as TokenRow[];
    return { items:rows.slice(0,limit).map(metadata), nextOffset:rows.length>limit?offset+limit:null };
  }
  list(): TokenMetadata[] {
    return (this.database.prepare('SELECT * FROM tokens ORDER BY created_at,user_id').all() as unknown as TokenRow[]).map(metadata);
  }
}
