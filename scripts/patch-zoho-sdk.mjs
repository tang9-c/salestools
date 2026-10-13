import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = (source) => createHash('sha256').update(source).digest('hex');
function replaceChecked(source, from, to) {
  if (!source.includes(from) || source.includes(to)) throw new Error('ZOHO_SDK_PATCH_SOURCE_MISMATCH');
  return source.replaceAll(from, to);
}

// Validate every file before writing any file. No SDK code is imported during patching.
export async function checkZohoSDK(root = defaultRoot, apply = false) {
  const manifest = JSON.parse(await readFile(join(root, 'patches/zoho-sdk-4.0.0.json'), 'utf8'));
  const packageRoot = join(root, 'node_modules/@zohocrm/nodejs-sdk-8.0');
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (pkg.version !== manifest.version || manifest.version !== '4.0.0') throw new Error('ZOHO_SDK_PATCH_VERSION_MISMATCH');
  const pending = [];
  for (const file of manifest.files) {
    const path = join(packageRoot, file.path);
    const current = await readFile(path, 'utf8');
    if (digest(current) === file.sha256) {
      if (!apply) throw new Error('ZOHO_SDK_PATCH_REQUIRED');
      let patched = current;
      for (const [from, to] of file.replacements) patched = replaceChecked(patched, from, to);
      pending.push([path, patched]);
    } else {
      let restored = current;
      for (const [from, to] of [...file.replacements].reverse()) restored = replaceChecked(restored, to, from);
      if (digest(restored) !== file.sha256) throw new Error('ZOHO_SDK_PATCH_SOURCE_MISMATCH');
    }
  }
  for (const [path, source] of pending) await writeFile(path, source);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkZohoSDK(defaultRoot, process.argv.includes('--apply'));
  console.log('Zoho SDK 4.0.0 dependency patch verified');
}
