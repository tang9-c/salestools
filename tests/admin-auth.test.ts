import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { verifyAdminKey } from '../src/auth/admin-auth.js';
import { TokenRepository } from '../src/db/token-repository.js';
import { SCHEMA_SQL } from '../src/db/schema.js';

it('uses an independent fixed-length admin secret', () => {
  const key = 'A'.repeat(43), hash = createHash('sha256').update(key).digest('hex');
  expect(verifyAdminKey(key, hash)).toBe(true);
  expect(verifyAdminKey('B'.repeat(43), hash)).toBe(false);
  expect(verifyAdminKey(key, '')).toBe(false);
  expect(verifyAdminKey('short', hash)).toBe(false);
});
it('paginates token metadata without disclosing hashes', () => {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL);
  try {
    const repo = new TokenRepository(db);
    for (const hash of ['b', 'a', 'c']) repo.insert({userId:'sales',tokenHash:hash.repeat(64),enabled:true,createdAt:'2026-10-11T00:00:00.000Z'});
    expect(repo.listPage(0, 2)).toEqual({items:repo.list().slice(0,2),nextOffset:2});
    expect(repo.listPage(2, 2)).toEqual({items:repo.list().slice(2),nextOffset:null});
    expect(JSON.stringify(repo.listPage(0, 2))).not.toContain('tokenHash');
    expect(() => repo.listPage(-1, 2)).toThrow();
    expect(() => repo.listPage(0, 101)).toThrow();
  } finally { db.close(); }
});
