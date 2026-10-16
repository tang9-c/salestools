import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TokenMetadata, TokenRecord, TokenRepository } from '../db/token-repository.js';
import { TokenIdentitySchema, UserIdSchema, type TokenIdentity } from './token-identity.js';

export interface AuthenticatedUser {
  userId: string;
}

export type TokenStore = Pick<TokenRepository, 'insert' | 'findByHash' | 'findByUserId' | 'findByEmail' | 'setEnabled' | 'replaceHash' | 'updateIdentity' | 'list' | 'listPage'>;

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export class TokenService {
  constructor(
    private readonly repository: TokenStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(userId: string, identity: TokenIdentity): string {
    UserIdSchema.parse(userId);
    const checked = TokenIdentitySchema.parse(identity);
    const plaintext = randomBytes(32).toString('base64url');
    this.repository.insert({
      userId,
      identity: checked,
      tokenHash: hashToken(plaintext),
      enabled: true,
      createdAt: this.now().toISOString(),
    });
    return plaintext;
  }

  verify(plaintext: string): AuthenticatedUser | null {
    const candidateHash = hashToken(plaintext);
    const record = this.repository.findByHash(candidateHash);
    if (record === null || !record.enabled) return null;

    const stored = Buffer.from(record.tokenHash, 'hex');
    const candidate = Buffer.from(candidateHash, 'hex');
    if (stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) return null;
    return { userId: record.userId };
  }

  hash(plaintext: string): string {
    return hashToken(plaintext);
  }

  isEnabledHash(tokenHash: string, userId: string): boolean {
    const record = this.repository.findByHash(tokenHash);
    return record !== null && record.enabled && record.userId === userId;
  }

  disable(userId: string): boolean {
    return this.repository.setEnabled(userId, false, this.now().toISOString()) > 0;
  }

  enable(userId: string): boolean {
    return this.repository.setEnabled(userId, true, this.now().toISOString()) > 0;
  }

  rotate(userId: string): string {
    const plaintext = randomBytes(32).toString('base64url');
    this.repository.replaceHash(userId, hashToken(plaintext), this.now().toISOString());
    return plaintext;
  }

  get(userId: string): TokenMetadata | null {
    const record = this.repository.findByUserId(userId);
    if (!record) return null;
    const { tokenHash: _hash, ...metadata } = record; return metadata;
  }

  record(userId: string): TokenRecord | null { return this.repository.findByUserId(userId); }
  emailOwner(email: string): TokenRecord | null { return this.repository.findByEmail(email); }
  updateIdentity(expected: TokenRecord, identity: TokenIdentity): void {
    this.repository.updateIdentity(expected, TokenIdentitySchema.parse(identity), this.now().toISOString());
  }

  listPage(offset: number, limit: number): { items: TokenMetadata[]; nextOffset: number | null } {
    if (!this.repository.listPage) throw new Error('Token pagination unavailable');
    return this.repository.listPage(offset, limit);
  }

  list(): TokenMetadata[] {
    return this.repository.list();
  }
}
