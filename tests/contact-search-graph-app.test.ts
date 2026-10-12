import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { createHttpApp } from '../src/mcp/http-app.js';
import type { McpServices } from '../src/mcp/tools.js';
import type { ContactSearch } from '../src/contacts/contact-search.js';
import { ContactLibraryService } from '../src/contacts/library-service.js';
import type { GraphClient } from '../src/contacts/graph-client.js';
import { readFile } from 'node:fs/promises';

it('serves the graph resource through authenticated HTTP MCP without tokens or new HTTP data routes', async () => {
  const output = { items: [], total: 0, mode_used: 'keyword' as const, warnings: [] };
  const html = process.env.CONTACT_UPLOAD_BUNDLE_REQUIRED === '1'
    ? await readFile('web/dist/contact-search-graph.html', 'utf8') : '<html>联系人图谱</html>';
  const services = { contactSearch: { search: async () => output } as unknown as ContactSearch,
    contactSearchApp: { html: async () => html },
    contactLibrary: new ContactLibraryService({ request: async () => null } as unknown as GraphClient) } as McpServices;
  const app = createHttpApp({ publicMcpHost: '127.0.0.1', allowedOriginUrls: new Set(), allowedOriginHostnames: new Set() },
    token => token === 'fixture-personal-secret' ? { userId: 'alice' } : null, () => services);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client({ name: 'graph-http-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  try {
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid-token' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${url}/contact-search-graph`)).status).toBe(404);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`),
      { requestInit: { headers: { Authorization: 'Bearer fixture-personal-secret' } } }));
    const tool = (await client.listTools()).tools.find(t => t.name === 'search_contacts');
    expect(tool?.title).toEqual(expect.stringMatching(/联系人.*图谱/));
    const resourceUri = (tool?._meta?.ui as { resourceUri: string }).resourceUri;
    expect(resourceUri).toBe('ui://salestools/contact-search-graph.html');
    expect(tool?._meta?.['ui/resourceUri']).toBe(resourceUri);
    const resource = await client.readResource({ uri: resourceUri });
    expect(resource.contents[0]).toMatchObject({ text: html });
    expect(resource.contents[0]._meta).toMatchObject({ ui: { csp: { connectDomains: [], resourceDomains: [] } } });
    expect(JSON.stringify(resource)).not.toContain('fixture-personal-secret');
    expect((await client.callTool({ name: 'search_contacts', arguments: { name: '张敏' } })).structuredContent).toEqual(output);
    expect((await client.callTool({ name: 'get_contact', arguments: { entity_id: 'p1' } })).structuredContent).toEqual({ found: false });
    expect((await client.listTools()).tools.map(t => t.name)).not.toContain('open_contact_graph');
  } finally {
    await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await app.closeMcpHandler();
  }
});
