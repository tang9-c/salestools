import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { ContactSearch } from '../src/contacts/contact-search.js';
import { registerContactSearchTools } from '../src/mcp/contact-search-tools.js';

describe('search_contacts MCP registration', () => {
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
    } finally { await client.close(); await server.close(); }
  });
});
