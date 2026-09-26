import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';

const maxFrameBytes = 256 * 1024;
const graphOps = new Set([
  'health', 'get_contact', 'list_relations', 'save_contact', 'save_relation',
  'merge_contacts', 'archive_contact', 'restore_contact', 'archive_relation',
  'commit_import', 'sync_snapshots', 'get_sync_cursor', 'put_import_job',
  'get_import_job', 'search_keyword', 'search_vector', 'put_vector', 'set_vector_state',
]);

export type GraphOp = 'health' | 'get_contact' | 'list_relations' | 'save_contact'
  | 'save_relation' | 'merge_contacts' | 'archive_contact' | 'restore_contact'
  | 'archive_relation' | 'commit_import' | 'sync_snapshots' | 'get_sync_cursor'
  | 'put_import_job' | 'get_import_job' | 'search_keyword' | 'search_vector' | 'put_vector'
  | 'set_vector_state';

export interface GraphClient {
  request<T>(op: GraphOp, payload: unknown, signal?: AbortSignal): Promise<T>;
  close(timeoutMs?: number): Promise<void>;
}

export class GraphClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GraphClientError';
  }
}

interface Pending {
  id: string;
  frame: string;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  settled: Promise<void>;
}

function hasPathField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPathField);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    /(?:path|bin|command|executable)$/i.test(key) || hasPathField(child));
}

function waitAtMost(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
  });
}

export class ContactGraphClient implements GraphClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private stopped = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: { command: string; dbPath: string }) {
    if (!isAbsolute(options.command) || !options.dbPath) throw new GraphClientError('GRAPH_CONFIGURATION_ERROR');
    this.child = spawn(options.command, [], {
      env: { ...process.env, CONTACT_GRAPH_SQLITE_PATH: options.dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', () => undefined);
    this.child.once('error', () => this.failAll('GRAPH_PROCESS_ERROR'));
    this.child.once('close', () => this.failAll('GRAPH_PROCESS_EXITED'));
  }

  request<T>(op: GraphOp, payload: unknown, signal?: AbortSignal): Promise<T> {
    if (this.stopped || this.closing) return Promise.reject(new GraphClientError('GRAPH_CLOSED'));
    if (!graphOps.has(op)) return Promise.reject(new GraphClientError('GRAPH_UNKNOWN_OPERATION'));
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return Promise.reject(new GraphClientError('GRAPH_INVALID_PAYLOAD'));
    }
    if (signal?.aborted) return Promise.reject(new GraphClientError('GRAPH_ABORTED'));

    const id = `g_${this.nextId++}`;
    let frame: string;
    try {
      const plainPayload = JSON.parse(JSON.stringify(payload)) as unknown;
      if (plainPayload === null || typeof plainPayload !== 'object' || Array.isArray(plainPayload) ||
          hasPathField(plainPayload)) throw new Error('invalid payload');
      frame = `${JSON.stringify({ version: 1, request_id: id, op, payload: plainPayload })}\n`;
    }
    catch { return Promise.reject(new GraphClientError('GRAPH_INVALID_PAYLOAD')); }
    if (Buffer.byteLength(frame, 'utf8') > maxFrameBytes) {
      return Promise.reject(new GraphClientError('GRAPH_FRAME_TOO_LARGE'));
    }

    return new Promise<T>((resolve, reject) => {
      let settle!: () => void;
      const settled = new Promise<void>(done => { settle = done; });
      const pending: Pending = { id, frame, signal,
        resolve: value => { settle(); resolve(value as T); },
        reject: error => { settle(); reject(error); },
        settled,
      };
      if (signal) {
        pending.onAbort = () => {
          if (this.active === pending) {
            this.failAll('GRAPH_ABORTED');
          } else {
            const index = this.queue.indexOf(pending);
            if (index >= 0) this.queue.splice(index, 1);
            pending.reject(new GraphClientError('GRAPH_ABORTED'));
          }
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.queue.push(pending);
      this.sendNext();
    });
  }

  private sendNext(): void {
    if (this.active || this.stopped) return;
    const pending = this.queue.shift();
    if (!pending) return;
    this.active = pending;
    this.child.stdin.write(pending.frame, error => {
      if (error) this.failAll('GRAPH_WRITE_ERROR');
    });
  }

  private finishActive(result: unknown, error?: GraphClientError): void {
    const pending = this.active;
    if (!pending) return;
    this.active = null;
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(result);
    queueMicrotask(() => this.sendNext());
  }

  private receive(chunk: Buffer): void {
    if (this.stopped) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(offset, end);
      if (this.buffer.length + part.length > maxFrameBytes) {
        this.failAll('GRAPH_FRAME_TOO_LARGE');
        return;
      }
      this.buffer = Buffer.concat([this.buffer, part], this.buffer.length + part.length);
      offset = end;
      if (newline < 0) continue;
      const line = this.buffer.subarray(0, -1);
      this.buffer = Buffer.alloc(0);
      let response: unknown;
      try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
      catch { this.failAll('GRAPH_INVALID_RESPONSE'); return; }
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        this.failAll('GRAPH_INVALID_RESPONSE'); return;
      }
      const value = response as Record<string, unknown>;
      if (value.version !== 1 || value.request_id !== this.active?.id || typeof value.ok !== 'boolean') {
        this.failAll('GRAPH_INVALID_RESPONSE'); return;
      }
      if (value.ok) {
        if (!('result' in value)) { this.failAll('GRAPH_INVALID_RESPONSE'); return; }
        this.finishActive(value.result);
      } else {
        const remote = value.error;
        const code = remote && typeof remote === 'object' && !Array.isArray(remote)
          ? (remote as Record<string, unknown>).code : undefined;
        this.finishActive(undefined, new GraphClientError(
          typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'GRAPH_REMOTE_ERROR',
        ));
      }
      if (this.stopped) return;
    }
  }

  private failAll(code: string): void {
    if (this.stopped) return;
    this.stopped = true;
    const error = new GraphClientError(code);
    if (this.active) this.finishActive(undefined, error);
    for (const pending of this.queue.splice(0)) {
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
      pending.reject(error);
    }
    this.child.kill('SIGTERM');
  }

  close(timeoutMs = 1_000): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const active = this.active;
      for (const pending of this.queue.splice(0)) {
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
        pending.reject(new GraphClientError('GRAPH_CLOSED'));
      }
      if (active && !await waitAtMost(active.settled, timeoutMs)) this.failAll('GRAPH_CLOSED');
      this.stopped = true;
      this.child.stdin.end();
      if (!await waitAtMost(this.exited, timeoutMs)) {
        this.child.kill('SIGTERM');
        if (!await waitAtMost(this.exited, timeoutMs)) {
          this.child.kill('SIGKILL');
          await waitAtMost(this.exited, timeoutMs);
        }
      }
    })();
    return this.closePromise;
  }
}
