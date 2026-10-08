import type {} from '@modelcontextprotocol/express';
import { createHash } from 'node:crypto';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import Busboy from 'busboy';
import type { AuthenticatedUser } from '../auth/token-service.js';
import type { UploadSessions, UploadSession } from '../contacts/upload-session.js';
import type { ContactImportService } from '../contacts/import-service.js';
import { UploadError, type UploadStore, type UploadedFile } from '../contacts/upload-store.js';
import { ContactRateLimitError } from '../contacts/contact-rate-limit.js';
import { buildMcpServer, type McpServices } from './tools.js';

export interface McpHttpConfig {
  publicMcpHost: string;
  allowedOriginUrls: ReadonlySet<string>;
  allowedOriginHostnames: ReadonlySet<string>;
}

export type McpHttpApp = Express & {
  closeMcpHandler(): Promise<void>;
};

export interface ContactUploadPage {
  sessions: UploadSessions;
  imports: ContactImportService;
  html: () => Promise<string>;
}

export function createHttpApp(
  config: McpHttpConfig,
  authenticate: (plaintext: string) => AuthenticatedUser | null,
  servicesFor: (userId: string, token: string) => McpServices,
  uploads?: UploadStore,
  page?: ContactUploadPage,
): McpHttpApp {
  const handler = createMcpHandler(({ authInfo }) => {
    if (!authInfo?.clientId) throw new Error('Authenticated caller is required');
    return buildMcpServer(servicesFor(authInfo.clientId, authInfo.token));
  });
  const nodeHandler = toNodeHandler(handler);
  const app = express() as McpHttpApp;

  const exactOriginMiddleware: RequestHandler = (request, response, next) => {
    const origin = request.get('Origin');
    if (origin === undefined || config.allowedOriginUrls.has(origin)) {
      next();
      return;
    }
    response.status(403).json({ error: 'Forbidden' });
  };

  const exactHostMiddleware: RequestHandler = (request, response, next) => {
    const rawHost = request.get('Host');
    try {
      const host = new URL(`http://${rawHost}`).hostname;
      if (host.toLowerCase() === config.publicMcpHost.toLowerCase()) { next(); return; }
    } catch { /* Reject malformed Host headers. */ }
    response.status(403).json({ error: 'Forbidden' });
  };

  const authMiddleware: RequestHandler = (request, response, next) => {
    const authorization = request.get('Authorization');
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (match === undefined || match === null) {
      response.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = authenticate(match[1]);
    if (user === null) {
      response.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'Unauthorized' });
      return;
    }

    const authInfo: AuthInfo = { token: match[1], clientId: user.userId, scopes: [] };
    request.auth = authInfo;
    next();
  };

  app.get('/healthz', (_request, response) => {
    response.json({ status: 'ok' });
  });
  app.all('/mcp', exactHostMiddleware, exactOriginMiddleware, authMiddleware, (request, response, next) => {
    void nodeHandler(request, response, request.body).catch(next);
  });
  const pageContext = new WeakMap<object, UploadSession>();
  const localHost = /^(localhost|127\.0\.0\.1)$/.test(config.publicMcpHost);
  const cookieName = localHost ? 'contact-upload-dev' : '__Host-contact-upload';
  const sameOrigin = (request: Parameters<RequestHandler>[0]): boolean => {
    return request.get('Origin') === `${localHost ? 'http' : 'https'}://${request.get('Host')}`;
  };
  const pageCredential = (request: Parameters<RequestHandler>[0]) => {
    const bearer = request.get('Authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
    const cookie = request.get('Cookie')?.split(';').map(value => value.trim())
      .find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const credential = bearer ?? cookie;
    const dot = credential?.indexOf('.') ?? -1;
    return { bearer, cookie, sessionId: dot > 0 ? credential!.slice(0, dot) : '',
      secret: dot > 0 ? credential!.slice(dot + 1) : '' };
  };
  const pageAuth: RequestHandler = (request, response, next) => {
    if (!page) { response.status(404).end(); return; }
    const { bearer, cookie, sessionId, secret } = pageCredential(request);
    const session = page.sessions.authorize(sessionId, secret);
    if (!session) { response.status(401).json({ code: 'UPLOAD_SESSION_UNAUTHORIZED' }); return; }
    if (cookie && !bearer && request.method !== 'GET') {
      if (!sameOrigin(request)) { response.status(403).json({ code: 'UPLOAD_ORIGIN_DENIED' }); return; }
    }
    if (bearer) response.set('Access-Control-Allow-Origin', '*');
    response.set('Cache-Control', 'no-store');
    pageContext.set(request, session);
    request.auth = { token: '', clientId: session.actor, scopes: [] };
    next();
  };
  const uploadAuth: RequestHandler = (request, response, next) => {
    const authorization = request.get('Authorization');
    const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (token && authenticate(token)) {
      exactOriginMiddleware(request, response, error => {
        if (error) { next(error); return; }
        authMiddleware(request, response, next);
      });
    } else if (page) pageAuth(request, response, next);
    else authMiddleware(request, response, next);
  };
  const pageApiPaths = ['/contact-files', '/contact-upload/import', '/contact-upload/commit', '/contact-upload/exit'];
  // Exchange carries a handoff secret but must never inherit App Bearer CORS.
  const privateApiPaths = [...pageApiPaths, '/contact-upload/exchange'];
  if (page) app.use(privateApiPaths, (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  if (page) app.use(pageApiPaths, (request, response, next) => {
    if (pageCredential(request).bearer) response.set('Access-Control-Allow-Origin', '*');
    next();
  });
  if (page) app.options('/contact-files', exactHostMiddleware, (_request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.set('Access-Control-Allow-Methods', 'POST, OPTIONS').status(204).end();
  });
  if (uploads) app.post('/contact-files', exactHostMiddleware, uploadAuth, (request, response) => {
    void (async () => {
      const session = pageContext.get(request);
      if (session && !page!.sessions.claimUpload(session.sessionId)) {
        response.status(409).json({ code: 'UPLOAD_ALREADY_USED' }); return;
      }
      let id: string;
      try { id = await uploads.reserve(request.auth?.clientId ?? ''); }
      catch (error) {
        if (session) page!.sessions.finishUpload(session.sessionId, null);
        if (error instanceof ContactRateLimitError) {
          response.set('Retry-After', String(error.retryAfterSeconds)).status(429)
            .json({ code: error.code, retry_after_seconds: error.retryAfterSeconds });
          return;
        }
        const problem = error instanceof UploadError ? error : new UploadError('UPLOAD_FAILED', 500);
        response.status(problem.status).json({ code: problem.code });
        return;
      }
      const fail = async (error: unknown) => {
        await uploads.release(id);
        if (session) page!.sessions.finishUpload(session.sessionId, null);
        if (!response.headersSent && !response.destroyed) {
          const problem = error instanceof UploadError ? error : new UploadError('INVALID_UPLOAD', 400);
          response.status(problem.status).json({ code: problem.code });
        }
      };
      if (!request.is('multipart/form-data')) {
        await fail(new UploadError('INVALID_MULTIPART', 415));
        return;
      }
      let parser: ReturnType<typeof Busboy>;
      try { parser = Busboy({ headers: request.headers, defParamCharset: 'utf8', limits: { files: 2, fields: 1, parts: 2 } }); }
      catch { await fail(new UploadError('INVALID_MULTIPART', 400)); return; }
      let fileCount = 0;
      let uploaded: Promise<UploadedFile> | null = null;
      let finished = false;
      let rejected = false;
      const preflightAbort = new AbortController();
      const disconnect = () => { if (!finished) { preflightAbort.abort(); parser.destroy(); void uploads.release(id);
        if (session) page!.sessions.finishUpload(session.sessionId, null); } };
      request.once('aborted', disconnect);
      response.once('close', disconnect);
      parser.on('file', (field, file, info) => {
        fileCount += 1;
        if (field !== 'file' || fileCount !== 1) {
          file.resume();
          parser.destroy(new UploadError('INVALID_MULTIPART', 400));
          return;
        }
        uploaded = uploads.receive(id, file, info.filename);
        // Attach rejection immediately while the multipart parser is still active.
        void uploaded.catch(error => {
          rejected = true;
          request.unpipe(parser);
          parser.destroy();
          request.resume();
          void fail(error);
        });
      });
      parser.on('field', () => { rejected = true; parser.destroy(); void fail(new UploadError('INVALID_MULTIPART', 400)); });
      parser.once('error', error => { rejected = true; void fail(error); });
      for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) {
        parser.once(event, () => { rejected = true; parser.destroy(); void fail(new UploadError('INVALID_MULTIPART', 400)); });
      }
      parser.once('close', () => {
        void (async () => {
          if (finished || rejected || response.headersSent || response.destroyed) return;
          try {
            if (!uploaded || fileCount !== 1) throw new UploadError('INVALID_MULTIPART', 400);
            const file = await uploaded;
            await uploads.preflight(file, preflightAbort.signal);
            if (session) page!.sessions.finishUpload(session.sessionId, file.fileId);
            finished = true;
            response.status(201).json({ file_id: file.fileId, filename: file.fileName, sha256: file.sha256 });
          } catch (error) { finished = true; await fail(error); }
        })();
      });
      request.pipe(parser);
    })();
  });
  if (page) {
    app.options(['/contact-upload/import', '/contact-upload/commit', '/contact-upload/exit'], exactHostMiddleware, (_request, response) => {
      response.set('Access-Control-Allow-Origin', '*');
      response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS').status(204).end();
    });
    app.get('/contact-upload', exactHostMiddleware, async (_request, response, next) => {
      try {
        const html = await page.html();
        const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
        const scriptPolicy = script
          ? `'sha256-${createHash('sha256').update(script).digest('base64')}'` : "'none'";
        response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
          'Content-Security-Policy': `default-src 'none'; script-src ${scriptPolicy}; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'` });
        response.type('html').send(html);
      } catch (error) { next(error); }
    });
    app.post('/contact-upload/exchange', exactHostMiddleware, express.json({ limit: '1kb' }), (request, response) => {
      response.set('Cache-Control', 'no-store');
      if (!sameOrigin(request)) { response.status(403).end(); return; }
      const code = typeof request.body?.code === 'string' ? request.body.code : '';
      const exchanged = page.sessions.exchange(code);
      if (!exchanged) { response.status(401).json({ code: 'HANDOFF_INVALID' }); return; }
      response.cookie(cookieName, `${exchanged.sessionId}.${exchanged.bearer}`, {
        secure: !localHost,
        httpOnly: true, sameSite: 'strict', path: '/', maxAge: 2 * 60 * 60_000,
      }).json({ ok: true });
    });
    const json = express.json({ limit: '1kb' });
    app.post('/contact-upload/exit', exactHostMiddleware, (request, response) => {
      response.set('Cache-Control', 'no-store');
      const credential = pageCredential(request);
      if (!credential.bearer && !sameOrigin(request)) { response.status(403).json({ code: 'UPLOAD_ORIGIN_DENIED' }); return; }
      if (!page.sessions.exit(credential.sessionId, credential.secret)) {
        response.status(401).json({ code: 'UPLOAD_SESSION_UNAUTHORIZED' }); return;
      }
      if (credential.bearer) response.set('Access-Control-Allow-Origin', '*');
      response.cookie(cookieName, '', { secure: !localHost, httpOnly: true, sameSite: 'strict', path: '/', maxAge: 0 })
        .json({ ok: true });
    });
    app.post('/contact-upload/import', exactHostMiddleware, pageAuth, json, (request, response) => {
      void (async () => {
        const session = pageContext.get(request)!;
        if (!session.fileId) { response.status(409).json({ code: 'UPLOAD_REQUIRED' }); return; }
        if (session.importId) { response.json({ import_id: session.importId }); return; }
        const result = await page.imports.start({ file_id: session.fileId,
          operation_id: `upload-session:${session.sessionId}:start` }, session.actor);
        page.sessions.bindImport(session.sessionId, result.import_id);
        response.json(result);
      })().catch(error => {
        if (error instanceof ContactRateLimitError) {
          response.set('Retry-After', String(error.retryAfterSeconds)).status(429)
            .json({ code: error.code, retry_after_seconds: error.retryAfterSeconds });
        } else response.status(409).json({ code: 'IMPORT_START_FAILED' });
      });
    });
    app.get('/contact-upload/import', exactHostMiddleware, pageAuth, (request, response) => {
      void (async () => {
        const session = pageContext.get(request)!;
        if (!session.importId) { response.status(409).json({ code: 'IMPORT_NOT_STARTED' }); return; }
        const preview = await page.imports.getUploadPreview(session.importId, session.actor);
        response.json(preview);
      })().catch(() => response.status(400).json({ code: 'INVALID_PREVIEW' }));
    });
    // A successful receipt is deliberately authenticated separately from a mutable upload session.
    const receiptRetry: RequestHandler = (request, response, next) => {
      const credential = pageCredential(request);
      if (credential.cookie && !credential.bearer && !sameOrigin(request)) {
        response.status(403).json({ code: 'UPLOAD_ORIGIN_DENIED' }); return;
      }
      if (request.body !== undefined && (!request.body || Array.isArray(request.body)
        || typeof request.body !== 'object' || Object.keys(request.body).some(key => key !== 'preview_version')
        || !Number.isSafeInteger(request.body.preview_version) || request.body.preview_version < 1)) {
        response.status(400).json({ code: 'INVALID_COMMIT_REQUEST' }); return;
      }
      const receipt = page.sessions.authorizeReceipt(credential.sessionId, credential.secret, request.body?.preview_version);
      if (!receipt) { next(); return; }
      if (credential.bearer) response.set('Access-Control-Allow-Origin', '*');
      response.set('Cache-Control', 'no-store').json(receipt);
    };
    const commits = new Map<string, { version: number; pending: Promise<void> }>();
    const commitOnce = async (session: UploadSession, version: number, secret: string): Promise<void> => {
      if (!session.importId) throw new UploadError('IMPORT_NOT_STARTED', 409);
      // Exit/source revocation during preview loading must prevent a subsequent write.
      if (!page.sessions.bindImport(session.sessionId, session.importId)) throw new UploadError('UPLOAD_SESSION_UNAUTHORIZED', 401);
      const result = await page.imports.commit({ import_id: session.importId,
        preview_version: version, operation_id: `contact-import:${session.importId}`,
        auto_create: true, require_confirmation: true }, session.actor, () => {
        const current = page.sessions.authorize(session.sessionId, secret);
        if (!current || current.actor !== session.actor || current.importId !== session.importId) {
          throw new UploadError('UPLOAD_SESSION_UNAUTHORIZED', 401);
        }
      });
      page.sessions.complete(session.sessionId, version, result);
    };
    app.post('/contact-upload/commit', exactHostMiddleware, json, receiptRetry, pageAuth, (request, response) => {
      void (async () => {
        const session = pageContext.get(request)!;
        const version = request.body?.preview_version;
        const existing = commits.get(session.sessionId);
        if (existing && existing.version !== version) throw new UploadError('PREVIEW_VERSION_CHANGED', 409);
        let pending = existing?.pending;
        if (!pending) {
          pending = commitOnce(session, version, pageCredential(request).secret);
          commits.set(session.sessionId, { version, pending });
          void pending.finally(() => commits.delete(session.sessionId)).catch(() => undefined);
        }
        await pending;
        const credential = pageCredential(request);
        const receipt = page.sessions.authorizeReceipt(session.sessionId, credential.secret, version);
        if (!receipt) throw new UploadError('UPLOAD_SESSION_UNAUTHORIZED', 401);
        // Retain the cookie until explicit exit so a lost response can retry this fixed receipt.
        response.json(receipt);
      })().catch(error => {
        const problem = error instanceof UploadError ? error : new UploadError(
          error instanceof Error && ['MANUAL_REVIEW_REQUIRED', 'PREVIEW_VERSION_CHANGED', 'VERSION_CONFLICT'].includes(error.message)
            ? error.message === 'VERSION_CONFLICT' ? 'PREVIEW_VERSION_CHANGED' : error.message : 'IMPORT_COMMIT_FAILED', 409);
        response.status(problem.status).json({ code: problem.code,
          ...(problem.code === 'MANUAL_REVIEW_REQUIRED' ? { import_id: pageContext.get(request)?.importId } : {}) });
      });
    });
    const pageApiError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
      if (response.headersSent) { next(error); return; }
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      response.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({
        code: status === 413 ? 'UPLOAD_REQUEST_TOO_LARGE' : status === 400 ? 'INVALID_UPLOAD_REQUEST' : 'UPLOAD_REQUEST_FAILED',
      });
    };
    app.use(privateApiPaths, pageApiError);
  }
  let handlerClosing: Promise<void> | null = null;
  app.closeMcpHandler = () => {
    handlerClosing ??= Promise.resolve().then(() => handler.close());
    return handlerClosing;
  };
  return app;
}
