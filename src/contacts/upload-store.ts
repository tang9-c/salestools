import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, createWriteStream, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';

export interface UploadedFile {
  fileId: string;
  fileName: string;
  sha256: string;
  mime: 'application/pdf' | 'image/jpeg' | 'image/png';
  tempPath: string;
  uploadedAt: string;
}

export class UploadError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

interface Entry { file?: UploadedFile; bytes: number; timer?: NodeJS.Timeout; submitted: boolean }

const pythonRoot = fileURLToPath(new URL('../../python/', import.meta.url));
const pythonPreflight = `import json,sys
from pathlib import Path
from contact_worker.parser import preflight,ParseError
try:
 preflight(Path(sys.argv[1]),sys.argv[2],json.loads(sys.argv[3]))
except ParseError as error:
 print(str(error))
 sys.exit(2)
except Exception:
 print('PREFLIGHT_FAILED')
 sys.exit(1)
`;

export class UploadStore {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  private readonly now: () => Date;

  constructor(private readonly options: {
    directory: string; maxPendingFiles: number; maxFileBytes: number; maxTempBytes: number;
    maxPdfPages?: number; maxImagePixels?: number; pythonBin?: string; now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    chmodSync(options.directory, 0o700);
  }

  get pendingCount(): number { return this.entries.size; }
  get(fileId: string): UploadedFile | null { return this.entries.get(fileId)?.file ?? null; }

  async reserve(): Promise<string> {
    // No await before insertion: concurrent HTTP handlers cannot overbook the process-local cap.
    if (this.entries.size >= this.options.maxPendingFiles) throw new UploadError('CAPACITY_FULL', 429);
    const id = randomUUID();
    this.entries.set(id, { bytes: 0, submitted: false });
    return id;
  }

  async receive(fileId: string, stream: Readable, filename: string): Promise<UploadedFile> {
    const entry = this.entries.get(fileId);
    if (!entry || entry.file) throw new UploadError('INVALID_UPLOAD', 400);
    const safeName = filename.split(/[\\/]/).pop()?.slice(0, 255) ?? '';
    if (!safeName) throw new UploadError('INVALID_UPLOAD', 400);
    const path = join(this.options.directory, fileId);
    const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    const hash = createHash('sha256');
    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    let pdfPages = 0;
    let pdfWindow = '';
    let encrypted = false;
    try {
      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        entry.bytes += chunk.length;
        this.totalBytes += chunk.length;
        if (entry.bytes > this.options.maxFileBytes) throw new UploadError('FILE_TOO_LARGE', 413);
        if (this.totalBytes > this.options.maxTempBytes) throw new UploadError('TEMP_CAPACITY_FULL', 429);
        head = Buffer.concat([head, chunk]).subarray(0, 32);
        tail = Buffer.concat([tail, chunk]).subarray(-1024);
        const scan = pdfWindow + chunk.toString('latin1');
        encrypted ||= scan.includes('/Encrypt');
        pdfPages += (scan.slice(pdfWindow.length).match(/\/Type\s*\/Page\b/g) ?? []).length;
        pdfWindow = scan.slice(-32);
        hash.update(chunk);
        if (!output.write(chunk)) await once(output, 'drain');
      }
      output.end();
      await once(output, 'finish');
      const mime = head.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf'
        : head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
          : head.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg' : null;
      if (!mime) throw new UploadError('UNSUPPORTED_FILE', 415);
      if (mime === 'application/pdf' && encrypted) throw new UploadError('ENCRYPTED_PDF', 422);
      if (mime === 'application/pdf' && !tail.includes(Buffer.from('%%EOF'))) {
        throw new UploadError('INVALID_DOCUMENT', 422);
      }
      if (mime === 'application/pdf' && pdfPages > (this.options.maxPdfPages ?? 50)) {
        throw new UploadError('PDF_PAGE_LIMIT', 422);
      }
      if (mime === 'image/png' && head.length >= 24 &&
          head.readUInt32BE(16) * head.readUInt32BE(20) > (this.options.maxImagePixels ?? 25_000_000)) {
        throw new UploadError('IMAGE_PIXELS_EXCEEDED', 422);
      }
      if (mime === 'image/png' && (head.length < 24 || !tail.includes(Buffer.from('IEND')))) {
        throw new UploadError('INVALID_DOCUMENT', 422);
      }
      if (mime === 'image/jpeg' && !tail.subarray(-2).equals(Buffer.from([255, 217]))) {
        throw new UploadError('INVALID_DOCUMENT', 422);
      }
      const file: UploadedFile = { fileId, fileName: safeName, sha256: hash.digest('hex'), mime,
        tempPath: path, uploadedAt: this.now().toISOString() };
      entry.file = file;
      entry.timer = setTimeout(() => { if (!entry.submitted) void this.release(fileId); }, 3_600_000);
      entry.timer.unref();
      return file;
    } catch (error) {
      output.destroy();
      if (!output.closed) await once(output, 'close');
      await this.release(fileId);
      throw error;
    }
  }

  async preflight(file: UploadedFile, signal?: AbortSignal): Promise<void> {
    const type = file.mime === 'application/pdf' ? 'pdf' : file.mime === 'image/png' ? 'png' : 'jpg';
    const limits = { max_file_bytes: this.options.maxFileBytes,
      max_pages: this.options.maxPdfPages ?? 50,
      max_page_pixels: this.options.maxImagePixels ?? 25_000_000,
      max_temp_bytes: this.options.maxTempBytes };
    const executable = this.options.pythonBin ?? join(pythonRoot, '.venv', 'bin', 'python');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ['-c', pythonPreflight, file.tempPath, type, JSON.stringify(limits)], {
        env: { ...process.env, PYTHONPATH: pythonRoot }, stdio: ['ignore', 'pipe', 'ignore'], signal,
      });
      let output = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new UploadError('PREFLIGHT_TIMEOUT', 503)); }, 30_000);
      timer.unref();
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.length > 1024) { child.kill('SIGKILL'); finish(new UploadError('PREFLIGHT_FAILED', 503)); }
      });
      child.once('error', () => finish(new UploadError('PREFLIGHT_UNAVAILABLE', 503)));
      child.once('close', code => {
        if (code === 0) { finish(); return; }
        const value = output.trim();
        const status = value === 'FILE_SIZE_EXCEEDED' ? 413
          : value === 'INVALID_FILE_TYPE' ? 415
            : /^(INVALID_DOCUMENT|ENCRYPTED_PDF|PDF_PAGE_LIMIT|IMAGE_PIXELS_EXCEEDED)$/.test(value) ? 422 : 503;
        finish(new UploadError(status === 503 ? 'PREFLIGHT_FAILED' : value, status));
      });
    });
  }

  markSubmitted(fileId: string): UploadedFile {
    const entry = this.entries.get(fileId);
    if (!entry?.file) throw new UploadError('FILE_NOT_FOUND', 404);
    entry.submitted = true;
    if (entry.timer) clearTimeout(entry.timer);
    return entry.file;
  }

  async release(fileId: string): Promise<void> {
    const entry = this.entries.get(fileId);
    if (!entry) return;
    this.entries.delete(fileId);
    if (entry.timer) clearTimeout(entry.timer);
    this.totalBytes -= entry.bytes;
    await unlink(join(this.options.directory, fileId)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  async cleanupOrphans(): Promise<void> {
    for (const name of readdirSync(this.options.directory)) {
      if (!this.entries.has(name)) rmSync(join(this.options.directory, name), { recursive: true, force: true });
    }
  }

  async close(): Promise<void> { await Promise.all([...this.entries.keys()].map(id => this.release(id))); }
}
