import type {
  McpServer,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CompanyResearchService } from '../research/service.js';
import type { ResearchQueue } from '../research/queue.js';
import { ResearchError } from '../research/repository.js';
import {
  StartResearchInputSchema,
  ProductKeySchema,
  ResearchRunSchema,
  ResearchSnapshotSchema,
  ResearchVersionSchema,
  ResearchCoverageSchema,
  ResearchEvidenceSchema,
} from '../research/contracts.js';
import { selectEvidence } from '../research/render.js';
export interface CompanyResearchTools {
  enabled: boolean;
  service: CompanyResearchService;
  queue: ResearchQueue;
}
const id = z.string().trim().min(1).max(200);
const offset = z.number().int().nonnegative().default(0);
// Envelope metadata is intentionally independent of supported result templates.
const metadata = {
  template: z
    .object({ id: z.string(), version: z.number().int().positive() })
    .strict()
    .nullable(),
  schema_version: z.number().int().positive().nullable(),
  method_version: z.string().nullable(),
};
const runOutput = ResearchRunSchema.omit({
  request: true,
  request_hash: true,
  operation_id: true,
}).extend(metadata);
const versionOutput = ResearchVersionSchema.omit({
  snapshot: true,
  scope: true,
}).extend({ ...metadata, product_keys: z.array(z.string()) });
const page = {
  total: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
};
const outputSchemas: Record<string, z.ZodObject> = {
  start_company_research: z
    .object({
      run_id: id,
      dossier_id: id,
      status: ResearchRunSchema.shape.status,
      replayed: z.boolean(),
      template: ResearchSnapshotSchema.shape.template,
      schema_version: z.literal(1),
    })
    .strict(),
  get_company_research_status: runOutput,
  cancel_company_research: runOutput,
  list_company_research_versions: z
    .object({ dossier_id: id, items: z.array(versionOutput), ...page })
    .strict(),
  get_company_research_evidence: z
    .object({
      version_id: id,
      items: z.array(ResearchEvidenceSchema),
      ...page,
      ...metadata,
    })
    .strict(),
  get_company_research: z
    .object(ResearchSnapshotSchema.shape)
    .strict()
    .pick({
      template: true,
      schema_version: true,
      method_version: true,
      summary: true,
      template_result: true,
      product_keys: true,
      claims: true,
      gaps: true,
      changes: true,
      product_assessments: true,
      dossier_id: true,
    })
    .extend({
      version_id: id,
      as_of: z.string(),
      coverage: z.array(
        ResearchCoverageSchema.extend({
          template: ResearchSnapshotSchema.shape.template,
          version_id: id,
          as_of: z.string(),
        }),
      ),
    }),
};
export function registerCompanyResearchTools(
  server: McpServer,
  research: CompanyResearchTools,
): void {
  if (!research.enabled) return;
  const { service, queue } = research;
  const repo = service.repository;
  const register = <S extends z.ZodType & StandardSchemaWithJSON>(
    name: string,
    description: string,
    inputSchema: S,
    work: (input: z.output<S>, actor: string) => Record<string, unknown>,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: inputSchema as StandardSchemaWithJSON,
        outputSchema: outputSchemas[name],
      },
      async (input, context) => {
        try {
          const actor = context.http?.authInfo?.clientId;
          if (!actor?.trim())
            throw new ResearchError('RESEARCH_UNAUTHENTICATED');
          const result = outputSchemas[name].parse(
            work(inputSchema.parse(input), actor),
          );
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  typeof result.summary === 'string'
                    ? result.summary
                    : '企业研究操作已完成。',
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          const code =
            error instanceof ResearchError
              ? error.message
              : error instanceof z.ZodError
                ? 'RESEARCH_INVALID_INPUT'
                : error instanceof Error &&
                    [
                      'RESEARCH_VERSION_UNSUPPORTED',
                      'RESEARCH_CLAIM_NOT_FOUND',
                      'RESEARCH_EVIDENCE_INCOMPLETE',
                    ].includes(error.message)
                  ? error.message
                  : 'RESEARCH_FAILED';
          const result = {
            error_code: code,
            ...(error instanceof ResearchError ? error.details : {}),
          };
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: `企业研究操作未完成：${code}` },
            ],
            structuredContent: result,
          };
        }
      },
    );
  };
  register(
    'start_company_research',
    '首次研究、继续解决缺口或更新企业研究；会创建有预算的异步任务。先通过画像确认主体。',
    StartResearchInputSchema,
    (input, actor) => {
      queue.assertAccepting();
      const run = service.start(input, actor);
      queue.enqueue();
      return {
        run_id: run.run_id,
        dossier_id: run.dossier_id,
        status: run.status,
        replayed: run.replayed,
        template: run.template,
        schema_version: run.request.schema_version,
      };
    },
  );
  register(
    'get_company_research_status',
    '读取研究进度、预算和停止原因，不请求上游。',
    z.object({ run_id: id }).strict(),
    (input) => {
      const run = repo.runMetadata(input.run_id);
      if (!run) throw new ResearchError('RESEARCH_RUN_NOT_FOUND');
      return run;
    },
  );
  register(
    'get_company_research',
    '读取共享企业研究版本的简要结论、产品覆盖、引用和缺口，不请求上游。',
    z
      .object({
        dossier_id: id.optional(),
        credit_code: z
          .string()
          .regex(/^[0-9A-Z]{18}$/)
          .optional(),
        version_id: id.optional(),
      })
      .strict()
      .refine(
        (v) => Boolean(v.dossier_id) !== Boolean(v.credit_code),
        '指定一个企业标识',
      ),
    (input) => {
      const dossier = input.dossier_id
        ? repo.getDossier(input.dossier_id)
        : repo.dossierByCreditCode(input.credit_code!);
      if (!dossier) throw new ResearchError('RESEARCH_DOSSIER_NOT_FOUND');
      const version = input.version_id
        ? repo.getVersion(input.version_id)
        : repo.latestVersion(dossier.dossier_id);
      if (!version) throw new ResearchError('RESEARCH_VERSION_NOT_FOUND');
      if (version.dossier_id !== dossier.dossier_id)
        throw new ResearchError('RESEARCH_VERSION_CONFLICT');
      const s = version.snapshot;
      return {
        dossier_id: dossier.dossier_id,
        version_id: version.version_id,
        as_of: version.created_at,
        template: s.template,
        schema_version: s.schema_version,
        method_version: s.method_version,
        summary: s.summary,
        template_result: s.template_result,
        product_keys: s.product_keys,
        coverage: s.coverage.map((c) => ({
          ...c,
          template: s.template,
          version_id: version.version_id,
          as_of: version.created_at,
        })),
        claims: s.claims,
        gaps: s.gaps,
        changes: s.changes,
        product_assessments: s.product_assessments,
      };
    },
  );
  register(
    'list_company_research_versions',
    '分页读取共享档案的版本目录和模板元数据，不请求上游。',
    z
      .object({
        dossier_id: id,
        offset,
        limit: z.number().int().min(1).max(50).default(10),
      })
      .strict(),
    (input) => {
      if (!repo.getDossier(input.dossier_id))
        throw new ResearchError('RESEARCH_DOSSIER_NOT_FOUND');
      return {
        dossier_id: input.dossier_id,
        ...repo.versionMetadata(input.dossier_id, input.offset, input.limit),
      };
    },
  );
  register(
    'get_company_research_evidence',
    '分页展开固定版本的证据、日期和原始定位；纯数据库读取不启动研究。',
    z
      .object({
        version_id: id,
        claim_id: id.optional(),
        product: ProductKeySchema.optional(),
        offset,
        limit: z.number().int().min(1).max(20).default(10),
      })
      .strict()
      .refine((v) => !(v.claim_id && v.product), '筛选条件互斥'),
    (input) => {
      const v = repo.getVersion(input.version_id);
      if (!v) throw new ResearchError('RESEARCH_VERSION_NOT_FOUND');
      return {
        ...selectEvidence(
          v,
          { claim_id: input.claim_id, product: input.product },
          { offset: input.offset, limit: input.limit },
        ),
        template: v.snapshot.template,
        schema_version: v.snapshot.schema_version,
        method_version: v.snapshot.method_version,
      };
    },
  );
  register(
    'cancel_company_research',
    '取消共享研究并记录当前认证操作者；已结束任务保持原状态。',
    z.object({ run_id: id }).strict(),
    (input, actor) => {
      queue.cancel(input.run_id, actor);
      return repo.runMetadata(input.run_id)!;
    },
  );
}
