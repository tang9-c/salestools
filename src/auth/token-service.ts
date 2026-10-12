import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TokenMetadata, TokenRecord } from '../db/token-repository.js';

export interface AuthenticatedUser {
  userId: string;
}

export interface TokenStore {
  insert(input: {
    userId: string;
    tokenHash: string;
    enabled: boolean;
    createdAt: string;
  }): void;
  findByHash(tokenHash: string): TokenRecord | null;
  disableByUserId(userId: string): number;
  list(): TokenMetadata[];
  listPage?(offset: number, limit: number): { items: TokenMetadata[]; nextOffset: number | null };
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export class TokenService {
  constructor(
    private readonly repository: TokenStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(userId: string): string {
    const plaintext = randomBytes(32).toString('base64url');
    this.repository.insert({
      userId,
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
    return this.repository.disableByUserId(userId) > 0;
  }

  listPage(offset: number, limit: number): { items: TokenMetadata[]; nextOffset: number | null } {
    if (!this.repository.listPage) throw new Error('Token pagination unavailable');
    return this.repository.listPage(offset, limit);
  }

  list(): TokenMetadata[] {
    return this.repository.list();
  }
}
