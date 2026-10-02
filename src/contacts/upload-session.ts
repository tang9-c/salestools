import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

interface Entry {
  actor: string;
  sourceTokenHash: string;
  bearerHash: Buffer;
  expiresAt: number;
  uploadState: 'open' | 'uploading' | 'uploaded';
  fileId?: string;
  importId?: string;
}

export interface UploadSession {
  sessionId: string;
  actor: string;
  fileId?: string;
  importId?: string;
}

export interface UploadReceipt {
  import_id: string;
  status: 'committed';
  version: number;
}

interface ReceiptEntry extends Pick<Entry, 'actor' | 'sourceTokenHash' | 'bearerHash' | 'expiresAt'> {
  previewVersion: number;
  receipt: UploadReceipt;
}

const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const secret = (): string => randomBytes(32).toString('base64url');

export class UploadSessions {
  private readonly sessions = new Map<string, Entry>();
  private readonly codes = new Map<string, { actor: string; sourceTokenHash: string; expiresAt: number }>();
  private readonly receipts = new Map<string, ReceiptEntry>();

  constructor(
    private readonly sourceEnabled: (hash: string, actor: string) => boolean,
    private readonly now: () => number = () => Date.now(),
  ) {}

  create(actor: string, sourceTokenHash: string): { sessionId: string; bearer: string } {
    this.prune();
    if (!actor.trim() || !sourceTokenHash || !this.sourceEnabled(sourceTokenHash, actor)) {
      throw new Error('UPLOAD_SESSION_UNAUTHORIZED');
    }
    const active = [...this.sessions.values()].filter(entry => entry.actor === actor).length;
    if (active >= 2) throw new Error('UPLOAD_SESSION_CAPACITY');
    const sessionId = secret();
    const bearer = secret();
    this.sessions.set(sessionId, {
      actor, sourceTokenHash, bearerHash: hash(bearer), expiresAt: this.now() + 2 * 60 * 60_000,
      uploadState: 'open',
    });
    return { sessionId, bearer };
  }

  createHandoff(actor: string, sourceTokenHash: string): { code: string } {
    this.prune();
    if (!actor.trim() || !sourceTokenHash || !this.sourceEnabled(sourceTokenHash, actor)) {
      throw new Error('UPLOAD_SESSION_UNAUTHORIZED');
    }
    if (this.codes.size >= 1000 || [...this.codes.values()].filter(entry => entry.actor === actor).length >= 10) {
      throw new Error('UPLOAD_HANDOFF_CAPACITY');
    }
    const code = secret();
    this.codes.set(hash(code).toString('hex'), { actor, sourceTokenHash, expiresAt: this.now() + 60_000 });
    return { code };
  }

  exchange(code: string): { sessionId: string; bearer: string } | null {
    const key = hash(code).toString('hex');
    const handoff = this.codes.get(key);
    this.codes.delete(key);
    if (!handoff || this.now() >= handoff.expiresAt) return null;
    try { return this.create(handoff.actor, handoff.sourceTokenHash); }
    catch { return null; }
  }

  authorize(sessionId: string, bearer: string): UploadSession | null {
    const entry = this.live(sessionId);
    if (!entry || typeof bearer !== 'string' || !bearer) return null;
    const candidate = hash(bearer);
    if (!timingSafeEqual(candidate, entry.bearerHash)) return null;
    return { sessionId, actor: entry.actor, fileId: entry.fileId, importId: entry.importId };
  }

  claimUpload(sessionId: string): boolean {
    const entry = this.live(sessionId);
    if (!entry || entry.uploadState !== 'open') return false;
    entry.uploadState = 'uploading';
    return true;
  }

  finishUpload(sessionId: string, fileId: string | null): void {
    const entry = this.live(sessionId);
    if (!entry || entry.uploadState !== 'uploading') return;
    if (fileId) {
      entry.fileId = fileId;
      entry.uploadState = 'uploaded';
    } else {
      entry.uploadState = 'open';
    }
  }

  bindImport(sessionId: string, importId: string): boolean {
    const entry = this.live(sessionId);
    if (!entry || entry.uploadState !== 'uploaded' || !entry.fileId) return false;
    if (entry.importId && entry.importId !== importId) return false;
    entry.importId = importId;
    return true;
  }

  complete(sessionId: string, previewVersion: number, result: Record<string, unknown>): UploadReceipt | null {
    const entry = this.live(sessionId);
    if (!entry?.importId || result.status !== 'committed' || !Number.isSafeInteger(result.version)
      || !Number.isSafeInteger(previewVersion) || previewVersion < 1) return null;
    const receipt: UploadReceipt = { import_id: entry.importId, status: 'committed', version: result.version as number };
    this.sessions.delete(sessionId);
    this.prune();
    if (this.receipts.size >= 1000) this.receipts.delete(this.receipts.keys().next().value!);
    this.receipts.set(sessionId, { actor: entry.actor, sourceTokenHash: entry.sourceTokenHash,
      bearerHash: entry.bearerHash, expiresAt: entry.expiresAt, previewVersion, receipt });
    return { ...receipt };
  }

  authorizeReceipt(sessionId: string, bearer: string, previewVersion: number): UploadReceipt | null {
    const entry = this.liveReceipt(sessionId);
    if (!entry || entry.previewVersion !== previewVersion || !this.matches(entry, bearer)) return null;
    return { ...entry.receipt };
  }

  exit(sessionId: string, bearer: string): boolean {
    const entry = this.live(sessionId) ?? this.liveReceipt(sessionId);
    if (!entry || !this.matches(entry, bearer)) return false;
    this.revoke(sessionId);
    return true;
  }

  revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.receipts.delete(sessionId);
  }

  private matches(entry: Pick<Entry, 'bearerHash'>, bearer: string): boolean {
    return typeof bearer === 'string' && !!bearer && timingSafeEqual(hash(bearer), entry.bearerHash);
  }

  private liveReceipt(sessionId: string): ReceiptEntry | null {
    const entry = this.receipts.get(sessionId);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt || !this.sourceEnabled(entry.sourceTokenHash, entry.actor)) {
      this.revoke(sessionId);
      return null;
    }
    return entry;
  }

  private live(sessionId: string): Entry | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt || !this.sourceEnabled(entry.sourceTokenHash, entry.actor)) {
      this.revoke(sessionId);
      return null;
    }
    return entry;
  }

  private prune(): void {
    for (const sessionId of this.sessions.keys()) this.live(sessionId);
    for (const sessionId of this.receipts.keys()) this.liveReceipt(sessionId);
    for (const [key, handoff] of this.codes) {
      if (this.now() >= handoff.expiresAt || !this.sourceEnabled(handoff.sourceTokenHash, handoff.actor)) this.codes.delete(key);
    }
  }
}
