import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import type { Express, RequestHandler } from 'express';
import type { AuthenticatedUser } from '../auth/token-service.js';
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

  app.all('/mcp', exactOriginMiddleware, authMiddleware, (request, response, next) => {
    void nodeHandler(request, response, request.body).catch(next);
  });
  app.closeMcpHandler = () => handler.close();
  return app;
}
