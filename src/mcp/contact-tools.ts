import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ContactLibraryService } from '../contacts/library-service.js';
import { ContactRelationTypeSchema } from '../contracts/contact-graph.js';

const id = z.string().trim().min(1).max(128);
const operationId = z.string().trim().min(1).max(200);
const version = z.int().positive();
const fields = z.record(z.string().min(1), z.unknown());
const proof = z.array(z.record(z.string().min(1), z.unknown())).max(256);

const getInput = z.object({
  entity_id: id,
  evidence_offset: z.int().nonnegative().optional(),
  evidence_limit: z.int().min(1).max(50).optional(),
  claim_offset: z.int().nonnegative().optional(),
  claim_limit: z.int().min(0).max(50).optional(),
  relation_offset: z.int().nonnegative().optional(),
  relation_limit: z.int().min(1).max(50).optional(),
}).strict();
const saveInput = z.object({
  operation_id: operationId,
  action: z.enum(['save', 'restore']).default('save'),
  label: z.enum(['Person', 'Organization', 'Project']).optional(),
  entity_id: id.optional(), expected_version: version.optional(),
  set_properties: fields.optional(), unset_properties: z.array(z.string().min(1)).optional(),
  set_extensions: fields.optional(), unset_extensions: z.array(z.string().min(1)).optional(),
  evidence: proof.optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'restore' && (!value.entity_id || !value.expected_version)) {
    context.addIssue({ code: 'custom', message: 'Restore needs entity_id and expected_version' });
  }
  if (value.action === 'restore' && (value.label || value.set_properties || value.unset_properties
    || value.set_extensions || value.unset_extensions || value.evidence)) {
    context.addIssue({ code: 'custom', message: 'Restore cannot include field changes' });
  }
  if (value.action === 'save' && !value.label) {
    context.addIssue({ code: 'custom', message: 'Save needs label' });
  }
  if (value.action === 'save' && value.entity_id && !value.expected_version) {
    context.addIssue({ code: 'custom', message: 'Updating a contact needs expected_version' });
  }
  if (value.action === 'save' && !value.entity_id && value.expected_version) {
    context.addIssue({ code: 'custom', message: 'Creating a contact cannot set expected_version' });
  }
});
const mergeInput = z.object({
  operation_id: operationId, source_id: id, target_id: id,
  expected_source_version: version, expected_target_version: version,
  field_choices: z.record(z.string().min(1), z.enum(['source', 'target'])).optional(),
}).strict();
const archiveContactInput = z.object({
  operation_id: operationId, entity_id: id, expected_version: version,
}).strict();
const saveRelationInput = z.object({
  operation_id: operationId, source_id: id, target_id: id,
  relation_type: ContactRelationTypeSchema,
  properties: fields.optional(), metadata: fields.optional(), evidence: proof.optional(),
}).strict();
const reviewClaimInput = z.object({
  claim_id: id, action: z.enum(['confirm', 'reject']), operation_id: operationId,
  expected_entity_version: version, target_id: id.optional(), corrected_value: z.unknown().optional(),
  confirmation_note: z.string().trim().min(1).refine(value => [...value].length <= 500,
    '审核说明最多 500 字符').optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'confirm' && !value.confirmation_note) {
    context.addIssue({ code: 'custom', message: 'Confirm requires confirmation_note' });
  }
});
const archiveRelationInput = z.object({
  operation_id: operationId, relation_id: id, expected_version: version,
}).strict();

function result(output: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
}

function actor(context: { http?: { authInfo?: { clientId?: string } } }): string {
  const clientId = context.http?.authInfo?.clientId;
  if (!clientId) throw new Error('Authenticated client is required');
  return clientId;
}

export function registerContactTools(server: McpServer, library: ContactLibraryService): void {
  server.registerTool('get_contact', {
    description: '分页读取共享联系人档案、字段证据、冲突及当前关系；按 pagination.evidence、pagination.relations、pagination.unverified_claims 的 next_offset 分别翻页；待核实线索使用独立 claim_offset/claim_limit，不是正式事实。与公开网页搜索 discover_contacts 区分。',
    inputSchema: getInput,
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ entity_id, ...page }) => {
    const contact = await library.get(entity_id, page);
    return result(contact ?? { found: false });
  });

  server.registerTool('save_contact', {
    description: '创建或按版本修改共享 Person/Organization/Project 档案；保留 operation_id 以安全重试。恢复归档档案需 action=restore。',
    inputSchema: saveInput,
  }, async (input, context) => {
    const { action, ...payload } = input;
    if (action === 'restore') {
      return result(await library.restore({
        operation_id: payload.operation_id,
        entity_id: payload.entity_id,
        expected_version: payload.expected_version,
      }, actor(context)));
    }
    return result(await library.save(payload, actor(context)));
  });

  server.registerTool('merge_contacts', {
    description: '人工确认重复 Person 后合并，需双方版本及字段取舍；手机号相同仅是候选线索。',
    inputSchema: mergeInput,
  }, async (input, context) => result(await library.merge(input, actor(context))));

  server.registerTool('delete_contact', {
    description: '按版本归档共享联系人，不删除来源证据；保留 operation_id 以安全重试。',
    inputSchema: archiveContactInput,
  }, async (input, context) => result(await library.delete(input, actor(context))));

  server.registerTool('save_contact_relation', {
    description: '记录经过确认的人物关系或独立任职段；每段 worksFor 关系都可保留单独角色和日期。',
    inputSchema: saveRelationInput,
  }, async (input, context) => result(await library.saveRelation(input, actor(context))));

  server.registerTool('review_contact_claim', {
    description: '明确确认或拒绝待核实断言，须提供当前实体版本与可重试 operation_id。confirm 必须附 1–500 字符人工审核说明；关系须有已创建且类型正确的 target_id。corrected_value 对字段是更正值（数组追加去重），对关系是 {properties, metadata?}；逐段确认 worksFor。未确认线索不会成为问答事实。',
    inputSchema: reviewClaimInput,
  }, async (input, context) => result(await library.reviewClaim(input, actor(context))));

  server.registerTool('delete_contact_relation', {
    description: '按版本归档一条关系，保留原始证据和审计记录。',
    inputSchema: archiveRelationInput,
  }, async (input, context) => result(await library.deleteRelation(input, actor(context))));
}
