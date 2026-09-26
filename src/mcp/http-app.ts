import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import type { Express, RequestHandler } from 'express';
import Busboy from 'busboy';
import type { AuthenticatedUser } from '../auth/token-service.js';
import { UploadError, type UploadStore, type UploadedFile } from '../contacts/upload-store.js';
import { buildMcpServer, type McpServices } from './tools.js';

export interface McpHttpConfig {
  publicMcpHost: string;
  allowedOriginUrls: ReadonlySet<string>;
  allowedOriginHostnames: ReadonlySet<string>;
}

export type McpHttpApp = Express & {
  closeMcpHandler(): Promise<void>;
};

export function createHttpApp(
  config: McpHttpConfig,
  authenticate: (plaintext: string) => AuthenticatedUser | null,
  servicesFor: (userId: string) => McpServices,
  uploads?: UploadStore,
): McpHttpApp {
  const handler = createMcpHandler(({ authInfo }) => {
    if (!authInfo?.clientId) throw new Error('Authenticated caller is required');
    return buildMcpServer(servicesFor(authInfo.clientId));
  });
  const nodeHandler = toNodeHandler(handler);
  const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: [config.publicMcpHost],
    allowedOrigins: [...config.allowedOriginHostnames],
  }) as McpHttpApp;

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
  if (uploads) app.post('/contact-files', exactHostMiddleware, exactOriginMiddleware, authMiddleware, (request, response) => {
    void (async () => {
      let id: string;
      try { id = await uploads.reserve(); }
      catch (error) {
        const problem = error instanceof UploadError ? error : new UploadError('UPLOAD_FAILED', 500);
        response.status(problem.status).json({ code: problem.code });
        return;
      }
      const fail = async (error: unknown) => {
        await uploads.release(id);
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
      try { parser = Busboy({ headers: request.headers, limits: { files: 2, fields: 1, parts: 2 } }); }
      catch { await fail(new UploadError('INVALID_MULTIPART', 400)); return; }
      let fileCount = 0;
      let uploaded: Promise<UploadedFile> | null = null;
      let finished = false;
      let rejected = false;
      const preflightAbort = new AbortController();
      const disconnect = () => { if (!finished) { preflightAbort.abort(); parser.destroy(); void uploads.release(id); } };
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
            finished = true;
            response.status(201).json({ file_id: file.fileId, filename: file.fileName, sha256: file.sha256 });
          } catch (error) { finished = true; await fail(error); }
        })();
      });
      request.pipe(parser);
    })();
  });
  let handlerClosing: Promise<void> | null = null;
  app.closeMcpHandler = () => {
    handlerClosing ??= Promise.resolve().then(() => handler.close());
    return handlerClosing;
  };
  return app;
}
