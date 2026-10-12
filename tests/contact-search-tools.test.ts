import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { ContactLibraryService } from '../src/contacts/library-service.js';
import { registerContactTools } from '../src/mcp/contact-tools.js';
import type { GraphClient } from '../src/contacts/graph-client.js';
import type { ContactSearch } from '../src/contacts/contact-search.js';
import { registerContactSearchTools } from '../src/mcp/contact-search-tools.js';

describe('search_contacts MCP registration', () => {
  it('attaches a read-only App resource without changing search JSON or opening another App for detail', async () => {
    const output = { items: [], total: 0, mode_used: 'keyword' as const, warnings: [] };
    const server = new McpServer({ name: 'graph-app-test', version: '1' });
    registerContactSearchTools(server, { search: async () => output } as unknown as ContactSearch,
      undefined, { html: async () => '<html>联系人图谱</html>' });
    registerContactTools(server, new ContactLibraryService({ request: async () => null } as unknown as GraphClient));
    const client = new Client({ name: 'client', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right); await client.connect(left);
    try {
      const tools = (await client.listTools()).tools;
      const searchTool = tools.find(t => t.name === 'search_contacts');
      expect(searchTool?.title).toEqual(expect.stringMatching(/联系人.*图谱/));
      expect(searchTool?.description).toContain('展开');
      expect(searchTool?.description).toContain('文字');
      expect(tools.find(t => t.name === 'search_contacts')?._meta).toMatchObject({
        ui: { resourceUri: 'ui://salestools/contact-search-graph.html', visibility: ['model', 'app'] },
      });
      expect(searchTool?._meta?.['ui/resourceUri']).toBe('ui://salestools/contact-search-graph.html');
      expect(tools.find(t => t.name === 'get_contact')?._meta).toMatchObject({ ui: { visibility: ['model', 'app'] } });
      expect(tools.find(t => t.name === 'get_contact')?._meta?.ui).not.toHaveProperty('resourceUri');
      const result = await client.callTool({ name: 'search_contacts', arguments: {} });
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(output) }]);
      expect(result.structuredContent).toEqual(output);
      const resourceUri = (searchTool?._meta?.ui as { resourceUri: string }).resourceUri;
      const resource = await client.readResource({ uri: resourceUri });
      expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', text: '<html>联系人图谱</html>' });
    } finally { await client.close(); await server.close(); }
  });
  it('exposes bounded graph search and rejects unexpected parameters', async () => {
    const search = vi.fn(async () => ({ items: [{ entity_id: 'p1', label: 'Person', name: '陈晓' }],
      total: 1, mode_used: 'keyword' as const, warnings: [] }));
    const server = new McpServer({ name: 'search-test', version: '1.0.0' });
    registerContactSearchTools(server, { search } as unknown as ContactSearch);
    const client = new Client({ name: 'client', version: '1.0.0' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    await client.connect(left);
    try {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain('search_contacts');
      expect(names).not.toContain('retry_contact_index');
      const response = await client.callTool({ name: 'search_contacts', arguments: { name: '陈晓' } });
      expect(response.structuredContent).toMatchObject({ total: 1, items: [{ entity_id: 'p1' }] });
      expect(search).toHaveBeenCalledWith({ name: '陈晓', mode: 'keyword', offset: 0, limit: 10 });
      for (const args of [{ name: '陈晓', limit: 51 }, { name: '陈晓', actor: 'forged' }]) {
        expect((await client.callTool({ name: 'search_contacts', arguments: args })).isError).toBe(true);
      }
      expect(search).toHaveBeenCalledTimes(1);
      const optIn = await client.callTool({ name: 'search_contacts', arguments: { query: 'Academy', include_unverified: true } });
      expect(optIn.isError).not.toBe(true);
      expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ include_unverified: true }));
    } finally { await client.close(); await server.close(); }
  });
});


it('get_contact forwards independent bounded claim pagination through the library', async () => {
  const request = vi.fn(async () => ({ unverified_claims: [], pagination: { unverified_claims: { total: 4, next_offset: 3 } } }));
  const server = new McpServer({ name: 'detail-test', version: '1.0.0' });
  registerContactTools(server, new ContactLibraryService({ request } as unknown as GraphClient));
  const client = new Client({ name: 'client', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  try {
    const response = await client.callTool({ name: 'get_contact', arguments: {
      entity_id: 'p1', evidence_offset: 8, relation_offset: 9, claim_offset: 2, claim_limit: 1,
    } });
    expect(response.isError).not.toBe(true);
    expect(request).toHaveBeenCalledWith('get_contact', {
      entity_id: 'p1', evidence_offset: 8, relation_offset: 9, claim_offset: 2, claim_limit: 1,
    });
    expect(response.structuredContent).toMatchObject({ pagination: { unverified_claims: { next_offset: 3 } } });
    for (const page of [{ claim_limit: 51 }, { claim_offset: -1 }]) {
      expect((await client.callTool({ name: 'get_contact', arguments: { entity_id: 'p1', ...page } })).isError).toBe(true);
    }
    expect(request).toHaveBeenCalledTimes(1);
  } finally { await client.close(); await server.close(); }
});
