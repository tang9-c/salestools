import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
it.each([undefined, 'production', 'development'])('default parser validates paths independently of NODE_ENV=%s', initial => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-entry-'));
  try {
    // No live sample or API call: exercise the same entrypoint in every environment.
    const code = `
      import { parseLocalDocument } from './src/contacts/document-worker.ts';
      globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
      const options = {pythonBin: ${JSON.stringify(join(root, 'python/.venv/bin/python'))},
        projectDir: ${JSON.stringify(join(root, 'python'))}, filePath: ${JSON.stringify(join(directory, 'missing.pdf'))},
        fileType: 'pdf', documentId: 'test', limits: {}, };
      const attempt = async () => {
        try { await parseLocalDocument(options, new AbortController().signal); return 'unexpected success'; }
        catch (error) { return error.message; }
      };
      const before = await attempt();
      await import('./tests/run-real-contact-acceptance.ts');
      const after = await attempt();
      process.stdout.write(JSON.stringify({before, after, environment: process.env.NODE_ENV}));
    `;
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: {PATH: '/usr/bin:/bin', ...(initial ? {NODE_ENV: initial} : {}),
        ACCEPTANCE_SAMPLE: '0', ACCEPTANCE_ENV: join(directory, 'absent.env')},
    });
    expect(JSON.parse(stdout)).toEqual({before: 'INVALID_PATH', after: 'INVALID_PATH', environment: 'test'});
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
