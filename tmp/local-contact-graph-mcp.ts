// Temporary real-host validation adapter. No builds and no remote writes.
import { config } from 'dotenv';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ContactSearch } from '../src/contacts/contact-search.js';
import { ContactLibraryService } from '../src/contacts/library-service.js';
import { registerContactSearchTools } from '../src/mcp/contact-search-tools.js';
import { registerContactTools } from '../src/mcp/contact-tools.js';
import type { GraphClient } from '../src/contacts/graph-client.js';

config({ path: new URL('../.env', import.meta.url).pathname, quiet: true });
const token = process.env.SALESTOOLS_MCP_TOKEN;
if (!token) throw new Error('Local validation needs SALESTOOLS_MCP_TOKEN');
const upstream = new Client({ name: 'local-contact-graph-readonly', version: '1' },
  { versionNegotiation: { mode: 'auto' } });
await upstream.connect(new StreamableHTTPClientTransport(
  new URL('https://oojyeijszmwy.sealosbja.site/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const uri = 'ui://salestools/contact-search-graph.html';
const resource = await upstream.readResource({ uri });
const html = resource.contents.find(c => c.uri === uri && 'text' in c)?.text;
if (typeof html !== 'string' || !html.includes('<script>')) throw new Error('Graph bundle unavailable');
const graph: GraphClient = {
  async request<T>(op, payload): Promise<T> {
    if (op !== 'search_keyword' && op !== 'get_contact') throw new Error('Validation connection is read-only');
    const result = await upstream.callTool({ name: op === 'search_keyword' ? 'search_contacts' : 'get_contact',
      arguments: { ...(payload as Record<string, unknown>), ...(op === 'search_keyword' ? { mode: 'keyword' } : {}) } });
    if (result.isError || !result.structuredContent) throw new Error('Read-only upstream query failed');
    const output = result.structuredContent as Record<string, unknown>;
    process.stderr.write(JSON.stringify({ event: 'local_graph_read', op,
      ...(op === 'search_keyword' ? { total: output.total } : { relations: Array.isArray(output.relations) ? output.relations.length : 0 }) }) + '\n');
    return (output.found === false ? null : output) as T;
  },
  close: () => upstream.close(),
};
const handle = serveStdio(() => {
  const server = new McpServer({ name: 'salestools-local', version: 'graph-ui-validation' });
  registerContactSearchTools(server, new ContactSearch(graph), undefined, { html: async () => html });
  registerContactTools(server, new ContactLibraryService(graph));
  return server;
}, { onerror: () => process.stderr.write('Local MCP transport error\n') });
process.stderr.write(JSON.stringify({ event: 'local_mcp_ready', mode: 'current-source-registration',
  data: 'remote-readonly', html: 'existing-remote-bundle' }) + '\n');
process.stdin.on('end', () => { void handle.close().then(() => upstream.close()); });
