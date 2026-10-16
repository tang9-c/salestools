import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { TokenRepository } from '../src/db/token-repository.js';
import { TokenService } from '../src/auth/token-service.js';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db); initializeDatabase(db);
  const repo = new TokenRepository(db);
  const service = new TokenService(repo, () => new Date('2026-10-16T00:00:00.000Z'));
  return { db, repo, service };
}
const identity = { email: 'sales@example.com', crmConnectionId: 'qx' as const, crmOrgId: '100', crmUserId: '9007199254740993123' };

it('keeps one token per user and one person per email, including disabled users', () => {
  const { service } = fixture();
  const token = service.create('sales', identity);
  expect(() => service.create('sales', { ...identity, email: 'other@example.com', crmUserId: '2' })).toThrow();
  service.disable('sales');
  expect(() => service.create('other', { ...identity, crmUserId: '2' })).toThrow();
  expect(service.verify(token)).toBeNull();
  expect(service.list()).toHaveLength(1);
  expect(service.list()[0]).toMatchObject(identity);
});

it('rotates a token without losing the binding or enabling a disabled user', () => {
  const { service } = fixture();
  const old = service.create('sales', identity);
  const replacement = service.rotate('sales');
  expect(service.verify(old)).toBeNull();
  expect(service.verify(replacement)).toEqual({ userId: 'sales' });
  service.disable('sales');
  const disabled = service.rotate('sales');
  expect(service.verify(disabled)).toBeNull();
  expect(service.enable('sales')).toBe(true);
  expect(service.verify(disabled)).toEqual({ userId: 'sales' });
  expect(service.list()[0]).toMatchObject(identity);
});

it('rejects incomplete identities, normalizes email and enforces CRM identity uniqueness', () => {
  const { service } = fixture();
  expect(() => service.create('missing', undefined as never)).toThrow();
  service.create('sales', { ...identity, email: ' Sales@Example.COM ' });
  expect(service.list()[0]).toMatchObject({ email: 'sales@example.com' });
  expect(() => service.create('other', { ...identity, email: 'other@example.com' })).toThrow();
});

it('migrates an old token without changing its hash and refuses duplicates before changing schema', () => {
  for (const duplicate of [false, true]) {
    const db = new DatabaseSync(':memory:'); databases.push(db);
    db.exec('CREATE TABLE tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL)');
    db.prepare('INSERT INTO tokens VALUES(?,?,?,?)').run('a'.repeat(64), 'legacy', 1, '2026-10-01T00:00:00.000Z');
    if (duplicate) db.prepare('INSERT INTO tokens VALUES(?,?,?,?)').run('b'.repeat(64), 'legacy', 1, '2026-10-02T00:00:00.000Z');
    if (duplicate) {
      expect(() => initializeDatabase(db)).toThrow('TOKEN_MIGRATION_DUPLICATE_USERS');
      expect(db.prepare('PRAGMA table_info(tokens)').all()).toHaveLength(4);
      expect(db.prepare('SELECT * FROM tokens').all()).toHaveLength(2);
    } else {
      initializeDatabase(db); initializeDatabase(db);
      expect(new TokenRepository(db).findByHash('a'.repeat(64))).toMatchObject({ userId: 'legacy', email: null, crmUserId: null });
      expect(() => db.prepare('INSERT INTO tokens(token_hash,user_id,enabled,created_at) VALUES(?,?,?,?)')
        .run('b'.repeat(64), 'legacy', 1, '2026-10-02T00:00:00.000Z')).toThrow();
    }
  }
});

it('rolls a failed legacy migration back to the original schema and records',()=>{
  const db=new DatabaseSync(':memory:');databases.push(db);
  db.exec('CREATE TABLE tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL)');
  db.prepare('INSERT INTO tokens VALUES(?,?,?,?)').run('a'.repeat(64),'legacy',2,'2026-10-01T00:00:00.000Z');
  expect(()=>initializeDatabase(db)).toThrow();
  expect(db.prepare('PRAGMA table_info(tokens)').all()).toHaveLength(4);
  expect(db.prepare('SELECT enabled FROM tokens').get()).toEqual({enabled:2});
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='tokens_legacy_identity'").get()).toBeUndefined();
});
