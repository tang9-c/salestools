import {
  Client,
  InsufficientScopeError,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { UpstreamError } from '../../orchestration/retry.js';
import { isAllowedQccTool, type QccServer } from './tool-allowlist.js';

export interface QccGatewayConfig {
  urls: Record<QccServer, string>;
  apiKey: string;
  signal?: AbortSignal;
}

export interface QccConnection {
  callTool(tool: string, input: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface QccConnectionFactory {
  create(server: QccServer, url: string, apiKey: string, signal?: AbortSignal): Promise<QccConnection>;
}

export function classifyQccSdkError(error: unknown): UpstreamError | null {
  if (ProtocolError.isInstance(error)) {
    return new UpstreamError('qcc', 'REMOTE_PROTOCOL_ERROR', error.message, { cause: error });
  }
  if (UnauthorizedError.isInstance(error) || InsufficientScopeError.isInstance(error)) {
    return new UpstreamError('qcc', 'AUTHENTICATION_ERROR', error.message, { cause: error });
  }
  if (SdkHttpError.isInstance(error)) {
    return new UpstreamError('qcc', 'REMOTE_HTTP_ERROR', error.message, { cause: error });
  }
  return null;
}

const sdkConnectionFactory: QccConnectionFactory = {
  async create(server, url, apiKey, signal) {
    const client = new Client(
      { name: `salestools-qcc-${server}`, version: '0.1.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` }, signal },
    });
    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw classifyQccSdkError(error) ?? error;
    }

    return {
      async callTool(tool, input) {
        let result;
        try {
          result = await client.callTool({ name: tool, arguments: input } as Parameters<Client['callTool']>[0]);
        } catch (error) {
          throw classifyQccSdkError(error) ?? error;
        }
        if (result.isError === true) {
          throw new UpstreamError('qcc', 'REMOTE_TOOL_ERROR', 'QCC tool returned an error');
        }
        return result.structuredContent ?? result;
      },
      close: () => client.close(),
    };
  },
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class QccGateway {
  private readonly connections = new Map<QccServer, Promise<QccConnection>>();
  private closing: Promise<void> | null = null;
  private readonly abort = (): void => { void this.close(); };

  constructor(
    private readonly config: QccGatewayConfig,
    private readonly factory: QccConnectionFactory = sdkConnectionFactory,
  ) {
    config.signal?.addEventListener('abort', this.abort, { once: true });
  }

  async call(server: QccServer, tool: string, input: Record<string, unknown>): Promise<unknown> {
    if (!isAllowedQccTool(server, tool)) {
      throw new UpstreamError('qcc', 'TOOL_NOT_ALLOWED', `QCC tool is not allowed: ${server}/${tool}`);
    }
    if (isAborted(this.config.signal)) {
      throw new UpstreamError('qcc', 'ABORTED', 'QCC request aborted');
    }

    let pending = this.connections.get(server);
    if (pending === undefined) {
      pending = this.factory.create(server, this.config.urls[server], this.config.apiKey, this.config.signal);
      this.connections.set(server, pending);
    }

    let connection: QccConnection | undefined;
    try {
      connection = await pending;
      if (isAborted(this.config.signal)) {
        throw new UpstreamError('qcc', 'ABORTED', 'QCC request aborted');
      }
      return await connection.callTool(tool, input);
    } catch (error) {
      if (isAborted(this.config.signal)) {
        throw new UpstreamError('qcc', 'ABORTED', 'QCC request aborted', { cause: error });
      }
      if (connection === undefined) {
        if (this.connections.get(server) === pending) this.connections.delete(server);
        if (error instanceof UpstreamError) throw error;
        const message = error instanceof Error ? error.message : 'QCC connection failed';
        throw new UpstreamError('qcc', 'TRANSPORT', message, { cause: error });
      }
      if (error instanceof UpstreamError && error.code !== 'TRANSPORT') throw error;
      if (this.connections.get(server) === pending) {
        this.connections.delete(server);
        await connection.close().catch(() => undefined);
      }
      if (error instanceof UpstreamError) throw error;
      const message = error instanceof Error ? error.message : 'QCC transport failed';
      throw new UpstreamError('qcc', 'TRANSPORT', message, { cause: error });
    }
  }

  async close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.config.signal?.removeEventListener('abort', this.abort);
    const pending = [...this.connections.values()];
    this.connections.clear();
    this.closing = Promise.allSettled(
      pending.map(async connection => (await connection).close()),
    ).then(() => undefined);
    return this.closing;
  }
}
