import { describe, expect, it } from 'vitest';
import { UploadSessions } from '../src/contacts/upload-session.js';

describe('upload sessions', () => {
  it('handoffs do not consume active quota until exchanged', () => {
    const sessions = new UploadSessions(() => true);
    sessions.create('alice', 'source');
    const handoff = sessions.createHandoff('alice', 'source');
    expect(() => sessions.create('alice', 'source')).not.toThrow();
    expect(sessions.exchange(handoff.code)).toBeNull();
    expect(sessions.exchange(handoff.code)).toBeNull();
  });

  it('bounds handoff storage, cleans expired codes, and starts the two-hour session TTL at exchange', () => {
    let now = 0;
    const sessions = new UploadSessions(() => true, () => now);
    const first = sessions.createHandoff('alice', 'source');
    for (let n = 1; n < 10; n++) sessions.createHandoff('alice', 'source');
    expect(() => sessions.createHandoff('alice', 'source')).toThrow('UPLOAD_HANDOFF_CAPACITY');
    now = 59_000;
    const exchanged = sessions.exchange(first.code)!;
    now = 60_000;
    expect(() => sessions.createHandoff('alice', 'source')).not.toThrow();
    now = 2 * 60 * 60_000;
    expect(sessions.authorize(exchanged.sessionId, exchanged.bearer)).not.toBeNull();
    now += 59_000;
    expect(sessions.authorize(exchanged.sessionId, exchanged.bearer)).toBeNull();
  });

  it('bounds successful receipt retention without making evicted receipts valid sessions', () => {
    const sessions = new UploadSessions(() => true);
    const completed: Array<{ sessionId: string; bearer: string }> = [];
    for (let n = 0; n < 1001; n++) {
      const session = sessions.create('alice', 'source');
      sessions.claimUpload(session.sessionId);
      sessions.finishUpload(session.sessionId, `file_${n}`);
      sessions.bindImport(session.sessionId, `import_${n}`);
      sessions.complete(session.sessionId, 3, { status: 'committed', version: 4 });
      completed.push(session);
    }
    expect(sessions.authorizeReceipt(completed[0].sessionId, completed[0].bearer, 3)).toBeNull();
    expect(sessions.authorize(completed[0].sessionId, completed[0].bearer)).toBeNull();
    expect(sessions.authorizeReceipt(completed[1000].sessionId, completed[1000].bearer, 3))
      .toEqual({ import_id: 'import_1000', status: 'committed', version: 4 });
  });

  it('successful completion revokes mutable capabilities and releases quota, retaining only a fixed receipt', () => {
    const sessions = new UploadSessions(() => true);
    const first = sessions.create('alice', 'source');
    sessions.create('alice', 'source');
    sessions.claimUpload(first.sessionId);
    sessions.finishUpload(first.sessionId, 'file_1');
    sessions.bindImport(first.sessionId, 'import_1');
    sessions.complete(first.sessionId, 3, { status: 'committed', version: 4, candidates: ['private'] });
    expect(sessions.authorize(first.sessionId, first.bearer)).toBeNull();
    expect(sessions.claimUpload(first.sessionId)).toBe(false);
    expect(sessions.bindImport(first.sessionId, 'import_2')).toBe(false);
    expect(() => sessions.create('alice', 'source')).not.toThrow();
    expect(sessions.authorizeReceipt(first.sessionId, first.bearer, 3))
      .toEqual({ import_id: 'import_1', status: 'committed', version: 4 });
    expect(sessions.authorizeReceipt(first.sessionId, first.bearer, 4)).toBeNull();
    expect(sessions.authorizeReceipt(first.sessionId, 'wrong', 3)).toBeNull();
  });

  it.each(['disabled', 'expired', 'exit'] as const)('denies receipt replay after %s', reason => {
    let now = 0;
    let enabled = true;
    const sessions = new UploadSessions(() => enabled, () => now);
    const first = sessions.create('alice', 'source');
    sessions.claimUpload(first.sessionId);
    sessions.finishUpload(first.sessionId, 'file_1');
    sessions.bindImport(first.sessionId, 'import_1');
    sessions.complete(first.sessionId, 3, { status: 'committed', version: 4 });
    if (reason === 'disabled') enabled = false;
    if (reason === 'expired') now = 2 * 60 * 60_000;
    if (reason === 'exit') sessions.revoke(first.sessionId);
    expect(sessions.authorizeReceipt(first.sessionId, first.bearer, 3)).toBeNull();
  });

  it('allows one completed upload, and retries only after failure', () => {
    const sessions = new UploadSessions(() => true);
    const { sessionId, bearer } = sessions.create('alice', 'source');
    expect(sessions.authorize(sessionId, bearer)?.actor).toBe('alice');
    expect(sessions.claimUpload(sessionId)).toBe(true);
    expect(sessions.claimUpload(sessionId)).toBe(false);
    sessions.finishUpload(sessionId, null);
    expect(sessions.claimUpload(sessionId)).toBe(true);
    sessions.finishUpload(sessionId, 'file_1');
    expect(sessions.claimUpload(sessionId)).toBe(false);
    expect(sessions.bindImport(sessionId, 'import_1')).toBe(true);
    expect(sessions.bindImport(sessionId, 'import_2')).toBe(false);
  });

  it('exchanges a handoff code once and expires it after a minute', () => {
    let now = 0;
    const sessions = new UploadSessions(() => true, () => now);
    const { code } = sessions.createHandoff('alice', 'source');
    expect(sessions.exchange(code)?.bearer).toBeTruthy();
    expect(sessions.exchange(code)).toBeNull();
    const second = sessions.createHandoff('alice', 'source');
    now = 60_001;
    expect(sessions.exchange(second.code)).toBeNull();
  });

  it('rejects expired, revoked, source-disabled and wrong secrets', () => {
    let now = 0;
    let enabled = true;
    const sessions = new UploadSessions(() => enabled, () => now);
    const first = sessions.create('alice', 'source');
    expect(sessions.authorize(first.sessionId, 'wrong')).toBeNull();
    enabled = false;
    expect(sessions.authorize(first.sessionId, first.bearer)).toBeNull();
    enabled = true;
    sessions.revoke(first.sessionId);
    expect(sessions.authorize(first.sessionId, first.bearer)).toBeNull();
    const second = sessions.create('alice', 'source');
    now = 2 * 60 * 60 * 1000 + 1;
    expect(sessions.authorize(second.sessionId, second.bearer)).toBeNull();
  });
});
