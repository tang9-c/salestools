import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { ContactLibraryService } from '../src/contacts/library-service.js';
import type { GraphClient, GraphOp } from '../src/contacts/graph-client.js';
import { buildMcpServer, type McpServices } from '../src/mcp/tools.js';

function fakeGraph() {
  const request = vi.fn(async (op: GraphOp, payload: unknown) => {
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

  it('registers graph tools only when a graph library is available and returns the complete record', async () => {
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
      const record = await client.callTool({ name: 'get_contact', arguments: { entity_id: 'p_1' } });
      expect(record.structuredContent).toMatchObject({ entity: { entity_id: 'p_1' }, version: 1 });
      const denied = await client.callTool({ name: 'save_contact', arguments: {
        operation_id: 'op', label: 'Person', set_properties: { name: '测试人' }, actor: 'forged',
      } });
      expect(denied.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
