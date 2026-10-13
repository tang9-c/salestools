import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const scriptPath = new URL('../scripts/patch-zoho-sdk.mjs', import.meta.url).href;
const { checkZohoSDK } = await import(scriptPath);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zoho-patch-test-'));
  const manifestPath = join(process.cwd(), 'patches/zoho-sdk-4.0.0.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sdk = join(root, 'node_modules/@zohocrm/nodejs-sdk-8.0');
  await mkdir(join(root, 'patches')); await copyFile(manifestPath, join(root, 'patches/zoho-sdk-4.0.0.json'));
  await mkdir(sdk, { recursive: true }); await writeFile(join(sdk, 'package.json'), '{"version":"4.0.0"}');
  for (const file of manifest.files) {
    let source = await readFile(join(process.cwd(), 'node_modules/@zohocrm/nodejs-sdk-8.0', file.path), 'utf8');
    for (const [from, to] of [...file.replacements].reverse()) source = source.replaceAll(to, from);
    await mkdir(dirname(join(sdk, file.path)), { recursive: true }); await writeFile(join(sdk, file.path), source);
  }
  return { root, sdk, manifest };
}
test('precise dependency patch is required, idempotent and rejects tampering without partial writes', async () => {
  const { root, sdk, manifest } = await fixture();
  try {
    await expect(checkZohoSDK(root)).rejects.toThrow('ZOHO_SDK_PATCH_REQUIRED');
    await checkZohoSDK(root, true); await checkZohoSDK(root); await checkZohoSDK(root, true);
    const first = join(sdk, manifest.files[0].path);
    const before = await readFile(first, 'utf8');
    await writeFile(first, before + '\n// drift');
    await expect(checkZohoSDK(root, true)).rejects.toThrow('ZOHO_SDK_PATCH_SOURCE_MISMATCH');
    await expect(checkZohoSDK(root)).rejects.toThrow('ZOHO_SDK_PATCH_SOURCE_MISMATCH');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('wrong SDK version and missing installation patch fail closed', async () => {
  const { root, sdk } = await fixture();
  try {
    await writeFile(join(sdk, 'package.json'), '{"version":"4.0.1"}');
    await expect(checkZohoSDK(root, true)).rejects.toThrow('ZOHO_SDK_PATCH_VERSION_MISMATCH');
    await expect(promisify(execFile)(process.execPath, [join(root, 'scripts/patch-zoho-sdk.mjs'), '--apply'])).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('SDK OFF logger leaves application default logger transports and output intact', async () => {
  const winstonPath = 'winston'; const sdkLoggerPath = '@zohocrm/nodejs-sdk-8.0/lib/routes/logger/sdk_logger.js'; const loggerPath = '@zohocrm/nodejs-sdk-8.0/lib/routes/logger/logger.js';
  const [{ default: winston }, { SDKLogger }, { Logger, Levels }] = await Promise.all([import(winstonPath), import(sdkLoggerPath), import(loggerPath)]);
  const originalTransports = [...winston.default.transports];
  const transport = new winston.transports.Console(); const output: string[] = [];
  transport.log = (info: { message: string }, callback: () => void) => { output.push(info.message); callback(); };
  winston.configure({ silent: false, level: 'info', transports: [transport] });
  try {
    SDKLogger.initialize(Logger.getInstance(Levels.OFF, null));
    winston.info('application-still-logs');
    expect(winston.default.transports).toContain(transport);
    expect(output).toEqual(['application-still-logs']);
    winston.loggers.get('salestools-zoho-sdk').info('SDK request Authorization synthetic-token');
    expect(output).toEqual(['application-still-logs']);
  } finally { winston.configure({ transports: originalTransports }); transport.destroy(); }
});
