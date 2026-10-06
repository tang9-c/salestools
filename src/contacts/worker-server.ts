import { createServer, type Server } from 'node:http';
import { existsSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { parseLocalDocument } from './document-worker.js';
import { spawnParser, type SandboxMode } from './parser-process.js';
import { importFailure } from './import-diagnostics.js';

const pythonRoot = fileURLToPath(new URL('../../python/', import.meta.url));
const Request = z.object({ filePath: z.string(), fileType: z.enum(['pdf', 'png', 'jpg']),
  limits: z.record(z.string(), z.number().int().nonnegative()), documentId: z.string().optional() }).strict();

function checkedPath(raw: string, directory: string): string {
  const name = basename(raw);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    throw new Error('INVALID_PATH');
  }
  const expected = join(resolve(directory), name);
  if (resolve(raw) !== expected || realpathSync(raw) !== join(realpathSync(directory), name)) {
    throw new Error('INVALID_PATH');
  }
  return raw;
}

function preflight(filePath: string, fileType: string, limits: Record<string, number>,
  pythonBin: string, signal: AbortSignal, sandboxMode?: SandboxMode): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let failure: string | undefined;
    const { child, kill, cleanup, diagnostic } = spawnParser({ pythonBin, projectDir: pythonRoot, filePath,
      fileType, limits, sandboxMode }, 'preflight', '', () => stop('WORKER_TIMEOUT'));
    const stop = (code: string) => { failure ??= code; kill(); };
    const abort = () => stop('ABORTED');
    signal.addEventListener('abort', abort, {once: true});
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      if (Buffer.byteLength(output) + chunk.length > 1024) { stop('PREFLIGHT_FAILED'); return; }
      output += chunk.toString('utf8');
    });
    child.stdin.on('error', () => stop('PREFLIGHT_FAILED'));
    child.once('error', () => { failure ??= 'PREFLIGHT_FAILED'; });
    child.once('close', async code => {
      const cleanupError = await cleanup;
      const rootCode = failure ?? (code !== 0
        ? (/^[A-Z][A-Z0-9_]{0,63}$/.test(output.trim()) ? output.trim() : 'PREFLIGHT_FAILED') : undefined);
      signal.removeEventListener('abort', abort);
      if (!rootCode && !cleanupError) resolvePromise();
      else reject(Object.assign(new Error(rootCode ?? 'SCRATCH_CLEANUP_FAILED'), {
        diagnostic: { ...diagnostic(), exit_code: code,
          ...(cleanupError ? { cleanup_code: 'SCRATCH_CLEANUP_FAILED' } : {}) },
      }));
    });
    child.stdin.end();
    if (signal.aborted) abort();
  });
}

export function createWorkerServer(options: { uploadDirectory: string; pythonBin: string; sandboxMode?: SandboxMode }): Server {
  let active = 0;
  return createServer((request, response) => {
    if (active >= 2) { response.writeHead(503).end(JSON.stringify({ code: 'WORKER_BUSY' })); return; }
    active += 1;
    const abort = new AbortController();
    response.once('close', () => { if (!response.writableEnded) abort.abort(); });
    void (async () => {
      if (request.method !== 'POST' || !['/preflight', '/parse'].includes(request.url ?? '')) {
        response.writeHead(404).end(); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4096) throw new Error('WORKER_REQUEST_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      const parsed = Request.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const filePath = checkedPath(parsed.filePath, options.uploadDirectory);
      if (statSync(filePath).size > 20 * 1024 * 1024) throw new Error('FILE_SIZE_EXCEEDED');
      const limits = { ...parsed.limits,
        max_file_bytes: Math.min(parsed.limits.max_file_bytes ?? 20 * 1024 * 1024, 20 * 1024 * 1024),
        max_pages: Math.min(parsed.limits.max_pages ?? 50, 50),
        max_page_pixels: Math.min(parsed.limits.max_page_pixels ?? 25_000_000, 25_000_000) };
      let value: unknown = null;
      if (request.url === '/preflight') {
        await preflight(filePath, parsed.fileType, limits, options.pythonBin, abort.signal, options.sandboxMode);
      } else {
        if (!parsed.documentId) throw new Error('INVALID_REQUEST');
        value = await parseLocalDocument({ filePath, fileType: parsed.fileType,
          documentId: parsed.documentId, limits,
          pythonBin: options.pythonBin, projectDir: pythonRoot, sandboxMode: options.sandboxMode }, abort.signal);
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ value }));
    })().catch(error => {
      const failure = importFailure('parse', error);
      process.stderr.write(`${JSON.stringify({ event: 'contact_worker_failed', route: request.url === '/parse' ? 'parse' : 'preflight', ...failure })}\n`);
      if (!response.destroyed) response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: failure.code, diagnostic: failure.diagnostic }));
    }).finally(() => { active -= 1; });
  });
}

async function main(): Promise<void> {
  const socket = process.env.CONTACT_WORKER_SOCKET;
  const uploadDirectory = process.env.CONTACT_UPLOAD_DIR;
  const pythonBin = process.env.CONTACT_PYTHON_BIN;
  if (!socket || !uploadDirectory || !pythonBin) throw new Error('WORKER_CONFIG_MISSING');
  if (existsSync(socket)) unlinkSync(socket);
  const server = createWorkerServer({ uploadDirectory, pythonBin });
  server.listen(socket);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { process.stderr.write('Worker startup failed\n'); process.exitCode = 1; });
}
