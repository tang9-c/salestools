import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';

// Do not build locally: substitute only esbuild's output and file I/O.
// Execute the real packaging script and evaluate the HTML's resulting script.
const fixture = vi.hoisted(() => ({ javascript: '', outputs: new Map<string, string>() }));
vi.mock('esbuild', () => ({ build: async () => ({ outputFiles: [{ text: fixture.javascript }] }) }));
vi.mock('node:fs/promises', () => ({
  readFile: async () => '<!doctype html><html><body><!--SCRIPT--></body></html>',
  mkdir: async () => undefined,
  writeFile: async (path: string, html: string) => { fixture.outputs.set(path, html); },
}));

it.each(['$`', "$'", '$&', '$$', '</script>'])('preserves bundled JavaScript containing %s', async marker => {
  fixture.javascript = `globalThis.marker = ${JSON.stringify(marker)};`;
  fixture.outputs.clear();
  vi.resetModules();
  const packagingScript = '../scripts/build-contact-upload.mjs';
  await import(packagingScript);
  expect([...fixture.outputs.keys()]).toEqual(['web/dist/contact-upload.html', 'web/dist/contact-search-graph.html']);
  for (const output of fixture.outputs.values()) {
    const javascript = /<script>([\s\S]*?)<\/script>/u.exec(output)?.[1];
    expect(javascript).toBeDefined();
    const context: Record<string, unknown> = {};
    new Script(javascript!).runInNewContext(context);
    expect(context.marker).toBe(marker);
    expect(output.match(/<!doctype html>/gu)).toHaveLength(1);
    expect(output.match(/<script>/gu)).toHaveLength(1);
  }
});
