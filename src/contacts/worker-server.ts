import { createServer, type Server } from 'node:http';
import { accessSync, constants, existsSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { parseLocalDocument } from './document-worker.js';
import { spawnParser } from './parser-process.js';
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
  pythonBin: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let failure: string | undefined;
    const { child, kill, cleanup, diagnostic } = spawnParser({ pythonBin, projectDir: pythonRoot, filePath,
      fileType, limits }, 'preflight', '', () => stop('WORKER_TIMEOUT'));
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

export function createWorkerServer(options: { uploadDirectory: string; pythonBin: string }): Server {
  let active = 0;
  return createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/healthz') {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ value: { ready: true } }));
      return;
    }
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
        await preflight(filePath, parsed.fileType, limits, options.pythonBin, abort.signal);
      } else {
        if (!parsed.documentId) throw new Error('INVALID_REQUEST');
        value = await parseLocalDocument({ filePath, fileType: parsed.fileType,
          documentId: parsed.documentId, limits,
          pythonBin: options.pythonBin, projectDir: pythonRoot }, abort.signal);
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

export async function startWorker(options: { socket: string; uploadDirectory: string; pythonBin: string }): Promise<Server> {
  try {
    accessSync(options.uploadDirectory, constants.R_OK | constants.X_OK);
    if (!statSync(options.uploadDirectory).isDirectory()) throw new Error();
  } catch { throw new Error('WORKER_UPLOAD_DIR_UNREADABLE'); }
  try { accessSync(dirname(options.socket), constants.W_OK | constants.X_OK); }
  catch { throw new Error('WORKER_SOCKET_DIR_UNWRITABLE'); }
  try { accessSync(options.pythonBin, constants.X_OK); }
  catch { throw new Error('WORKER_PYTHON_UNAVAILABLE'); }
  const fixture = '/usr/local/share/contact-runtime/synthetic-resume.pdf';
  const source = existsSync(fixture) ? fixture
    : fileURLToPath(new URL('../../tests/fixtures/contact-documents/synthetic-resume.pdf', import.meta.url));
  // Reuse ordinary preflight before readiness; this does not load Docling models.
  await preflight(source, 'pdf', {}, options.pythonBin, new AbortController().signal);
  if (existsSync(options.socket)) unlinkSync(options.socket);
  const server = createWorkerServer(options);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.socket, () => { server.removeListener('error', reject); resolvePromise(); });
  }).catch(() => { throw new Error('WORKER_SOCKET_UNAVAILABLE'); });
  return server;
}

const startupHints: Record<string, string> = {
  WORKER_CONFIG_MISSING: '使用部署模板提供 Worker socket、上传目录和 Python 路径。',
  WORKER_UPLOAD_DIR_UNREADABLE: '检查共享上传卷路径、只读挂载和 UID/GID 1000 的读取权限。',
  WORKER_SOCKET_DIR_UNWRITABLE: '检查共享 socket 卷是否允许 UID/GID 1000 写入。',
  WORKER_PYTHON_UNAVAILABLE: '检查两个容器是否使用同一完整版本镜像及其 Python 路径。',
  WORKER_SOCKET_UNAVAILABLE: '检查 socket 挂载、目录权限和是否已有其他 Worker 占用。',
  WORKER_INIT_FAILED: '检查完整镜像、Python 运行时和容器文件权限。',
  PREFLIGHT_FAILED: '检查完整镜像和 Python 运行时；预检未通过，Worker 未就绪。',
  WORKER_TIMEOUT: '启动预检超时，检查 Worker 的 CPU、内存及 PID 配置。',
  WORKER_STARTUP_FAILED: '启动检查未通过，核对部署模板和 Worker 镜像。',
};

export function formatWorkerStartupFailure(error: unknown): string {
  const code = error instanceof Error && Object.hasOwn(startupHints, error.message)
    ? error.message : 'WORKER_STARTUP_FAILED';
  return `${JSON.stringify({ event: 'contact_worker_startup_failed', code, message: startupHints[code] })}\n`;
}

async function main(): Promise<void> {
  const socket = process.env.CONTACT_WORKER_SOCKET;
  const uploadDirectory = process.env.CONTACT_UPLOAD_DIR;
  const pythonBin = process.env.CONTACT_PYTHON_BIN;
  if (!socket || !uploadDirectory || !pythonBin) throw new Error('WORKER_CONFIG_MISSING');
  await startWorker({ socket, uploadDirectory, pythonBin });
  process.stdout.write(`${JSON.stringify({ event: 'contact_worker_ready', preflight: 'passed' })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => { process.stderr.write(formatWorkerStartupFailure(error)); process.exitCode = 1; });
}
