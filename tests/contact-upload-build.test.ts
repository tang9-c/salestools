import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';

// Do not build locally: substitute only esbuild's output and file I/O.
// Execute the real packaging script and evaluate the HTML's resulting script.
const fixture = vi.hoisted(() => ({ javascript: '', output: '' }));
vi.mock('esbuild', () => ({ build: async () => ({ outputFiles: [{ text: fixture.javascript }] }) }));
vi.mock('node:fs/promises', () => ({
  readFile: async () => '<!doctype html><html><body><!--SCRIPT--></body></html>',
  mkdir: async () => undefined,
  writeFile: async (_path: string, html: string) => { fixture.output = html; },
}));

it.each(['$`', "$'", '$&', '$$', '</script>'])('preserves bundled JavaScript containing %s', async marker => {
  fixture.javascript = `globalThis.marker = ${JSON.stringify(marker)};`;
  fixture.output = '';
  vi.resetModules();
  const packagingScript = '../scripts/build-contact-upload.mjs';
  await import(packagingScript);
  const javascript = /<script>([\s\S]*?)<\/script>/u.exec(fixture.output)?.[1];
  expect(javascript).toBeDefined();
  const context: Record<string, unknown> = {};
  new Script(javascript!).runInNewContext(context);
  expect(context.marker).toBe(marker);
  expect(fixture.output.match(/<!doctype html>/gu)).toHaveLength(1);
  expect(fixture.output.match(/<script>/gu)).toHaveLength(1);
});
