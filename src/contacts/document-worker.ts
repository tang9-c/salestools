import { spawnParser } from './parser-process.js';
export { parserEnvironment } from './parser-process.js';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ParsedBlockSchema, type ParsedBlock } from '../contracts/index.js';
import { callWorkerSocket } from './worker-ipc.js';
import { safeCode, type Diagnostic } from './import-diagnostics.js';

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_BLOCKS = 4096;
const Frame = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), request_id: z.string(), kind: z.literal('block'), block: ParsedBlockSchema }).strict(),
  z.object({ version: z.literal(1), request_id: z.string(), kind: z.literal('done'), block_count: z.number().int().nonnegative(), warning_codes: z.array(z.string()) }).strict(),
  z.object({ version: z.literal(1), request_id: z.string(), kind: z.literal('error'), error: z.object({ code: z.string(), message: z.string() }).strict() }).strict(),
]);

export interface ParseLocalDocumentOptions {
  pythonBin: string; projectDir: string; filePath: string;
  workerSocket?: string;

  maxRuntimeMs?: number;
  fileType: 'pdf' | 'png' | 'jpg'; documentId: string;
  limits: { max_file_bytes?: number; max_pages?: number; max_page_pixels?: number; max_temp_bytes?: number };
  maxTotalTextBytes?: number;
  maxBlocks?: number;
}

export class DocumentWorkerError extends Error {
  constructor(readonly code: string, readonly diagnostic?: Diagnostic) { super(code); this.name = 'DocumentWorkerError'; }
}

/** One document per process: cancellation ends Docling conversion and all in-memory page text. */
export function parseLocalDocument(options: ParseLocalDocumentOptions, signal: AbortSignal): Promise<ParsedBlock[]> {
  if (signal.aborted) return Promise.reject(new DocumentWorkerError('ABORTED'));
  if (![options.pythonBin, options.projectDir, options.filePath].every(isAbsolute)) {
    return Promise.reject(new DocumentWorkerError('INVALID_PATH'));
  }
  const maxTotalTextBytes = options.maxTotalTextBytes ?? MAX_TOTAL_TEXT_BYTES;
  const maxBlocks = options.maxBlocks ?? MAX_BLOCKS;
  if (![maxTotalTextBytes, maxBlocks].every(value => Number.isSafeInteger(value) && value > 0)) {
    return Promise.reject(new DocumentWorkerError('INVALID_LIMIT'));
  }
  if (options.workerSocket) {
    return callWorkerSocket<unknown>(options.workerSocket, '/parse', {
      filePath: options.filePath, fileType: options.fileType, documentId: options.documentId,
      limits: options.limits,
    }, signal).then(value => {
      const blocks = z.array(ParsedBlockSchema).max(maxBlocks).parse(value);
      const total = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text, 'utf8'), 0);
      if (total > maxTotalTextBytes) throw new DocumentWorkerError('DOCUMENT_OUTPUT_TOO_LARGE');
      return blocks;
    });
  }
  const requestId = randomUUID();
  const request = JSON.stringify({ version: 1, request_id: requestId, op: 'parse', payload: {
    path: options.filePath, file_type: options.fileType, document_id: options.documentId, limits: options.limits,
  } });
  if (Buffer.byteLength(request, 'utf8') > MAX_FRAME_BYTES) return Promise.reject(new DocumentWorkerError('FRAME_TOO_LARGE'));
  return new Promise((resolve, reject) => {
    const { child, kill, cleanup, diagnostic } = spawnParser(options, 'parse', requestId,
      () => finish(new DocumentWorkerError('WORKER_TIMEOUT')));
    const blocks: ParsedBlock[] = [];
    const seen = new Set<string>();
    let totalTextBytes = 0;
    let totalWireBytes = 0;
    let buffer = Buffer.alloc(0);
    let settled = false;
    let failure: DocumentWorkerError | undefined;
    const finish = (error?: DocumentWorkerError) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      failure = error;
      kill();
    };
    const abort = () => finish(new DocumentWorkerError('ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalWireBytes += chunk.length;
      if (totalWireBytes > 20 * 1024 * 1024) { finish(new DocumentWorkerError('DOCUMENT_OUTPUT_TOO_LARGE')); return; }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        if (newline > MAX_FRAME_BYTES) { finish(new DocumentWorkerError('FRAME_TOO_LARGE')); return; }
        const raw = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        try {
          const frame = Frame.parse(JSON.parse(raw));
          if (frame.request_id !== requestId) throw new Error('request mismatch');
          if (frame.kind === 'error') {
            finish(new DocumentWorkerError(safeCode(frame.error.code, 'INVALID_RESPONSE')));
            return;
          }
          if (frame.kind === 'done') {
            if (frame.block_count !== blocks.length) throw new Error('block count mismatch');
            finish(); return;
          }
          if (seen.has(frame.block.block_id)) throw new Error('duplicate block id');
          totalTextBytes += Buffer.byteLength(frame.block.text, 'utf8');
          if (blocks.length >= maxBlocks || totalTextBytes > maxTotalTextBytes) {
            finish(new DocumentWorkerError('DOCUMENT_OUTPUT_TOO_LARGE')); return;
          }
          seen.add(frame.block.block_id);
          blocks.push(frame.block);
        } catch { finish(new DocumentWorkerError('INVALID_RESPONSE')); return; }
      }
      if (buffer.length > MAX_FRAME_BYTES) finish(new DocumentWorkerError('FRAME_TOO_LARGE'));
    });
    child.stdin.on('error', () => finish(new DocumentWorkerError('PROCESS_ERROR')));
    child.once('error', () => finish(new DocumentWorkerError('PROCESS_ERROR')));
    child.once('close', async (exitCode, exitSignal) => {
      const cleanupError = await cleanup;
      if (cleanupError) failure ??= new DocumentWorkerError('SCRATCH_CLEANUP_FAILED');
      if (!settled) finish(failure ?? new DocumentWorkerError('PROCESS_EXITED'));
      if (failure) reject(new DocumentWorkerError(failure.code, {
        ...diagnostic(), exit_code: exitCode,
        // SIGKILL is a signal, not evidence of an OOM kill.
        ...(['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGXFSZ', 'SIGALRM'].includes(exitSignal ?? '')
          ? { signal: exitSignal as Diagnostic['signal'] } : {}),
        ...(cleanupError ? { cleanup_code: 'SCRATCH_CLEANUP_FAILED' as const } : {}),
      })); else resolve(blocks);
    });
    if (signal.aborted) abort();
    child.stdin.end(`${request}\n`);
  });
}
