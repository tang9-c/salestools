import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const maximumFileBytes = 20 * 1024 * 1024;
const mimeTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export interface UploadSummary {
  accepted: Array<{ path: string; file_id: string }>;
  unuploaded: string[];
  exitCode: number;
}

type ErrorWriter = (message: string) => void;

function uploadUrl(configured: string | undefined): URL | null {
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/contact-files' || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function failed(paths: string[], accepted: UploadSummary['accepted'], index: number, exitCode: number): UploadSummary {
  return { accepted, unuploaded: paths.slice(index), exitCode };
}

export async function runUploadCli(
  paths: string[],
  env: NodeJS.ProcessEnv = process.env,
  writeError: ErrorWriter = message => process.stderr.write(`${message}\n`),
): Promise<UploadSummary> {
  const accepted: UploadSummary['accepted'] = [];
  const url = uploadUrl(env.CONTACT_UPLOAD_URL);
  const token = env.CONTACT_UPLOAD_TOKEN;
  if (paths.length === 0 || url === null || !token || /\s/.test(token)) {
    writeError('UPLOAD_CONFIGURATION_ERROR');
    return failed(paths, accepted, 0, 2);
  }

  for (const [index, path] of paths.entries()) {
    const extension = extname(path).toLowerCase();
    const mimeType = mimeTypes[extension];
    if (!mimeType) {
      writeError('UNSUPPORTED_FILE_TYPE');
      return failed(paths, accepted, index, 1);
    }

    let contents: Buffer;
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size === 0 || metadata.size > maximumFileBytes) {
        writeError('INVALID_FILE_SIZE');
        return failed(paths, accepted, index, 1);
      }
      contents = await readFile(path);
      if (contents.length !== metadata.size) {
        writeError('FILE_CHANGED_DURING_READ');
        return failed(paths, accepted, index, 1);
      }
    } catch {
      writeError('FILE_READ_ERROR');
      return failed(paths, accepted, index, 1);
    }

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(contents)], { type: mimeType }), path.split(/[\\/]/).at(-1));

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    } catch {
      writeError('UPLOAD_NETWORK_ERROR');
      return failed(paths, accepted, index, 1);
    }

    if (response.status === 429) {
      let code: unknown;
      try { code = (await response.json() as { code?: unknown }).code; } catch { /* Ignore untrusted body. */ }
      if (code === 'CAPACITY_FULL') {
        writeError('CAPACITY_FULL');
        return failed(paths, accepted, index, 1);
      }
    }
    if (!response.ok) {
      writeError(`UPLOAD_HTTP_${response.status}`);
      return failed(paths, accepted, index, 1);
    }

    let fileId: unknown;
    try { fileId = (await response.json() as { file_id?: unknown }).file_id; } catch { /* Ignore untrusted body. */ }
    if (typeof fileId !== 'string' || fileId.length === 0 || fileId.includes(token)) {
      writeError('INVALID_UPLOAD_RESPONSE');
      return failed(paths, accepted, index, 1);
    }
    accepted.push({ path, file_id: fileId });
  }

  return { accepted, unuploaded: [], exitCode: 0 };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await runUploadCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = summary.exitCode;
}
