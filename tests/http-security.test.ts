import type { AddressInfo } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from '../src/auth/token-service.js';
import { createHttpApp } from '../src/mcp/http-app.js';
import type { McpServices } from '../src/mcp/tools.js';

const config = {
  publicMcpHost: 'mcp.example.cn',
  allowedOriginUrls: new Set(['https://codex.example.cn:8443']),
  allowedOriginHostnames: new Set(['codex.example.cn']),
};
const processing = {
  assessmentId: '10bd94c4-724a-4ca9-87fb-f474f563d475',
  status: 'processing' as const,
  message: 'processing',
};

function noOpServices(): McpServices {
  return {
    getCompanyProfile: async () => ({
      sourceStatus: 'failed', candidates: [], basicProfile: null, cacheHit: false, message: 'unused',
    }),
    submitAssessment: async () => ({
      assessmentId: processing.assessmentId, status: 'processing', estimatedMinutes: '5-10', cacheHit: false,
    }),
    getAssessmentStatus: async () => processing,
    getAssessmentReport: async () => processing,
  };
}

function initializeBody() {
  return {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'http-test', version: '1.0.0' },
    },
  };
}

describe('MCP HTTP security boundary', () => {
  let server: Server | undefined;
  let closeHandler: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (closeHandler !== undefined) await closeHandler();
  });

  async function start(
    authenticate: (token: string) => AuthenticatedUser | null,
    servicesFor: (userId: string) => McpServices,
  ) {
    const app = createHttpApp(config, authenticate, servicesFor);
    closeHandler = app.closeMcpHandler;
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}/mcp`;
  }

  async function request(
    url: string,
    method: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<{ status: number; headers: IncomingHttpHeaders }> {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        headers: { Host: 'mcp.example.cn', ...headers },
      }, incoming => {
        incoming.resume();
        incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers }));
      });
      outgoing.once('error', reject);
      if (body !== undefined) outgoing.write(body);
      outgoing.end();
    });
  }

  function post(url: string, headers: Record<string, string> = {}, body: unknown = initializeBody()) {
    return request(url, 'POST', {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    }, JSON.stringify(body));
  }

  it.each([
    'http://codex.example.cn:8443',
    'https://codex.example.cn',
    'https://evil.example.cn:8443',
  ])('rejects a non-exact Origin with 403 before authentication: %s', async origin => {
    let authenticationCalls = 0;
    const url = await start(() => {
      authenticationCalls += 1;
      return null;
    }, noOpServices);

    const response = await post(url, { Origin: origin, Authorization: 'Bearer valid-token' });
    expect(response.status).toBe(403);
    expect(authenticationCalls).toBe(0);
  });

  it('accepts the exact full Origin and forwards verified req.auth to caller-scoped services', async () => {
    const selectedUsers: string[] = [];
    const submittedUsers: string[] = [];
    const url = await start(token => token === 'valid-token' ? { userId: 'user-2' } : null, userId => {
      selectedUsers.push(userId);
      return {
        ...noOpServices(),
        submitAssessment: async (_input, submittedBy) => {
          submittedUsers.push(submittedBy);
          return {
            assessmentId: processing.assessmentId,
            status: 'processing',
            estimatedMinutes: '5-10',
            cacheHit: false,
          };
        },
      };
    });

    const headers = {
      Origin: 'https://codex.example.cn:8443', Authorization: 'Bearer valid-token',
    };
    const response = await post(url, headers);
    expect(response.status).toBe(200);

    const toolCall = await post(url, headers, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'submit_assessment',
        arguments: { legal_name: '测试制造有限公司', credit_code: '91310000TEST000001' },
      },
    });
    expect(toolCall.status).toBe(200);
    expect(selectedUsers).toEqual(['user-2', 'user-2']);
    expect(submittedUsers).toEqual(['user-2']);
  });

  it('allows a missing Origin to reach Bearer authentication', async () => {
    let authenticationCalls = 0;
    const url = await start(() => {
      authenticationCalls += 1;
      return null;
    }, noOpServices);

    const response = await post(url);
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(authenticationCalls).toBe(0);

    const invalid = await post(url, { Authorization: 'Bearer wrong' });
    expect(invalid.status).toBe(401);
    expect(authenticationCalls).toBe(1);
  });

  it('rejects invalid Host before Origin and authentication', async () => {
    let authenticationCalls = 0;
    const url = await start(() => {
      authenticationCalls += 1;
      return { userId: 'user-1' };
    }, noOpServices);

    const response = await post(url, {
      Host: 'evil.example.cn',
      Origin: 'https://codex.example.cn:8443',
      Authorization: 'Bearer valid-token',
    });
    expect(response.status).toBe(403);
    expect(authenticationCalls).toBe(0);
  });

  it('applies authentication to every /mcp method', async () => {
    const url = await start(() => null, noOpServices);
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await request(url, method);
      expect(response.status).toBe(401);
    }
  });

  it('memoizes MCP handler shutdown so repeated close requests share one operation', async () => {
    const app = createHttpApp(config, () => ({ userId: 'user-1' }), noOpServices);
    const first = app.closeMcpHandler();
    const second = app.closeMcpHandler();
    expect(second).toBe(first);
    await first;
  });
});
