import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const result = await build({ entryPoints: ['web/contact-upload.ts'], bundle: true,
  format: 'iife', platform: 'browser', target: 'es2022', write: false, minify: true });
const html = await readFile('web/contact-upload.html', 'utf8');
await mkdir('web/dist', { recursive: true });
await writeFile('web/dist/contact-upload.html', html.replace('<!--SCRIPT-->',
  `<script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`));
