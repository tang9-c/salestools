import type { DatabaseSync } from 'node:sqlite';
import { UtcTimestampSchema } from '../contracts/identity.js';

export interface TokenInput {
  userId: string;
  tokenHash: string;
  enabled: boolean;
  createdAt: string;
}

export interface TokenRecord extends TokenInput {}

export interface TokenMetadata {
  userId: string;
  enabled: boolean;
  createdAt: string;
}

interface TokenRow {
  user_id: string;
  token_hash: string;
  enabled: number;
  created_at: string;
}

function toRecord(row: TokenRow): TokenRecord {
  return {
    userId: row.user_id,
    tokenHash: row.token_hash,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export class TokenRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(input: TokenInput): void {
    UtcTimestampSchema.parse(input.createdAt);
    this.database.prepare(`
      INSERT INTO tokens (user_id, token_hash, enabled, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.userId, input.tokenHash, input.enabled ? 1 : 0, input.createdAt);
  }

  findByHash(tokenHash: string): TokenRecord | null {
    const row = this.database.prepare(`
      SELECT user_id, token_hash, enabled, created_at
      FROM tokens
      WHERE token_hash = ?
    `).get(tokenHash) as unknown as TokenRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  disableByUserId(userId: string): number {
    const result = this.database.prepare(`
      UPDATE tokens SET enabled = 0 WHERE user_id = ? AND enabled = 1
    `).run(userId);
    return Number(result.changes);
  }

  listPage(offset: number, limit: number): { items: TokenMetadata[]; nextOffset: number | null } {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - 100
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid token pagination');
    const rows = this.database.prepare(`
      SELECT user_id, enabled, created_at FROM tokens
      ORDER BY created_at, user_id, token_hash LIMIT ? OFFSET ?
    `).all(limit + 1, offset) as unknown as Pick<TokenRow, 'user_id' | 'enabled' | 'created_at'>[];
    return { items: rows.slice(0, limit).map(row => ({ userId: row.user_id,
      enabled: row.enabled === 1, createdAt: row.created_at })),
      nextOffset: rows.length > limit ? offset + limit : null };
  }

  list(): TokenMetadata[] {
    const rows = this.database.prepare(`
      SELECT user_id, token_hash, enabled, created_at
      FROM tokens
      ORDER BY created_at, user_id
    `).all() as unknown as TokenRow[];
    return rows.map(row => {
      const { tokenHash: _tokenHash, ...metadata } = toRecord(row);
      return metadata;
    });
  }
}
