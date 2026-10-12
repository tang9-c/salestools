import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ContactImportService } from '../contacts/import-service.js';
import { ContactRelationTypeSchema } from '../contracts/contact-graph.js';
import { ContactRateLimitError } from '../contacts/contact-rate-limit.js';

const id = z.string().trim().min(1).max(200);
const operationId = id;
const choice = z.object({
  candidate_id: id, action: z.enum(['create', 'merge', 'skip']),
  target_id: id.optional(), expected_target_version: z.int().positive().optional(),
  keep_name: z.boolean().optional(),
  set_properties: z.record(z.string(), z.unknown()).optional(),
  unset_properties: z.array(z.string()).optional(),
  set_extensions: z.record(z.string(), z.unknown()).optional(),
  unset_extensions: z.array(z.string()).optional(),
  evidence: z.array(z.record(z.string(), z.unknown())).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'merge' && (!value.target_id || !value.expected_target_version)) {
    context.addIssue({ code: 'custom', message: 'Merge needs target_id and expected_target_version' });
  }
  if (value.action !== 'merge' && (value.target_id || value.expected_target_version)) {
    context.addIssue({ code: 'custom', message: 'Target is only valid for merge' });
  }
});
const relationChoice = z.object({
  source_candidate_id: id, target_candidate_id: id,
  relation_type: ContactRelationTypeSchema,
  properties: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

function result(output: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
}

function actor(context: { http?: { authInfo?: { clientId?: string } } }): string {
  const clientId = context.http?.authInfo?.clientId;
  if (!clientId) throw new Error('Authenticated client is required');
  return clientId;
}

export function registerContactImportTools(server: McpServer, imports: ContactImportService): void {
  server.registerTool('import_contacts_text', {
    description: '从用户提供的文字提取联系人候选，保存原文与引文；跳过上传及文档解析，不直接入库。先用 get_contact_import 核对，再经用户确认调用 commit_contact_import。保留 operation_id 可安全重试；文字会发送给服务配置的模型。',
    inputSchema: z.object({ text: z.string().min(1).max(20_000).refine(value => !!value.trim()),
      operation_id: operationId }).strict(),
  }, async (input, context) => {
    try { return result(await imports.startText(input, actor(context))); }
    catch (error) {
      if (!(error instanceof ContactRateLimitError)) throw error;
      return { ...result({ code: error.code, retry_after_seconds: error.retryAfterSeconds }), isError: true };
    }
  });
  server.registerTool('import_contacts', {
    description: '处理已上传的 file_id，生成候选预览；保留 operation_id 以便响应丢失后安全重试。此步骤不创建正式联系人。',
    inputSchema: z.object({ file_id: id, operation_id: operationId }).strict(),
  }, async (input, context) => {
    try { return result(await imports.start(input, actor(context))); }
    catch (error) {
      if (!(error instanceof ContactRateLimitError)) throw error;
      return { ...result({ code: error.code, retry_after_seconds: error.retryAfterSeconds }), isError: true };
    }
  });

  server.registerTool('get_contact_import', {
    description: '读取自己的导入状态、分页候选、可能重复的联系人及短引文，不返回完整 OCR 或输入原文。同名、同公司或联系方式匹配仅供人工核对，不能自动合并。信息不足时暂不决定：保留 import_id，不调用提交或取消，之后可继续读取预览。',
    inputSchema: z.object({ import_id: id, offset: z.int().nonnegative().default(0),
      limit: z.int().min(1).max(50).default(20) }).strict(),
  }, async (input, context) => result(await imports.get(input.import_id, actor(context),
    input.offset, input.limit) ?? { found: false }));

  server.registerTool('commit_contact_import', {
    description: '经用户确认入库。有效联系人资料可独立保存，身份待核对；疑似重复和匹配不完整仅作提示。可明确选择 merge 合并、create 新建独立联系人或 skip 跳过。明确合并只解决指定对象，其他身份线索仍保留。merge 默认保留已有单值、补充空字段并追加去重数组；明确替换字段使用 set_properties/set_extensions。auto_create 用于主体明确且有证据的单一人物及证据充分的组织与项目。正式关系需用户确认，不能据同名同公司自动合并。operation_id 固定为 contact-import:<import_id>。',
    inputSchema: z.object({ import_id: id, preview_version: z.int().positive(),
      operation_id: operationId, choices: z.array(choice).max(800).optional(),
      auto_create: z.boolean().optional(),
      relation_choices: z.array(relationChoice).max(800).optional() }).strict(),
  }, async (input, context) => result(await imports.commit(input, actor(context))));

  server.registerTool('cancel_contact_import', {
    description: '取消尚未提交的导入，立即中止处理并清理临时文件；保留 operation_id 以安全重试。',
    inputSchema: z.object({ import_id: id, operation_id: operationId }).strict(),
  }, async (input, context) => result(await imports.cancel(input, actor(context))));
}
