import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenService } from '../src/auth/token-service.js';
import { runTokenCli } from '../src/cli/tokens.js';
import { openDatabase } from '../src/db/database.js';
import { TokenRepository } from '../src/db/token-repository.js';

describe('TokenService', () => {
  let directory: string;
  let database: DatabaseSync;
  let repository: TokenRepository;
  let service: TokenService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'target-customer-auth-'));
    database = openDatabase(join(directory, 'service.sqlite'));
    repository = new TokenRepository(database);
    service = new TokenService(repository, () => new Date('2026-08-29T12:00:00.000Z'));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('returns a one-time 32-byte base64url token and stores only its SHA-256 hash', () => {
    const plaintext = service.create('user-1');
    const tokenHash = createHash('sha256').update(plaintext).digest('hex');

    expect(plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.findByHash(plaintext)).toBeNull();
    expect(repository.findByHash(tokenHash)).toMatchObject({ userId: 'user-1', enabled: true });
    expect(service.list()).toEqual([
      { userId: 'user-1', enabled: true, createdAt: '2026-08-29T12:00:00.000Z' },
    ]);
    expect(JSON.stringify(service.list())).not.toContain(tokenHash);
    expect(JSON.stringify(service.list())).not.toContain(plaintext);
  });

  it('verifies enabled tokens and rejects malformed, unknown, and disabled tokens', () => {
    const plaintext = service.create('user-1');

    expect(service.verify(plaintext)).toEqual({ userId: 'user-1' });
    expect(service.verify('not-a-token')).toBeNull();
    expect(service.verify('A'.repeat(43))).toBeNull();
    expect(service.disable('user-1')).toBe(true);
    expect(service.disable('user-1')).toBe(false);
    expect(service.verify(plaintext)).toBeNull();
  });
});

describe('token CLI parser', () => {
  it('accepts only the three documented command shapes and never lists secrets', () => {
    const writes: string[] = [];
    const fake = {
      create: (userId: string) => `plaintext-for-${userId}`,
      disable: (userId: string) => userId === 'user-1',
      list: () => [{ userId: 'user-1', enabled: true, createdAt: '2026-08-29T12:00:00.000Z' }],
    };

    expect(runTokenCli(['tokens:create', '--user', 'user-1'], fake, value => writes.push(value))).toBe(0);
    expect(writes).toEqual(['plaintext-for-user-1\n']);

    writes.length = 0;
    expect(runTokenCli(['tokens:list'], fake, value => writes.push(value))).toBe(0);
    expect(writes.join('')).toContain('user-1');
    expect(writes.join('')).not.toContain('plaintext');

    writes.length = 0;
    expect(runTokenCli(['tokens:disable', '--user', 'user-1'], fake, value => writes.push(value))).toBe(0);
    expect(writes.join('')).not.toContain('plaintext');
  });

  it.each([
    { args: [] },
    { args: ['tokens:create'] },
    { args: ['tokens:create', '--user'] },
    { args: ['tokens:create', '--user', 'user-1', 'extra'] },
    { args: ['tokens:disable', '--other', 'user-1'] },
    { args: ['tokens:list', '--user', 'user-1'] },
    { args: ['tokens:unknown'] },
  ])('returns non-zero for malformed arguments: $args', ({ args }) => {
    const fake = { create: () => 'secret', disable: () => true, list: () => [] };
    expect(runTokenCli(args, fake, () => undefined)).not.toBe(0);
  });
});
