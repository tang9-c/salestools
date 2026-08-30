import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
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

describe('configured token CLI entry', () => {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const cliPath = join(projectRoot, 'src/cli/tokens.ts');
  const tsxPath = join(projectRoot, 'node_modules/.bin/tsx');
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'target-customer-cli-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function writeDotEnv(sqlitePath: string): void {
    writeFileSync(join(directory, '.env'), [
      'PUBLIC_MCP_HOST=mcp.example.cn',
      'ALLOWED_ORIGINS=https://codex.example.cn',
      `SQLITE_PATH=${sqlitePath}`,
      'QCC_MCP_COMPANY_URL=https://qcc.example.cn/company',
      'QCC_MCP_RISK_URL=https://qcc.example.cn/risk',
      'QCC_MCP_IPR_URL=https://qcc.example.cn/ipr',
      'QCC_MCP_OPERATION_URL=https://qcc.example.cn/operation',
      'QCC_API_KEY=test-qcc-key',
      'DOUBAO_SEARCH_API_URL=https://search.example.cn',
      'DOUBAO_SEARCH_API_KEY=test-search-key',
      'ARK_API_URL=https://ark.example.cn',
      'ARK_MODEL=test-model',
      'ARK_CREDENTIAL=test-credential',
    ].join('\n'));
  }

  function launch(extraEnv: NodeJS.ProcessEnv = {}) {
    return spawnSync(tsxPath, [cliPath, 'tokens:list'], {
      cwd: directory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...extraEnv },
    });
  }

  it('loads project-local .env when starting the real CLI process', () => {
    const dotenvDatabase = join(directory, 'dotenv.sqlite');
    writeDotEnv(dotenvDatabase);

    const result = launch();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('[]\n');
    expect(existsSync(dotenvDatabase)).toBe(true);
  });

  it('does not overwrite an explicitly supplied environment variable', () => {
    const dotenvDatabase = join(directory, 'dotenv.sqlite');
    const explicitDatabase = join(directory, 'explicit.sqlite');
    writeDotEnv(dotenvDatabase);

    const result = launch({ SQLITE_PATH: explicitDatabase });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(explicitDatabase)).toBe(true);
    expect(existsSync(dotenvDatabase)).toBe(false);
  });
});
