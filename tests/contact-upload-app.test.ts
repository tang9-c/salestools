import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createHttpApp } from '../src/mcp/http-app.js';
import { UploadSessions } from '../src/contacts/upload-session.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });

it('publishes an MCP App, keeps its session tool app-only, and returns a one-use fallback link', async () => {
  const sessions = new UploadSessions(() => true);
  const html = async () => '<html>contact upload</html>';
  const app = createHttpApp({ publicMcpHost: '127.0.0.1', allowedOriginUrls: new Set(),
    allowedOriginHostnames: new Set() }, token => token === 'personal-secret' ? { userId: 'alice' } : null,
  () => ({ contactUpload: { actor: 'alice', sessions, sourceTokenHash: 'source-hash',
    baseUrl: 'https://files.example', html } } as never), undefined,
  { sessions, imports: {} as never, html });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client({ name: 'upload-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),
    { requestInit: { headers: { Authorization: 'Bearer personal-secret' } } }));
  cleanup.push(async () => { await client.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await app.closeMcpHandler(); });
  const tools = await client.listTools();
  const opener = tools.tools.find(tool => tool.name === 'open_contact_upload');
  expect(opener?._meta?.ui).toEqual(expect.objectContaining({ resourceUri: 'ui://salestools/contact-upload.html' }));
  const sessionTool = tools.tools.find(tool => tool.name === 'create_contact_upload_session');
  expect(sessionTool?._meta?.ui).toEqual(expect.objectContaining({ visibility: ['app'] }));
  const result = await client.callTool({ name: 'open_contact_upload', arguments: {} });
  expect(JSON.stringify(result)).not.toContain('personal-secret');
  const url = (result.structuredContent as { fallback_url: string }).fallback_url;
  expect(url).toMatch(/^https:\/\/files\.example\/contact-upload#code=/);
  const code = url.split('#code=')[1];
  expect(sessions.exchange(code)).not.toBeNull();
  expect(sessions.exchange(code)).toBeNull();
  const resource = await client.readResource({ uri: 'ui://salestools/contact-upload.html' });
  expect(resource.contents[0]).toEqual(expect.objectContaining({ text: '<html>contact upload</html>' }));
  const page = await fetch(`${base}/contact-upload`);
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(page.headers.get('referrer-policy')).toBe('no-referrer');
});
