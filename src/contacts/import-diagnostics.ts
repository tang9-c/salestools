import { z } from 'zod';

// Only machine codes and program locations cross the diagnostic boundary. Never
// serialize exception messages, document text, model responses or filesystem paths.
const codes = new Set(`IMPORT_FAILED IMPORT_TIMEOUT IMPORT_CANCELLED IMPORT_CLEANUP_FAILED
CONVERSION_FAILED SANDBOX_UNAVAILABLE SANDBOX_INIT_FAILED INTERNAL_ERROR INVALID_REQUEST
INVALID_OPERATION INVALID_PATH INVALID_LIMIT INVALID_RESPONSE INVALID_DOCUMENT INVALID_FILE_TYPE
FILE_SIZE_EXCEEDED PDF_PAGE_LIMIT IMAGE_PIXELS_EXCEEDED ENCRYPTED_PDF TEMP_BYTES_EXCEEDED
FRAME_TOO_LARGE DOCUMENT_OUTPUT_TOO_LARGE WORKER_TIMEOUT WORKER_FAILED WORKER_BUSY
WORKER_REQUEST_TOO_LARGE WORKER_RESPONSE_TOO_LARGE PREFLIGHT_FAILED PROCESS_ERROR PROCESS_EXITED
SCRATCH_CLEANUP_FAILED ABORTED INPUT_TOO_LARGE DUPLICATE_BLOCK_ID INVALID_BUDGET
BUDGET_EXHAUSTED MODEL_REQUEST_FAILED REMOTE_HTTP_ERROR NETWORK_ERROR TIMEOUT ECONNREFUSED ENOENT EACCES EPERM
ENOSPC EMFILE EPIPE ECONNRESET ETIMEDOUT`.split(/\s+/u));
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/u);
export const DiagnosticSchema = z.object({
  exceptions: z.array(z.object({
    type: name,
    errno: z.number().int().optional(),
    frames: z.array(z.object({
      module: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}\.py$/u),
      function: name,
      line: z.number().int().positive(),
    }).strict()).max(4),
  }).strict()).max(4).optional(),
  exit_code: z.number().int().nullable().optional(),
  signal: z.enum(['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGXFSZ', 'SIGALRM']).nullable().optional(),
  cleanup_code: z.literal('SCRATCH_CLEANUP_FAILED').optional(),
  root_code: z.string().refine(value => codes.has(value)).optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  validation_issue_count: z.number().int().nonnegative().optional(),
}).strict();
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type ImportStage = 'parse' | 'extract' | 'validate' | 'persist';
export interface ImportFailure { stage: ImportStage; code: string; message: string; diagnostic?: Diagnostic }

export function safeCode(value: unknown, fallback = 'IMPORT_FAILED'): string {
  return typeof value === 'string' && codes.has(value) ? value : fallback;
}

export function safeDiagnostic(value: unknown): Diagnostic | undefined {
  const result = DiagnosticSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function importFailure(stage: ImportStage, error: unknown, override?: string): ImportFailure {
  const object = error instanceof Error ? error as Error & { code?: string; diagnostic?: unknown } : undefined;
  const code = override && override !== 'IMPORT_FAILED' ? safeCode(override)
    : safeCode(object?.code ?? object?.message);
  const diagnostic = safeDiagnostic(object?.diagnostic);
  const details: Diagnostic = { ...diagnostic };
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    const current = cause as Error & { code?: unknown; status?: unknown; issues?: unknown[] };
    if (typeof current.code === 'string' && codes.has(current.code)) details.root_code = current.code;
    if (typeof current.status === 'number' && Number.isInteger(current.status)
      && current.status >= 100 && current.status <= 599) details.http_status = current.status;
    if (Array.isArray(current.issues)) details.validation_issue_count = current.issues.length;
    cause = current.cause;
  }
  return { stage, code, message: ({ parse: '文档解析失败', extract: '模型提炼失败',
    validate: '候选数据校验失败', persist: '任务结果保存失败' })[stage],
    ...(Object.keys(details).length ? { diagnostic: details } : {}) };
}
