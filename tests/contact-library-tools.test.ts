import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ContactLibraryService } from '../src/contacts/library-service.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/index.js';
import { buildMcpServer, type McpServices } from '../src/mcp/tools.js';

function fakeGraph() {
  const request = vi.fn(async (op: GraphOp, payload: unknown): Promise<unknown> => {
    if (op === 'get_contact') return {
      entity: { entity_id: 'p_1', label: 'Person', properties: { name: '测试人' } },
      evidence: [], conflicts: [], relations: [], version: 1,
    };
    return { entity_id: 'p_1', version: 1, replayed: false, op, payload };
  });
  return { request, close: vi.fn(async () => undefined) } as unknown as GraphClient & { request: typeof request };
}

describe('shared contact library tools', () => {
  it('derives the actor from the authenticated caller and never accepts a user-supplied actor', async () => {
    const graph = fakeGraph();
    const library = new ContactLibraryService(graph);
    await library.save({ operation_id: 'once', label: 'Person', set_properties: { name: '测试人' } }, 'client-a');
    expect(graph.request).toHaveBeenCalledWith('save_contact', {
      operation_id: 'once', label: 'Person', set_properties: { name: '测试人' }, actor: 'client-a',
    });
    await expect(library.save({ operation_id: 'twice', actor: 'forged' }, '')).rejects.toThrow('Authenticated');
    expect(graph.request).toHaveBeenCalledTimes(1);
  });

  it('registers graph tools and forwards contact page offsets', async () => {
    const graph = fakeGraph();
    const server = buildMcpServer({ contactLibrary: new ContactLibraryService(graph) } as McpServices);
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'get_contact', 'save_contact', 'merge_contacts', 'delete_contact',
        'save_contact_relation', 'delete_contact_relation',
      ]));
      const record = await client.callTool({ name: 'get_contact', arguments: {
        entity_id: 'p_1', evidence_offset: 50, evidence_limit: 10,
        relation_offset: 20, relation_limit: 10,
      } });
      expect(record.structuredContent).toMatchObject({ entity: { entity_id: 'p_1' }, version: 1 });
      expect(graph.request).toHaveBeenCalledWith('get_contact', {
        entity_id: 'p_1', evidence_offset: 50, evidence_limit: 10,
        relation_offset: 20, relation_limit: 10,
      });
      const denied = await client.callTool({ name: 'save_contact', arguments: {
        operation_id: 'op', label: 'Person', set_properties: { name: '测试人' }, actor: 'forged',
      } });
      expect(denied.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('binds graph writes to each authenticated HTTP client identity', async () => {
    const graph = fakeGraph();
    graph.request.mockImplementation(async (op: GraphOp, payload: unknown) => {
      if (op === 'get_sync_cursor') return { initialized: false, last_snapshot_id: 0 };
      return { entity_id: 'p_1', version: 1, replayed: false, payload };
    });
    const config = loadConfig({
      PORT: '3000', PUBLIC_MCP_HOST: '127.0.0.1', ALLOWED_ORIGINS: 'https://codex.example.cn',
      SQLITE_PATH: ':memory:', QCC_MCP_COMPANY_URL: 'https://agent.qcc.com/mcp/company/stream',
      QCC_MCP_RISK_URL: 'https://agent.qcc.com/mcp/risk/stream',
      QCC_MCP_IPR_URL: 'https://agent.qcc.com/mcp/ipr/stream',
      QCC_MCP_OPERATION_URL: 'https://agent.qcc.com/mcp/operation/stream', QCC_API_KEY: 'fake-qcc',
      DOUBAO_SEARCH_API_URL: 'https://search.example.cn/search', DOUBAO_SEARCH_API_KEY: 'fake-search',
      ARK_API_URL: 'https://ark.example.cn/chat', ARK_MODEL: 'fake-model', ARK_CREDENTIAL: 'fake-ark',
      CONTACT_GRAPH_ENABLED: 'true', CONTACT_GRAPH_BIN: '/bin/true',
      CONTACT_GRAPH_SQLITE_PATH: '/tmp/contact-library-tools.sqlite',
    });
    const runtime = createApplication(config, { graphClient: graph });
    const clients: Client[] = [];
    try {
      const server = await runtime.listen(0, '127.0.0.1');
      for (const name of ['sales-a', 'sales-b']) {
        const token = runtime.tokenService.create(name);
        const client = new Client({ name, version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),
          { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
        ));
        clients.push(client);
        const response = await client.callTool({ name: 'save_contact', arguments: {
          operation_id: `save-${name}`, label: 'Person', set_properties: { name: '测试人' },
        } });
        expect(response.isError).not.toBe(true);
      }
      const actors = graph.request.mock.calls
        .filter(([op]) => op === 'save_contact')
        .map(([, payload]) => (payload as { actor: string }).actor);
      expect(actors).toEqual(['sales-a', 'sales-b']);
    } finally {
      await Promise.allSettled(clients.map(client => client.close()));
      await runtime.close(5);
    }
  });
});
