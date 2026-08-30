import { pathToFileURL } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { TokenRepository, type TokenMetadata } from '../db/token-repository.js';
import { TokenService } from '../auth/token-service.js';

export interface TokenCliService {
  create(userId: string): string;
  disable(userId: string): boolean;
  list(): TokenMetadata[];
}

type Write = (value: string) => void;

function userArgument(args: string[]): string | null {
  if (args.length !== 3 || args[1] !== '--user' || args[2].length === 0) return null;
  return args[2];
}

export function runTokenCli(args: string[], service: TokenCliService, write: Write): number {
  if (args.length === 1 && args[0] === 'tokens:list') {
    write(`${JSON.stringify(service.list())}\n`);
    return 0;
  }

  if (args[0] === 'tokens:create') {
    const userId = userArgument(args);
    if (userId === null) return 2;
    write(`${service.create(userId)}\n`);
    return 0;
  }

  if (args[0] === 'tokens:disable') {
    const userId = userArgument(args);
    if (userId === null) return 2;
    write(`${JSON.stringify({ userId, disabled: service.disable(userId) })}\n`);
    return 0;
  }

  return 2;
}

export function runConfiguredTokenCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  write: Write = value => process.stdout.write(value),
): number {
  const config = loadConfig(env);
  const database = openDatabase(config.sqlitePath);
  try {
    return runTokenCli(args, new TokenService(new TokenRepository(database)), write);
  } finally {
    database.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnv({ quiet: true });
  process.exitCode = runConfiguredTokenCli(process.argv.slice(2));
}
