import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';

const maxFrameBytes = 256 * 1024;
const maxQueuedRequests = 32;
const graphOps = new Set([
  'health', 'get_contact', 'list_relations', 'save_contact', 'save_relation',
  'merge_contacts', 'archive_contact', 'restore_contact', 'archive_relation',
  'commit_import', 'sync_snapshots', 'get_sync_cursor', 'put_import_job',
  'get_import_job', 'recover_import_jobs', 'search_keyword', 'search_vector', 'put_vector', 'set_vector_state',
  'find_identity_candidates', 'review_contact_claim',
]);

export type GraphOp = 'health' | 'get_contact' | 'list_relations' | 'save_contact'
  | 'save_relation' | 'merge_contacts' | 'archive_contact' | 'restore_contact'
  | 'archive_relation' | 'commit_import' | 'sync_snapshots' | 'get_sync_cursor'
  | 'put_import_job' | 'get_import_job' | 'search_keyword' | 'search_vector' | 'put_vector'
  | 'set_vector_state' | 'recover_import_jobs' | 'find_identity_candidates' | 'review_contact_claim';

export interface GraphClient {
  request<T>(op: GraphOp, payload: unknown, signal?: AbortSignal): Promise<T>;
  close(timeoutMs?: number): Promise<void>;
}

interface ContactPageState { total: number; next_offset: number | null }

function contactPageState(value: unknown): { evidence: ContactPageState; relations: ContactPageState } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pagination = (value as Record<string, unknown>).pagination;
  if (pagination === undefined) return null; // Legacy test doubles return a complete record.
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) {
    throw new GraphClientError('GRAPH_INVALID_RESPONSE');
  }
  const fields = pagination as Record<string, unknown>;
  const parse = (raw: unknown): ContactPageState => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GraphClientError('GRAPH_INVALID_RESPONSE');
    const page = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(page.total) || (page.total as number) < 0
      || (page.next_offset !== null && (!Number.isSafeInteger(page.next_offset)
        || (page.next_offset as number) < 0 || (page.next_offset as number) > (page.total as number)))) {
      throw new GraphClientError('GRAPH_INVALID_RESPONSE');
    }
    return { total: page.total as number, next_offset: page.next_offset as number | null };
  };
  return { evidence: parse(fields.evidence), relations: parse(fields.relations) };
}

/** Internal consumers need all cited facts; the MCP tool deliberately exposes pages instead. */
export async function readCompleteContact(graph: GraphClient, entityId: string, options: {
  evidence?: boolean; relations?: boolean;
} = {}): Promise<Record<string, unknown> | null> {
  const first = await graph.request<Record<string, unknown> | null>('get_contact', { entity_id: entityId, claim_limit: 0 });
  if (!first) return null;
  const initial = contactPageState(first);
  if (!initial) return first;
  const includeEvidence = options.evidence !== false;
  const includeRelations = options.relations !== false;
  const evidence = includeEvidence && Array.isArray(first.evidence) ? [...first.evidence] : [];
  const relations = includeRelations && Array.isArray(first.relations) ? [...first.relations] : [];
  let state = initial;
  const maxPages = 40;
  for (let pageIndex = 1; (includeEvidence && state.evidence.next_offset !== null)
    || (includeRelations && state.relations.next_offset !== null); pageIndex++) {
    if (pageIndex >= maxPages) throw new GraphClientError('GRAPH_CONTACT_PAGE_LIMIT');
    const evidenceOffset = includeEvidence ? state.evidence.next_offset ?? state.evidence.total : state.evidence.total;
    const relationOffset = includeRelations ? state.relations.next_offset ?? state.relations.total : state.relations.total;
    const next = await graph.request<Record<string, unknown> | null>('get_contact', {
      entity_id: entityId, evidence_offset: evidenceOffset, relation_offset: relationOffset,
      evidence_limit: 50, relation_limit: 50, claim_limit: 0,
    });
    if (!next || next.version !== first.version || next.index_content_version !== first.index_content_version
      || !Array.isArray(next.evidence) || !Array.isArray(next.relations)) {
      throw new GraphClientError('GRAPH_CONTACT_CHANGED_DURING_READ');
    }
    const following = contactPageState(next);
    if (!following || following.evidence.total !== initial.evidence.total
      || following.relations.total !== initial.relations.total
      || (state.evidence.next_offset !== null && following.evidence.next_offset !== null
        && following.evidence.next_offset <= evidenceOffset)
      || (state.relations.next_offset !== null && following.relations.next_offset !== null
        && following.relations.next_offset <= relationOffset)) {
      throw new GraphClientError('GRAPH_INVALID_RESPONSE');
    }
    if (includeEvidence && state.evidence.next_offset !== null) evidence.push(...next.evidence);
    if (includeRelations && state.relations.next_offset !== null) relations.push(...next.relations);
    state = following;
  }
  if ((includeEvidence && evidence.length !== initial.evidence.total)
    || (includeRelations && relations.length !== initial.relations.total)) {
    throw new GraphClientError('GRAPH_INVALID_RESPONSE');
  }
  return { ...first, evidence, relations,
    pagination: { evidence: includeEvidence ? { total: evidence.length, next_offset: null } : initial.evidence,
      relations: includeRelations ? { total: relations.length, next_offset: null } : initial.relations } };
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
    (key !== 'field_path' && key !== 'value_path' && /(?:path|bin|command|executable)$/i.test(key))
      || hasPathField(child));
}

function waitAtMost(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
  });
}

export class ContactGraphClient implements GraphClient {
  private child!: ChildProcessWithoutNullStreams;
  private exited!: Promise<void>;
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private stopped = false;
  private restarting = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: { command: string; dbPath: string }) {
    if (!isAbsolute(options.command) || !options.dbPath) throw new GraphClientError('GRAPH_CONFIGURATION_ERROR');
    this.startWorker();
  }

  private startWorker(): void {
    const child = spawn(this.options.command, [], {
      env: { ...process.env, CONTACT_GRAPH_SQLITE_PATH: this.options.dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.exited = new Promise(resolve => child.once('close', () => resolve()));
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child === child && !this.restarting) this.receive(chunk);
    });
    child.stderr.on('data', () => undefined);
    child.once('error', () => {
      if (this.child === child && !this.restarting) this.failAll('GRAPH_PROCESS_ERROR');
    });
    child.once('close', () => {
      if (this.child === child && !this.restarting) this.failAll('GRAPH_PROCESS_EXITED');
    });
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
    if (this.queue.length >= maxQueuedRequests) {
      return Promise.reject(new GraphClientError('GRAPH_QUEUE_FULL'));
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
            const old = this.child;
            this.restarting = true;
            this.finishActive(undefined, new GraphClientError('GRAPH_ABORTED'));
            old.kill('SIGTERM');
            const killTimer = setTimeout(() => old.kill('SIGKILL'), 1_000);
            killTimer.unref();
            old.once('close', () => {
              clearTimeout(killTimer);
              if (!this.closing && !this.stopped) this.startWorker();
              this.restarting = false;
              this.sendNext();
            });
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
    if (this.active || this.stopped || this.restarting) return;
    const pending = this.queue.shift();
    if (!pending) return;
    this.active = pending;
    const child = this.child;
    child.stdin.write(pending.frame, error => {
      if (error && this.child === child && !this.restarting) this.failAll('GRAPH_WRITE_ERROR');
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
