import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ContactSearch } from '../contacts/contact-search.js';
import type { VectorIndexer } from '../contacts/vector-indexer.js';

const id = z.string().trim().min(1).max(128);
const searchInput = z.object({
  query: z.string().trim().max(500).optional(),
  name: z.string().trim().max(200).optional(),
  organization_id: id.optional(),
  job_title: z.string().trim().max(200).optional(),
  skill: z.string().trim().max(200).optional(),
  mode: z.enum(['keyword', 'semantic', 'hybrid']).default('keyword'),
  offset: z.int().min(0).max(10_000).default(0),
  limit: z.int().min(1).max(50).default(10),
}).strict();
const retryInput = z.object({
  entity_id: id, operation_id: z.string().trim().min(1).max(200),
}).strict();

function result(output: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
}

export function registerContactSearchTools(
  server: McpServer, search: ContactSearch, indexer?: VectorIndexer,
): void {
  server.registerTool('search_contacts', {
    description: '搜索共享联系人图谱；支持字段过滤、关键词以及可用时的语义或混合检索。',
    inputSchema: searchInput,
  }, async input => result(await search.search(input)));
  if (indexer) server.registerTool('retry_contact_index', {
    description: '用稳定 operation_id 重试当前联系人版本的失败向量索引。',
    inputSchema: retryInput,
  }, async (input, context) => {
    const actor = context.http?.authInfo?.clientId;
    if (!actor) throw new Error('Authenticated client is required');
    return result(await indexer.retryFailed(input.entity_id, input.operation_id, actor));
  });
}
