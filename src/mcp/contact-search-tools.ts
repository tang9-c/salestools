import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { ContactSearch } from '../contacts/contact-search.js';
import type { VectorIndexer } from '../contacts/vector-indexer.js';

const id = z.string().trim().min(1).max(128);
const searchInput = z.object({
  include_unverified: z.boolean().optional(),
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
  server: McpServer, search: ContactSearch, indexer?: VectorIndexer, app?: { html: () => Promise<string> },
): void {
  const config = {
    description: '搜索共享联系人图谱；关键词可经人物参与项目、项目服务客户的两跳关系按客户名查人，返回 matched_project_id 和 project_client_match。include_unverified 仅允许 keyword 模式且须有非空 query；待核实项目路径返回 claim_ids，旧线索保留 claim_id。organization_id 仍仅按任职或就读过滤。',
    inputSchema: searchInput,
  };
  if (app) {
    const uri = 'ui://salestools/contact-search-graph.html';
    registerAppTool(server, 'search_contacts', { ...config,
      title: '搜索联系人 · 查看关系图谱',
      description: `${config.description} 支持 MCP App 的聊天可展开“联系人图谱”，查看搜索命中节点及直接关联；未显示界面时仍可读取文字结果，不应声称图谱已展示。`,
      _meta: { ui: { resourceUri: uri, visibility: ['model', 'app'] } },
    }, async input => result(await search.search(input)));
    registerAppResource(server, '联系人图谱', uri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{
      uri, mimeType: RESOURCE_MIME_TYPE, text: await app.html(),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    }] }));
  } else server.registerTool('search_contacts', config, async input => result(await search.search(input)));
  if (indexer) server.registerTool('retry_contact_index', {
    description: '用稳定 operation_id 重试当前联系人版本的失败向量索引。',
    inputSchema: retryInput,
  }, async (input, context) => {
    const actor = context.http?.authInfo?.clientId;
    if (!actor) throw new Error('Authenticated client is required');
    return result(await indexer.retryFailed(input.entity_id, input.operation_id, actor));
  });
}
