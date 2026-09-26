import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { registerContactImportTools } from '../src/mcp/contact-import-tools.js';
import type { ContactImportService } from '../src/contacts/import-service.js';

describe('import review choice limit', () => {
  it('can represent every candidate in the eight bounded extraction batches', async () => {
    const server = new McpServer({ name: 'import-limit', version: '1.0.0' });
    registerContactImportTools(server, {} as ContactImportService);
    const client = new Client({ name: 'limit-client', version: '1.0.0' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    await client.connect(left);
    try {
      const tool = (await client.listTools()).tools.find(item => item.name === 'commit_contact_import');
      expect(tool).toBeDefined();
      const properties = tool?.inputSchema.properties as Record<string, { maxItems?: number }>;
      expect(properties.choices.maxItems).toBe(800);
      expect(properties.relation_choices.maxItems).toBe(800);
    } finally { await client.close(); await server.close(); }
  });
});
