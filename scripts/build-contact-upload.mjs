import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

await mkdir('web/dist', { recursive: true });
for (const name of ['contact-upload', 'contact-search-graph']) {
  const result = await build({ entryPoints: [`web/${name}.ts`], bundle: true,
    format: 'iife', platform: 'browser', target: 'es2022', write: false, minify: true });
  const html = await readFile(`web/${name}.html`, 'utf8');
  await writeFile(`web/dist/${name}.html`, html.replace('<!--SCRIPT-->', () =>
    `<script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`));
}
