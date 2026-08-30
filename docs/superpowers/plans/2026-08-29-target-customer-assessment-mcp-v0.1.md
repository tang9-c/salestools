# 目标客户体检远程 MCP v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个部署在中国大陆云上的远程 MCP 服务，让 Codex 先查询企业基础画像，再异步生成可追溯来源的七产品销售机会报告。

**Architecture:** 单个 Node.js 24 进程提供无状态 Streamable HTTP `/mcp`，使用进程内 FIFO 队列执行后台任务，并用 Node 内置 SQLite 保存 Token、基础画像、任务和最终报告。信息获取、方舟证据整理、确定性机会判断和 Markdown 渲染通过运行时 Schema 契约隔离；企查查走 4 个远程 MCP Server，豆包搜索走 Custom 版 HTTP API。

**Tech Stack:** Node.js 24 LTS、TypeScript 7、MCP TypeScript SDK v2 拆分包、Express 5、Zod 4、Node `node:sqlite`、Vitest、原生 `fetch`。

## Global Constraints

- 仅使用 `@modelcontextprotocol/server`、`@modelcontextprotocol/client`、`@modelcontextprotocol/node`、`@modelcontextprotocol/express` v2；不得安装旧的 `@modelcontextprotocol/sdk` v1。
- 运行时固定 Node.js 24 LTS，ESM；`tsconfig.json` 必须显式包含 `"types": ["node"]`。
- 单实例、单进程、SQLite 持久化磁盘；不引入 Redis、PostgreSQL、独立 Worker、Python、Kubernetes、网页 UI。
- 对外只有 HTTPS 网关后的 `/mcp`；应用监听私网 HTTP，并校验 Host、Origin 和 Bearer Token。
- `get_company_profile`、`submit_assessment`、`get_assessment_status`、`get_assessment_report` 是仅有的四个 MCP 工具。
- 状态只有 `processing`、`completed`、`failed`；重启时遗留 `processing` 任务全部改为 `failed`。
- `PROFILE_CACHE_TTL_DAYS` 和 `ASSESSMENT_CACHE_TTL_DAYS` 默认均为 30；不自动删除历史数据。
- 任一有效 Token 知道 UUID 后可以读取他人报告；不要增加跨用户报告隔离。
- `src/orchestration/retry.ts` 的 `retryOnce` 是所有上游请求的唯一重试所有者；client、适配器和 mapper 内部不得重发。企查查或豆包搜索失败可降级，方舟两个外层 attempt 均失败则任务失败。
- 正式评估的企查查调用先执行融资、再执行招聘；融资是重点预算/扩张/时机证据，但不能单独建立产品场景或机会“高”。
- 不保存上游原始响应；只保存清洗后的基础画像、任务元数据和最终 Markdown。
- 所有契约时间使用 `Date.toISOString()` 的 ISO 8601 UTC 格式；报告缓存 TTL 只按 `completed_at` 计算。
- `cache_hit` 只由 `get_company_profile` 和 `submit_assessment` 返回；完成报告缓存的 submit 结果为 `completed/true` 并返回 `cached_at=completed_at`，进行中任务为 `processing/false`。
- 机会等级仅为 `高/中/低/待核实`；不实现分数、星级或模型直接评分。
- 每个 shell 命令必须以 `rtk` 开头。

**Primary references:** [v0.1 design](../specs/2026-08-28-target-customer-assessment-mcp-v0.1-design.md)、[MCP SDK v2 server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)、[MCP SDK v2 migration/package map](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)、[企查查 MCP 接入](https://agent.qcc.com/guide)、[企查查工具目录](https://agent.qcc.com/data)、[豆包搜索 API](https://docs.volcengine.com/docs/87772/2272953?lang=zh)。

---

## File Map

```text
package.json                         scripts、依赖与 Node 版本
tsconfig.json                        ESM/严格 TypeScript 配置
.env.example                         无真实密钥的完整配置清单
.gitignore                           忽略 .env、dist、coverage、SQLite
src/config.ts                        环境变量解析和启动校验
src/contracts/*.ts                   五个模块间 Zod/TypeScript 契约
src/db/schema.ts                     CREATE TABLE/INDEX（不做迁移框架）
src/db/database.ts                   SQLite 初始化、WAL、事务入口
src/db/*-repository.ts               Token、画像、任务持久化
src/auth/token-service.ts            Token 生成、哈希、验证和禁用
src/cli/tokens.ts                    受控环境本地 Token CLI
src/upstream/qcc/*.ts                四 Server MCP 客户端、白名单和映射
src/upstream/search/*.ts             固定搜索计划与豆包 HTTP API 适配器
src/upstream/ark/*.ts                方舟调用、JSON 提取和证据引用校验
src/opportunity/*.ts                 七产品规则和确定性判断
src/report/*.ts                      ReportModel 与 Markdown 渲染
src/orchestration/*.ts               调用预算、重试、FIFO 和评估流程
src/logging/logger.ts                 普通结构化日志与凭证字段屏蔽
src/mcp/*.ts                         四工具注册、HTTP 鉴权和路由
src/index.ts                         组合依赖、启动和优雅关闭
tests/fixtures/*.json                脱敏的企查查、搜索、方舟样本
tests/**/*.test.ts                   单元、契约、集成测试
docs/validation/real-e2e-result.md   一家真实企业的人工验收记录
Dockerfile                           Node 24 单进程镜像
README.md                            本地运行、Token、Codex 和部署说明
```

### Task 1: 建立可验证的 Node 24 工程与配置边界

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
- Produces: `AppConfig`，其中 `ALLOWED_ORIGINS` 保持完整 HTTPS Origin，并同时产生 `allowedOriginUrls:Set<string>` 与供 `createMcpExpressApp` 使用的 `allowedOriginHostnames:Set<string>`；另包含端口、数据库路径、Host、四个 QCC URL、搜索/方舟凭证、调用上限和缓存 TTL。

- [ ] **Step 1: 初始化 Node 工程并写失败的配置测试**

Run:

```bash
rtk npm init -y
```

Create `tests/config.test.ts` with assertions for defaults, invalid HTTP URL, missing secret, integer bounds, a realistic `process.env` containing `PATH`/`HOME`/shell keys, and error messages containing only declared configuration names rather than values or unrelated environment keys:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  PUBLIC_MCP_HOST: 'mcp.example.cn', ALLOWED_ORIGINS: 'https://codex.example.cn',
  SQLITE_PATH: ':memory:', QCC_MCP_COMPANY_URL: 'https://agent.qcc.com/mcp/company/stream',
  QCC_MCP_RISK_URL: 'https://agent.qcc.com/mcp/risk/stream',
  QCC_MCP_IPR_URL: 'https://agent.qcc.com/mcp/ipr/stream',
  QCC_MCP_OPERATION_URL: 'https://agent.qcc.com/mcp/operation/stream', QCC_API_KEY: 'qcc-secret',
  DOUBAO_SEARCH_API_URL: 'https://open.feedcoopapi.com/search_api/web_search', DOUBAO_SEARCH_API_KEY: 'search-secret',
  ARK_API_URL: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', ARK_MODEL: 'ep-test', ARK_CREDENTIAL: 'ark-secret'
};

describe('loadConfig', () => {
  it('ignores undeclared process keys before strict parsing', () => {
    expect(loadConfig({ ...valid, PATH: '/usr/bin', HOME: '/tmp/home', SHELL: '/bin/zsh' } as NodeJS.ProcessEnv))
      .toMatchObject({ maxQccCalls: 8 });
  });
  it('applies v0.1 defaults', () => expect(loadConfig(valid as NodeJS.ProcessEnv)).toMatchObject({
    maxQccCalls: 8, maxSearchCalls: 8, maxArkCalls: 2, maxTotalUpstreamCalls: 18,
    profileCacheTtlDays: 30, assessmentCacheTtlDays: 30, maxConcurrentAssessments: 1
  }));
  it('keeps exact origin URLs and derives SDK hostnames', () => {
    const config = loadConfig({ ...valid, ALLOWED_ORIGINS: 'https://codex.example.cn:8443,https://other.example.cn' } as NodeJS.ProcessEnv);
    expect(config.allowedOriginUrls).toEqual(new Set(['https://codex.example.cn:8443', 'https://other.example.cn']));
    expect(config.allowedOriginHostnames).toEqual(new Set(['codex.example.cn', 'other.example.cn']));
  });
  it('rejects non-HTTPS upstreams without leaking values', () => {
    const env = { ...valid, ARK_API_URL: 'http://secret.invalid', PATH: '/private/bin' } as NodeJS.ProcessEnv;
    expect(() => loadConfig(env))
      .toThrow(/ARK_API_URL/);
    try { loadConfig(env); }
    catch (error) { expect(String(error)).toBe('Error: Invalid configuration: ARK_API_URL'); }
  });
});
```

- [ ] **Step 2: 安装固定的大版本依赖并验证测试先失败**

Run:

```bash
rtk npm install @modelcontextprotocol/server@^2 @modelcontextprotocol/client@^2 @modelcontextprotocol/node@^2 @modelcontextprotocol/express@^2 express@^5 zod@^4 dotenv@^17
rtk npm install -D typescript@^7 tsx@^4 vitest@^3 @types/node@^24 @types/express@^5
rtk npm test -- --run tests/config.test.ts
```

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: 写最小工程配置和 `loadConfig`**

Use ESM, `engines.node >=24`, scripts `build`, `typecheck`, `test`, `start`, `dev`, `tokens`. In `src/config.ts`, define the declared key list once, pick only those keys from the supplied `NodeJS.ProcessEnv`, and pass that new object to one strict Zod schema; never strict-parse the complete `process.env`. Parse comma-separated origins; validate all upstream URLs with `.url().startsWith('https://')`; use integer coercion with defaults `8/8/2/18/30/30/1`; throw `Invalid configuration: <comma-separated declared field names>` only. Tests must prove `PATH` and other extra keys do not fail validation and no error contains an environment value, unknown process key, or serialized environment object.

```ts
const CONFIG_KEYS = [
  'PORT', 'PUBLIC_MCP_HOST', 'ALLOWED_ORIGINS', 'SQLITE_PATH',
  'QCC_MCP_COMPANY_URL', 'QCC_MCP_RISK_URL', 'QCC_MCP_IPR_URL', 'QCC_MCP_OPERATION_URL', 'QCC_API_KEY',
  'DOUBAO_SEARCH_API_URL', 'DOUBAO_SEARCH_API_KEY', 'ARK_API_URL', 'ARK_MODEL', 'ARK_CREDENTIAL',
  'MAX_QCC_CALLS', 'MAX_SEARCH_CALLS', 'MAX_ARK_CALLS', 'MAX_TOTAL_UPSTREAM_CALLS',
  'PROFILE_CACHE_TTL_DAYS', 'ASSESSMENT_CACHE_TTL_DAYS', 'MAX_CONCURRENT_ASSESSMENTS'
] as const;

export type AppConfig = z.infer<typeof configSchema> & {
  allowedOriginUrls: Set<string>;
  allowedOriginHostnames: Set<string>;
};
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const declaredOnly = Object.fromEntries(
    CONFIG_KEYS.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]])
  );
  const parsed = configSchema.safeParse(declaredOnly);
  if (!parsed.success) throw new Error(`Invalid configuration: ${[...new Set(parsed.error.issues.map(i => String(i.path[0])))].join(', ')}`);
  const originUrls = parsed.data.ALLOWED_ORIGINS.split(',').map(v => v.trim()).filter(Boolean);
  return {
    ...parsed.data,
    allowedOriginUrls: new Set(originUrls),
    allowedOriginHostnames: new Set(originUrls.map(v => new URL(v).hostname))
  };
}
```

The `ALLOWED_ORIGINS` schema validates every comma-separated value as a complete HTTPS Origin (scheme, hostname and optional explicit port, with no path/query/hash). Do not normalize away scheme or port in `allowedOriginUrls`; `allowedOriginHostnames` is the derived SDK guard input only.

`.env.example` must list every config key with blank secrets. `.gitignore` must include `.env`, `*.sqlite*`, `dist/`, `coverage/`, `node_modules/`.

- [ ] **Step 4: 运行测试、类型检查并提交**

```bash
rtk npm test -- --run tests/config.test.ts
rtk npm run typecheck
rtk git add package.json package-lock.json tsconfig.json .gitignore .env.example src/config.ts tests/config.test.ts
rtk git commit -m "chore: bootstrap node service and validated config"
```

Expected: tests PASS; typecheck exits 0.

### Task 2: 固定跨模块契约和 SQLite 持久化

**Files:**
- Create: `src/contracts/identity.ts`, `research.ts`, `evidence.ts`, `opportunity.ts`, `report.ts`, `index.ts`
- Create: `src/db/schema.ts`, `database.ts`, `token-repository.ts`, `profile-repository.ts`, `assessment-repository.ts`
- Test: `tests/contracts.test.ts`, `tests/db.test.ts`

**Interfaces:**
- Produces: `IdentityProfileSchema`, `ResearchBundleSchema`, `EvidenceBundleSchema`, `OpportunityAssessmentSchema`, `ReportModelSchema` and inferred types.
- Produces: strict `CompanyProfileOutputSchema`, `SubmitAssessmentOutputSchema`, `AssessmentStatusOutputSchema`, `AssessmentReportOutputSchema`; Task 3 only registers and converts these schemas, and must not redefine their fields.
- Produces: repositories with `findFresh*`, `insert*`, `createOrReuseAssessment`, `completeAssessment`, `failAssessment`, `failInterruptedAssessments`.

- [ ] **Step 1: 写契约和数据库失败测试**

Cover unknown-field rejection at every object level, all explicit nullable fields, rejection of local-time/offset/date-only timestamps, dangling product enum rejection, exactly seven distinct product rows, `recommendedProduct: null`, `originalPublisher`/`originalDomain` source deduplication, and the four exact MCP output unions. Database cases cover WAL initialization, report freshness calculated from `completed_at` rather than `created_at`/`collected_at`, one processing task per credit code, completed-cache reuse, failed-task resubmit, and restart failure conversion.

```ts
it('reuses one processing assessment per company', () => {
  const first = assessments.createOrReuseAssessment(input, false, now);
  const second = assessments.createOrReuseAssessment(input, false, now);
  expect(second.assessmentId).toBe(first.assessmentId);
});

it('marks interrupted tasks failed', () => {
  assessments.createOrReuseAssessment(input, false, now);
  expect(assessments.failInterruptedAssessments(now)).toBe(1);
  expect(assessments.get(firstId)?.status).toBe('failed');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/contracts.test.ts tests/db.test.ts
```

Expected: FAIL because contracts and repositories do not exist.

- [ ] **Step 3: 实现五个严格契约**

Use these exact shared enums and no others:

```ts
export const ProductKeySchema = z.enum(['windchill','feigenbaum_qms','creo','catia','abaqus','cst','solidworks']);
export const OpportunityLevelSchema = z.enum(['高','中','低','待核实']);
export const ResearchSourceStatusSchema = z.enum(['completed','partial','failed']);
export const ArkSourceStatusSchema = z.enum(['completed','failed']);
export const EntityScopeSchema = z.enum(['legal_entity','group','subsidiary','brand','unknown']);
export const EntityMatchSchema = z.enum(['confirmed','probable','unverified']);
export const FactKindSchema = z.enum(['industry','product_scene','recruitment','software_ecosystem','organization','quality','manufacturing','procurement','budget','decision_power','risk']);
```

Define `UtcTimestampSchema` as an ISO 8601 UTC string emitted by `Date.toISOString()` (`YYYY-MM-DDTHH:mm:ss.sssZ`); every object below uses `.strict()`, every listed field is required, arrays use `[]`, and only fields marked `| null` accept null. Nested item/reference schemas are part of these five existing contracts, not a generic framework.

- `IdentityProfile`: `legalName:string`, `creditCode:string`, `formerNames:string[]`, `aliases:string[]`, `englishNames:string[]`, `brands:string[]`, `officialDomains:string[]`, `registeredAddress:string|null`, `parentLegalName:string|null`, `subsidiaryLegalNames:string[]`.
- `ResearchBundle`: `identity:IdentityProfile`, `items:ResearchItem[]`, `sourceStatus:{qcc:{status:ResearchSourceStatus,error:string|null},doubaoSearch:{status:ResearchSourceStatus,error:string|null}}`, `gaps:string[]`, `collectedAt:UtcTimestamp`. `ResearchItem` is exactly `evidenceId:string`, `source:'qcc'|'doubao_search'`, `sourceKind:'company'|'risk'|'ipr'|'operation'|'web'`, `title:string`, `url:string|null`, `originalPublisher:string|null`, `originalDomain:string|null`, `summary:string|null`, `content:string|null`, `publishedAt:UtcTimestamp|null`, `collectedAt:UtcTimestamp`, `mentionedName:string`, `entityScope:EntityScope`, `entityMatch:EntityMatch`, `matchBasis:string[]`, `query:string|null`, `position:number|null`, `logId:string|null`. Non-null URLs must be credential-free HTTP(S) direct evidence URLs; Doubao search requires a non-null URL, while QCC uses `null` plus a source-link gap when the upstream record has no direct URL. Never substitute `https://agent.qcc.com/data` or guess a company URL.
- `EvidenceBundle`: `identity:IdentityProfile`, `industryClassification:'P1'|'P2'|'non_target'|'unverified'`, `industryEvidenceIds:string[]`, `evidence:EvidenceReference[]`, `facts:EvidenceFact[]`, `financingRecords:FinancingRecord[]`, `conflicts:string[]`, `gaps:string[]`, `collectedAt:UtcTimestamp`. `EvidenceReference` is exactly `evidenceId`, `title`, `url:string|null`, nullable `originalPublisher/originalDomain/publishedAt`, `collectedAt`, `mentionedName`, `entityScope`, `entityMatch`, `matchBasis`; `EvidenceFact` is exactly `factId:string`, `statement:string`, `kind:FactKind`, `productTags:ProductKey[]`, `strength:'direct'|'supporting'|'weak'`, `evidenceIds:string[]`, `entityScope:EntityScope`, `entityMatch:EntityMatch`, `matchBasis:string[]`; `FinancingRecord` is exactly `occurredAt:UtcTimestamp|null`, `typeOrRound:string|null`, `disclosedAmount:string|null`, `investors:string[]`, `evidenceIds:string[]`.
- `OpportunityAssessment`: `products:ProductOpportunity[]`, `overallOpportunity:OpportunityLevel`, `recommendedProduct:ProductKey|null`, `summaryReasons:string[]`; `ProductOpportunity` is exactly `product:ProductKey`, `level:OpportunityLevel`, `evidenceIds:string[]`, `reasons:string[]`, `blockers:string[]`, `gaps:string[]`, and `products` contains every `ProductKey` exactly once.
- `ReportModel`: `legalName:string`, `industryClassification`, `industryEvidenceIds:string[]`, `companyScaleClues:string[]`, `overallOpportunity`, `recommendedProduct:ProductKey|null`, `summaryReasons:string[]`, `latestFinancing:FinancingRecord|null`, `products:ProductOpportunity[]`, `facts:EvidenceFact[]`, `evidence:EvidenceReference[]`, `salesQuestions:string[]`, `risks:string[]`, `gaps:string[]`, `nextVerificationActions:string[]`, `sourceStatus:{qcc:ResearchSourceStatus,doubaoSearch:ResearchSourceStatus,ark:'completed'}`, `collectedAt:UtcTimestamp`, `dynamicSignalFreshness:'current'|'stale'`. `facts` 只包含引用存在、主体为目标法定实体且事实归属与所有引用一致的已验证事实；`industryEvidenceIds` 保留行业分类依据审计链并纳入关键结论链接覆盖。Tests reject both `ark:'partial'` and `ark:'failed'`; Ark failure belongs only to failed task/error metadata and never produces a `ReportModel`.

Freeze the four strict MCP output unions here as well:

- `get_company_profile`: completed is `{source_status:'completed',candidates:Candidate[],basic_profile:BasicProfile|null,cache_hit:boolean}`; failed is `{source_status:'failed',candidates:[],basic_profile:null,cache_hit:false,message:string}`. `Candidate` is exactly `legal_name:string`, `credit_code:string`, `status:string|null`, `registered_address:string|null`, `match_reason:string`. `BasicProfile` is exactly `industry:string|null`, `region:string|null`, `company_type:string|null`, `founded_year:number|null`, `registered_capital:string|null`, `legal_representative:string|null`, `website:string|null`, `employee_range:string|null`, `risk_summary:string|null`, `collected_at:UtcTimestamp`. A multi-candidate completed result has `basic_profile:null` and `cache_hit:false`; only a unique cached profile may return `cache_hit:true`.
- `submit_assessment`: processing is `{assessment_id:UUID,status:'processing',estimated_minutes:'5-10',cache_hit:false}` for both new and reused in-progress work; completed-cache reuse is `{assessment_id:UUID,status:'completed',cache_hit:true,cached_at:UtcTimestamp}`, with `cached_at=completed_at`. No other variant exists.
- `get_assessment_status`: `{assessment_id:UUID,status:'processing'|'completed'|'failed',message:string}`.
- `get_assessment_report`: processing/failed is `{assessment_id:UUID,status:'processing'|'failed',message:string}`; completed is `{assessment_id:UUID,status:'completed',legal_name:string,overall_opportunity:OpportunityLevel,recommended_product:ProductKey|null,collected_at:UtcTimestamp,dynamic_signal_freshness:'current'|'stale',source_status:{qcc:ResearchSourceStatus,doubao_search:ResearchSourceStatus,ark:'completed'},markdown:string}`. It contains neither cache metadata nor any extra financing status field.

`originalPublisher` and `originalDomain` describe the original publisher, not the QCC/Doubao acquisition channel. Deduplicate by normalized `originalDomain`, falling back to normalized `originalPublisher`; if both are null, the item remains citable but does not count toward the two-independent-publisher threshold. `EvidenceReference` is copied from matching `ResearchItem` data and validated byte-for-byte for IDs/nullable URLs/provenance; the model cannot invent it. Link coverage counts only real direct HTTP(S) URLs and is false when a key conclusion has only QCC null-link evidence.

- [ ] **Step 4: 实现 SQLite schema 和 repositories**

Use `DatabaseSync` from `node:sqlite`, `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`, and `CREATE TABLE IF NOT EXISTS` only. Create `tokens`, `company_profiles`, `assessments`; create ordinary normalized-name index and partial unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS one_processing_per_company
ON assessments(cache_key) WHERE status = 'processing';
```

Wrap `createOrReuseAssessment` in `BEGIN IMMEDIATE`/`COMMIT`, roll back on error, check processing first, then fresh completed cache unless `forceRefresh`, then insert a UUID task. A processing reuse returns `cacheHit:false`; a completed-cache reuse returns its persisted `completedAt` as `cachedAt` and `cacheHit:true`. `completeAssessment` sets `completed_at` and `cached_at` to the same UTC instant. `findFresh*` computes report TTL from `completed_at` only; reads never extend it.

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run tests/contracts.test.ts tests/db.test.ts
rtk npm run typecheck
rtk git add src/contracts src/db tests/contracts.test.ts tests/db.test.ts
rtk git commit -m "feat: add data contracts and sqlite repositories"
```

### Task 3: Token CLI、请求鉴权与四工具 MCP 契约

**Files:**
- Create: `src/auth/token-service.ts`, `src/cli/tokens.ts`
- Create: `src/mcp/tool-schemas.ts`, `tools.ts`, `http-app.ts`
- Test: `tests/auth.test.ts`, `tests/mcp-tools.test.ts`, `tests/http-security.test.ts`

**Interfaces:**
- Produces: `TokenService.create/verify/disable/list` and `AuthenticatedUser { userId }`.
- Consumes repository interfaces from Task 2.
- Produces: `buildMcpServer(services)` and `createHttpApp(config, authenticate, serverFactory)`.

- [ ] **Step 1: 写失败测试**

Test one-time plaintext output, stored SHA-256 hash only, disabled rejection, invalid Bearer rejection, valid Host, and Origin handling against `ALLOWED_ORIGINS=https://codex.example.cn:8443`: the exact full Origin is accepted; `http://codex.example.cn:8443`, `https://codex.example.cn`, and `https://evil.example.cn:8443` are each rejected with 403 before authentication; no `Origin` is accepted and still reaches Bearer authentication. Also test unknown MCP input fields and the four Task 2 response unions. Assert authentication middleware forwards verified `req.auth` as factory `authInfo`, and `servicesFor(authInfo.clientId)` selects the caller. Assert only profile and submit schemas permit `cache_hit`, completed-cache submit includes `cached_at`, report rejects cache metadata, and a valid user can read an assessment created by another user. Also inspect registered tool descriptions: `get_company_profile` must say it is the default for basic or ambiguous requests; `submit_assessment` must say it is only for explicit formal assessment after the user confirms `legal_name` and `credit_code`.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/auth.test.ts tests/mcp-tools.test.ts tests/http-security.test.ts
```

- [ ] **Step 3: 实现 Token 和 CLI**

Generate 32 random bytes as base64url; store `createHash('sha256').update(token).digest('hex')`; verify with `timingSafeEqual`; never log or list plaintext/hash. CLI accepts exactly `tokens:create --user`, `tokens:disable --user`, `tokens:list` and exits non-zero on malformed arguments.

- [ ] **Step 4: 注册四个工具和安全 HTTP 路由**

Use the modern v2 HTTP entry: `createMcpHandler` and `McpServer` from `@modelcontextprotocol/server`, `toNodeHandler` from `@modelcontextprotocol/node`, and `createMcpExpressApp` from `@modelcontextprotocol/express`. Authentication is an Express middleware mounted before the MCP route; after verifying the Bearer Token it writes an SDK `AuthInfo` to `req.auth`. `toNodeHandler` forwards that value to the per-request factory as `authInfo`; the factory requires `authInfo.clientId` and calls `servicesFor(authInfo.clientId)` before building a fresh server. Do not manually construct or connect a server transport.

```ts
const handler = createMcpHandler(({ authInfo }) => {
  if (!authInfo?.clientId) throw new Error('Authenticated caller is required');
  return buildMcpServer(servicesFor(authInfo.clientId));
});
const nodeHandler = toNodeHandler(handler);
const app = createMcpExpressApp({
  host: '0.0.0.0',
  allowedHosts: [config.publicMcpHost],
  allowedOrigins: [...config.allowedOriginHostnames]
});
const exactOriginMiddleware: express.RequestHandler = (req, res, next) => {
  const origin = req.get('Origin');
  if (!origin || config.allowedOriginUrls.has(origin)) return next();
  res.status(403).json({ error: 'Forbidden' });
};
app.all('/mcp', exactOriginMiddleware, authMiddleware, (req, res) => void nodeHandler(req, res, req.body));
```

`createMcpExpressApp` receives hostnames because its built-in DNS-rebinding guard is hostname-based; `exactOriginMiddleware` preserves the stricter application rule by comparing the unmodified header against complete configured Origins before authentication. Missing `Origin` passes this middleware but never bypasses Bearer authentication. The handler creates a fresh `McpServer` per request and serves modern requests plus the default stateless legacy fallback. The auth middleware applies to every `/mcp` method; unauthenticated negotiation probes must receive the same authentication challenge as tool calls. Close `handler` during application shutdown.

Tool handlers return both text `content` and the same small JSON as `structuredContent`; business `processing/failed` states are successful tool calls, not thrown protocol errors.
Each registration declares both strict input and output schemas so `structuredContent` is contract-checked. External field names follow the design (`assessment_id`, `overall_opportunity`, `recommended_product`); conversion from internal camelCase happens only in `src/mcp/tools.ts`.
Encode the design's tool-selection rules directly in the MCP tool descriptions. Do not add an intent-classifier module: the client model uses these descriptions, while `submit_assessment` enforces the confirmed identity fields at runtime.

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run tests/auth.test.ts tests/mcp-tools.test.ts tests/http-security.test.ts
rtk npm run typecheck
rtk git add src/auth src/cli src/mcp tests/auth.test.ts tests/mcp-tools.test.ts tests/http-security.test.ts
rtk git commit -m "feat: add bearer auth and four mcp tool contracts"
```

### Task 4: 企查查四 Server 适配器与基础画像缓存

**Files:**
- Create: `src/orchestration/call-budget.ts`, `retry.ts`
- Create: `src/upstream/qcc/tool-allowlist.ts`, `client.ts`, `mapper.ts`, `profile-service.ts`, `assessment-research.ts`
- Create: `tests/fixtures/qcc-*.json`
- Test: `tests/call-budget.test.ts`, `tests/retry.test.ts`, `tests/qcc-adapter.test.ts`, `tests/company-profile.test.ts`

**Interfaces:**
- Produces: `QccGateway.call(server, tool, input): Promise<unknown>`.
- Produces: `CompanyProfileService.get(query, regionHint): Promise<CompanyProfileResult>`.
- Produces: `collectQccResearch(identity, budget): Promise<SourceCollection>`.
- Produces: `retryOnce<T>(source, budget, attempt): Promise<{status:'completed',value:T}|{status:'failed',error:UpstreamError}>`; every adapter call is a single attempt.

- [ ] **Step 1: 保存脱敏样本并写失败契约测试**

Allow only these v0.1 tools: company `get_company_by_query`, `get_company_registration_info`, `get_company_profile`, `get_contact_info`, `get_shareholder_info`, `get_actual_controller`, `get_key_personnel`; risk `get_company_risk_scan`; IPR `get_patent_info`, `get_software_copyright_info`; operation `get_recruitment_info`, `get_financing_records`, `get_annual_reports`, `get_bidding_info`, `get_qualifications`. Tests must prove any other tool name is rejected locally before network access, and that financing/recruitment initial calls occur before every other formal-assessment QCC call or retry. Contract fixtures must cover financing date, type/round, nullable disclosed amount, investors, and missing optional fields. `retryOnce` tests assert at most two attempts, one budget charge per attempt, no second attempt after budget exhaustion, and no third call hidden in a client.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/call-budget.test.ts tests/retry.test.ts tests/qcc-adapter.test.ts tests/company-profile.test.ts
```

- [ ] **Step 3: 实现 QCC MCP client 和映射**

Implement `CallBudget` and the sole orchestration `retryOnce` first. `retryOnce` consumes source and total budget immediately before each attempt, executes at most two attempts, and returns the typed result without swallowing the second error.

Use `Client` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/client`, setting `requestInit.headers.Authorization`. Build one lazy client per configured server. `QccGateway.call` makes exactly one `callTool` attempt: on transport error it closes and clears the current client/transport and immediately throws typed `UpstreamError`; it must not reconnect or resend inside the same call. If `retryOnce` starts a second outer attempt, that later call lazily creates a new connection. Validate mapped results and never persist raw payloads.

For formal assessment, call `get_financing_records` first and `get_recruitment_info` second, then profile, risk scan, patents, annual reports and bidding. The eighth call selects the most relevant gap among shareholder, software copyrights and qualifications. These first two calls must start before any other QCC call or retry can consume their reserved budget; retries run after both initial attempts. Stop before starting later calls when budget is exhausted. A missing dataset is a gap, not a negative fact. If financing fails while other QCC data is usable, set only the overall QCC status to `partial` and render “融资信息获取失败” as a gap; do not create a separate financing status field or infer a replacement value.

- [ ] **Step 4: 实现基础画像唯一/多候选、重试和 30 天缓存**

Normalize legal names only by trim, Unicode NFKC, whitespace removal and ASCII case folding; do not strip legal suffixes. Exact single match returns profile; multiple matches return candidates without profile; wrap each QCC request with orchestration `retryOnce`, so failure after two outer attempts returns `{ sourceStatus:'failed', candidates:[] }`.

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run tests/call-budget.test.ts tests/retry.test.ts tests/qcc-adapter.test.ts tests/company-profile.test.ts
rtk npm run typecheck
rtk git add src/orchestration/call-budget.ts src/orchestration/retry.ts src/upstream/qcc tests/fixtures/qcc-*.json tests/call-budget.test.ts tests/retry.test.ts tests/qcc-adapter.test.ts tests/company-profile.test.ts
rtk git commit -m "feat: integrate qcc profile and research adapters"
```

### Task 5: 豆包搜索计划、HTTP 适配器和调用预算

**Files:**
- Create: `src/upstream/search/search-plan.ts`, `doubao-client.ts`, `mapper.ts`
- Create: `tests/fixtures/doubao-search.json`
- Test: `tests/doubao-search.test.ts`

**Interfaces:**
- Consumes: Task 4 `CallBudget` and `retryOnce`; budget is never passed into the search client.
- Produces: `buildSearchPlan(identity): SearchQuery[]`.
- Produces: `DoubaoSearchClient.search(query): Promise<ResearchItem[]>`; one call is exactly one HTTP attempt and has no budget parameter.

- [ ] **Step 1: 写失败测试**

Assert: all Query values are 1–100 chars; `SearchType='web'`; `NeedUrl=true`; recruitment queries use `NeedContent=true`; recruitment, procurement/bidding/digital-procurement and expansion/financing purposes require `TimeRange='OneYear'`; official website/product, engineering, quality and software-ecosystem purposes omit `TimeRange`; the strict schema rejects both missing dynamic ranges and ranges on non-dynamic purposes. Count defaults 10 and rejects >50; one `DoubaoSearchClient.search(query)` call performs exactly one fetch, never retries internally, and accepts no budget. Search-budget exhaustion belongs to Task 9 orchestration tests.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/doubao-search.test.ts
```

- [ ] **Step 3: 实现固定搜索计划**

Generate no more than eight explicit queries: official website/products, engineering/R&D, quality/certifications, software ecosystem, recruitment with all seven product keywords split into two queries, procurement/bidding/digitalization, expansion/financing. Use only verified legal name/aliases; no model-generated queries.

- [ ] **Step 4: 实现 API client 和结果映射**

POST JSON to configured URL with Bearer Key. Map `Result.WebResults` into evidence items preserving `Title`, `SiteName` as `originalPublisher`, URL hostname as `originalDomain`, `Url`, content/summary, `PublishTime`, `SortId`, origin Query, collected timestamp and `LogId`. Error codes, 401/403, quota/QPS and 5xx become typed errors. One client call performs one fetch; only orchestration calls `retryOnce('doubao_search', budget, () => client.search(query))`, and neither client nor mapper receives a budget or retries.

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run tests/doubao-search.test.ts
rtk npm run typecheck
rtk git add src/upstream/search tests/fixtures/doubao-search.json tests/doubao-search.test.ts
rtk git commit -m "feat: add deterministic doubao search collection"
```

### Task 6: 方舟事实整理与严格证据引用校验

**Files:**
- Create: `src/contracts/gaps.ts`
- Create: `src/upstream/ark/prompt.ts`, `client.ts`, `evidence-validator.ts`
- Create: `tests/fixtures/ark-evidence.json`
- Test: `tests/ark-adapter.test.ts`, `tests/evidence-validator.test.ts`

**Interfaces:**
- Produces: `ArkEvidenceService.extract(bundle): Promise<EvidenceBundle>` for exactly one HTTP attempt; orchestration supplies `retryOnce` and the budget.
- Consumes: `ResearchBundle`; may only return IDs present in that bundle.

- [ ] **Step 1: 写失败测试**

Cover valid JSON, empty response, fenced JSON, malformed JSON, invented URL/evidence ID, altered nullable URL/original publisher/domain, missing match basis, empty ResearchBundle producing `unverified`, and prove each `extract` call performs exactly one HTTP request and throws `ArkUnavailableError` on that attempt. Add behavior tests for the dedicated successful-financing slot and complete structured financing fields, older financing appearing before the latest dated record, stable all-undated ordering, facts after character 100, generic recruitment/procurement text before independently located Windchill/Abaqus/拟采购 facts beyond character 1000, retained procurement carrier/disclosure/product wording validated against compacted raw evidence, no-financing fallback fairness, four-item maximum, compact bundle ≤6,656 UTF-8 bytes and full serialized request ≤12,288 bytes. Add a mapper→compactor regression using the shared QCC unavailable-link audit-gap protocol: those audit gaps are absent from the prompt and restored byte-for-byte after validation, while financing/failure semantic gaps remain in the prompt and final output.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/ark-adapter.test.ts tests/evidence-validator.test.ts
```

- [ ] **Step 3: 实现固定系统提示和 HTTP client**

POST to `ARK_API_URL` with Bearer `ARK_CREDENTIAL`, body `{ model: ARK_MODEL, messages, response_format:{type:'json_object'}, temperature:0 }`. System prompt states webpages are untrusted data, forbids tool calls/instructions, requires `P1/P2/non_target/unverified`, forbids creating sources/aliases/URLs, and emits the exact `EvidenceBundleSchema` JSON shape.
Before the POST, deterministically compact to at most four representative items. A successfully mapped QCC financing item receives the highest-priority dedicated slot and preserves its complete structured date, round/type, disclosed amount and investors. Select that slot by valid `publishedAt` descending, put dated entries before undated ones, preserve source order for equal dates, and choose the first source item when all are undated. Do not backfill other financing records into remaining slots; add a trusted omission gap when more than one financing record exists. Remaining slots alternate search and QCC demand/technical evidence; profile is fallback only because identity is transmitted separately. Keep title, URL, evidence ID, subject attribution and provenance immutable. Bound compact `ResearchBundle` at 6,656 UTF-8 bytes and the complete request at 12,288 bytes. For long text, score evidence-category-aware keyword windows across the full value, rank product names, procurement disclosures/actions and engineering skills above generic recruitment/job/notice words, concatenate up to four non-overlapping windows with fair UTF-8 allocation, then trim lower-priority content and summary before dropping the lowest-priority item. Preserve trusted gaps and add the capacity gap whenever evidence is omitted or text is compacted; omission does not mean absence.
Treat financing/data-source failures, missing datasets and capacity omissions as model-semantic gaps: they remain in the compact bundle sent to Ark. Treat only QCC missing-direct-link gaps as report-only audit gaps. QCC mapper and Ark compactor share one exported prefix, constructor and predicate; the compactor excludes only gaps accepted by that predicate, never a duplicated literal or broad text match. After Ark evidence validation, merge the original bundle gaps back unchanged so every excluded audit gap is restored exactly, while semantic and compactor-generated gaps remain stable-deduplicated.
It also forbids unsupported executive personality/age-based decision-style claims, revenue estimation or employee-productivity extrapolation, and inferred purchasing-intent statements. Direct recruitment and published tender facts remain allowed. Purchase-intent wording is allowed only when a `direct` `procurement` fact for the confirmed target entity cites confirmed evidence and both the statement and every cited ResearchItem identify one of the exact composite carriers `采购公告/招标公告/中标公告/采购文件/采购项目/采购合同`; bare `公告/招标/中标` never qualifies. Each cited item's combined title, summary and content must also contain the same procurement-disclosure wording and every tagged target-product term present in the statement. Supporting/weak facts, unrelated recruitment or product-announcement pages, mismatched products and other fact kinds never receive this exception.

- [ ] **Step 4: 实现引用校验并接入唯一外层重试**

Build a map of `ResearchItem.evidenceId`; reject every absent ID, nullable URL/publisher/domain mismatch, missing mentioned name, or non-unverified classification without evidence. The Ark client and validator never retry. The assessment runner wraps the whole `extract` call in orchestration `retryOnce`; two invalid/failed outer attempts consume both Ark calls and make the task fail.
The validator also rejects those unsupported inference phrases in `facts[].statement`, `conflicts[]`, `gaps[]`, and every renderable financing string (`typeOrRound`, `disclosedAmount`, each investor). Financing fields never receive the procurement-notice exception. Procurement-source consistency is checked deterministically against `ResearchItem.title + summary + content`; it does not call a semantic model.

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run tests/ark-adapter.test.ts tests/evidence-validator.test.ts
rtk npm run typecheck
rtk git add src/contracts/gaps.ts src/contracts/index.ts src/upstream/ark src/upstream/qcc/mapper.ts tests/fixtures/ark-evidence.json tests/ark-adapter.test.ts tests/evidence-validator.test.ts tests/qcc-adapter.test.ts
rtk git commit -m "feat: extract and validate evidence with ark"
```

### Task 7: 七产品确定性机会规则

**Files:**
- Create: `src/opportunity/product-rules.ts`, `evaluate-product.ts`, `evaluate-all.ts`
- Test: `tests/opportunity.test.ts`, `tests/recruitment-signals.test.ts`

**Interfaces:**
- Produces: `evaluateOpportunities(evidence: EvidenceBundle, now: Date): OpportunityAssessment`.

- [ ] **Step 1: 写表驱动失败测试**

For every product cover direct named recruitment, competitor signal, generic role, old recruitment, two independent original publishers plus recent signal, strong blocker, unverified entity, P1 without product scene, P2 CST RF evidence, financing with and without a product scene, and empty evidence. Assert that financing strengthens budget/timing only when a product scene already exists, never creates a product scene or independently yields `高`. Run the same input twice and deep-equal outputs.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/opportunity.test.ts tests/recruitment-signals.test.ts
```

- [ ] **Step 3: 实现产品规则表**

Each product rule declares exact positive keywords, engineering methods, competitor keywords and blockers. Recruitment published within 365 days can be `recent`; older recruitment is converted to software-ecosystem support only. Generic roles are weak and cannot establish a product scene. Financing facts are product-neutral budget/timing support: preserve disclosed date/type/round/amount/investors, never estimate missing values, and never turn financing into a product-scene fact.

- [ ] **Step 4: 实现统一四档决策树**

Apply exactly in this order:

```text
industry unverified OR critical conflict OR all supporting entity matches unverified -> 待核实
confirmed product scene + >=2 independent original publisher/domain groups + matching engineering/organization complexity + recent timing signal + no known budget/decision blocker -> 高
confirmed product scene + reliable support + matching complexity or software ecosystem, but no recent timing signal or budget/decision unknown -> 中
confirmed target industry + evidence collected but no product scene, OR insufficient complexity, OR strong incumbent blocker without replacement signal -> 低
otherwise -> 待核实
```

P1/P2 affects prioritization and tie-breaking only. A recent financing fact may satisfy timing/budget support but never `confirmed product scene`; QCC and Doubao are acquisition channels, so independence is computed from the original publisher/domain and duplicate reposts count once.

Choose overall highest valid level; ties use most direct confirmed evidence, then lowest blocker count, then fixed product order. If only weak/probable evidence supports the highest level, return overall `待核实` and `recommendedProduct=null`.

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run tests/opportunity.test.ts tests/recruitment-signals.test.ts
rtk npm run typecheck
rtk git add src/opportunity tests/opportunity.test.ts tests/recruitment-signals.test.ts
rtk git commit -m "feat: add deterministic seven-product opportunity rules"
```

### Task 8: ReportModel 与纯 Markdown 渲染

**Files:**
- Create: `src/report/build-report-model.ts`, `render-markdown.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Produces: `buildReportModel(identity, evidence, assessment, sourceStatus): ReportModel`.
- Produces: `renderMarkdown(model): string` with no external calls.
- Produces: `presentStoredReport(markdown, completedAt, now): {markdown,dynamicSignalFreshness}`，读取缓存时只按 `completed_at` 以严格大于 7 天判断，并规范化为最多一个时效警告。

- [ ] **Step 1: 写失败快照和禁止内容测试**

Test two branches. A normal report must contain the one-screen summary, latest financing result, seven product rows, fact statement plus evidence URL/time/basis, industry-classification evidence, sales questions, risks/gaps, source failure labels, and no unsupported revenue/personality/procurement statements. Product support labels require both a matching `fact.productTags` entry and the same evidence ID on that product row; industry-only evidence must not be labelled as supporting unrelated low product rows. Link coverage must be false when industry classification has only a null-link QCC reference even if recommended-product evidence has a direct link. When financing fails but other QCC data succeeds, assert `sourceStatus.qcc='partial'`, the Markdown contains “融资信息获取失败”, and the strict model has no separate financing status field. A `recommendedProduct=null` report must contain only evidence gaps, source status and next verification actions: no product matrix, product names, target roles or sales approach. Also test stored-report presentation at exactly 7 days, after 7 days, and repeated presentation without duplicate warnings.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/report.test.ts
```

- [ ] **Step 3: 实现 ReportModel builder 和 Markdown renderer**

Builder may only dereference existing fact/evidence IDs and copies only target-entity facts whose attribution agrees with every cited reference. It also copies `industryEvidenceIds` into the strict `ReportModel`. Renderer contains no conditional scoring logic. The evidence table renders `EvidenceFact.statement` and one row per cited `EvidenceReference`; industry classification and latest financing are rendered as separately sourced statements when their references are not already represented by a fact row. Escape Markdown table pipes/newlines in cell content; render only real direct HTTP(S) URLs as links, render null as “来源链接不可用”, include `collectedAt`, and require real links for industry classification, key facts, latest financing and recommended-product evidence in key-conclusion coverage. `presentStoredReport` uses `completed_at` to add or remove the unique >7-day dynamic-signal warning without persisting a `ReportModel`. Cache reuse metadata is returned by `submit_assessment`, not embedded in `ReportModel`, Markdown or `get_assessment_report`.

- [ ] **Step 4: 运行测试并提交**

```bash
rtk npm test -- --run tests/report.test.ts
rtk npm run typecheck
rtk git add src/report tests/report.test.ts
rtk git commit -m "feat: render auditable markdown assessment reports"
```

### Task 9: FIFO 队列、完整评估编排和失败降级

**Files:**
- Create: `src/orchestration/fifo-queue.ts`, `assessment-runner.ts`, `assessment-service.ts`
- Modify: `src/orchestration/retry.ts`, `call-budget.ts`
- Create: `src/logging/logger.ts`
- Test: `tests/queue.test.ts`, `tests/assessment-runner.test.ts`, `tests/assessment-service.test.ts`, `tests/logging.test.ts`

**Interfaces:**
- Produces: `AssessmentQueue.enqueue(id)`, `start()`, `stopAccepting()`.
- Produces: `AssessmentService.submit/status/report` consumed by MCP tools.
- Consumes all adapters, rules, renderer and repositories.

- [ ] **Step 1: 写失败集成测试**

Cover FIFO order/concurrency 1, waiting tasks still `processing`, completed-cache submit returning `completed/cache_hit=true/cached_at=completed_at`, new and duplicate processing returning `processing/cache_hit=false`, TTL based only on `completed_at`, cached-report presentation calling `presentStoredReport` so exactly 7 days is current and later reads are stale with one warning, force refresh, failed resubmit, QCC-only failure, search-only failure, both failure empty report, Ark failure producing no `ReportModel`, SQLite completion failure, search-budget exhaustion preventing `DoubaoSearchClient.search` from starting, startup interruption marking, and exactly two attempts maximum for every QCC/search/Ark request with no adapter-internal resend.
Logging tests assert one JSON line per upstream attempt with assessment ID, user ID, source, duration, success/error and attempt count, while API keys, Authorization headers, report bodies and raw upstream payloads never appear.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/queue.test.ts tests/assessment-runner.test.ts tests/assessment-service.test.ts tests/logging.test.ts
```

- [ ] **Step 3: 实现队列并组合既有 retry helper**

Queue stores only assessment UUIDs in memory, shifts in submission order and starts at most configured concurrency. Use the Task 4 `retryOnce` for every QCC/search/Ark request; do not add any second retry loop. It performs at most two attempts, records each attempt in `CallBudget`, and returns its typed result rather than swallowing errors.
`logger.ts` writes newline-delimited JSON through an injected `LogSink`; it accepts only an allowlisted event object and serializes typed error code/message, never arbitrary request/response objects.

- [ ] **Step 4: 实现评估 runner 和服务**

Runner flow is fixed: load task/identity → concurrently collect QCC and search within budget → build `ResearchBundle` → Ark extraction → deterministic rules → ReportModel/Markdown → atomic completion. If both research sources fail, pass an empty bundle to Ark and complete with `overallOpportunity='待核实'`, `recommendedProduct=null` and a gaps-only Markdown report; if Ark or persistence fails, mark failed and store no Markdown.
On report reads, the service calls the report module's `presentStoredReport` with persisted `completed_at`; it must not hand-edit Markdown or persist a refreshed `ReportModel`.

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run tests/queue.test.ts tests/assessment-runner.test.ts tests/assessment-service.test.ts tests/logging.test.ts
rtk npm run typecheck
rtk git add src/orchestration src/logging tests/queue.test.ts tests/assessment-runner.test.ts tests/assessment-service.test.ts tests/logging.test.ts
rtk git commit -m "feat: orchestrate cached assessments with fifo execution"
```

### Task 10: 组合应用、部署产物和模拟端到端

**Files:**
- Create: `src/index.ts`, `Dockerfile`, `README.md`
- Create: `tests/mcp-e2e.test.ts`
- Modify: `src/mcp/tools.ts`, `src/mcp/http-app.ts`

**Interfaces:**
- Produces: runnable `npm start` service and `/mcp` endpoint.

- [ ] **Step 1: 写模拟端到端失败测试**

Start app on ephemeral localhost port with in-memory SQLite and fake QCC/search/Ark. Construct `const client = new Client({ name:'e2e', version:'1.0.0' }, { versionNegotiation:{ mode:'auto' } })`, connect through `StreamableHTTPClientTransport`, then call profile, submit, poll, and report. Assert Markdown/source status, cross-user UUID read, exact cache-field placement, and `client.getProtocolEra() === 'modern'` immediately after `connect()` and after the first successful MCP call.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/mcp-e2e.test.ts
```

- [ ] **Step 3: 实现 composition root 和生命周期**

Load `.env` only outside production, validate config, open DB, run schema, fail interrupted tasks, construct repositories/adapters/services, start queue then HTTP listener. On SIGTERM/SIGINT stop accepting, close listener, let current task finish for at most 30 seconds, then close upstream clients and DB; do not requeue unfinished work.
Add `GET /healthz` returning only `{ "status": "ok" }`; document that the reverse proxy must restrict it to the internal load balancer. It must not expose configuration, queue depth, database paths or upstream state.

- [ ] **Step 4: 增加 Dockerfile 和 README**

Use `node:24-bookworm-slim`, non-root user, multi-stage build, mounted `/data`, `SQLITE_PATH=/data/salestools.sqlite`, one process, no bundled `.env`. README documents local setup, token CLI, Codex bearer environment variable, four tools, cache semantics, source failures and reverse-proxy HTTPS/Host requirements.

- [ ] **Step 5: 运行完整模拟验证并提交**

```bash
rtk npm test
rtk npm run typecheck
rtk npm run build
rtk docker build -t salestools-mcp:v0.1 .
rtk git add src/index.ts src/mcp Dockerfile README.md tests/mcp-e2e.test.ts
rtk git commit -m "feat: assemble deployable target assessment mcp"
```

Expected: all tests PASS, build exits 0, Docker image builds.

### Task 11: 一家真实企业的人工端到端验收

**Deferred gate:** 本任务明确延后，只有真实凭证已写入未提交的 `.env`、可访问的 HTTPS `/mcp` endpoint 已就绪、并取得一家企业的明确授权后才能开始。上述前置条件缺一时记录为“未执行”，不伪造夹具或把模拟 E2E 当作真实验收；Tasks 1–10 的实现完成不依赖本任务。2026-08-30 用户明确批准一次仅限 Task 11 的本地 `127.0.0.1` HTTP 技术链路例外；该例外不改变生产 HTTPS 要求，也没有覆盖 TLS 终止、反向代理、生产 Host 或生产 Origin 校验。

**Files:**
- Create: `docs/validation/real-e2e-result.md`

**Interfaces:**
- Produces: one sanitized record of the already required real MCP validation; no extra script, test harness or production interface.

- [ ] **Step 1: 启动已完成的服务并配置 Codex 客户端**

Verify all three deferred prerequisites first: an authorized real `.env`, one reachable HTTPS `/mcp` endpoint, and one authorized company; then use one enabled Bearer Token. The recorded 2026-08-30 run used the explicitly approved loopback HTTP exception and therefore cannot satisfy production transport/security validation. Configure the current Codex MCP client to call the selected endpoint; do not commit credentials, the real credit code, report body or raw upstream payload.

- [ ] **Step 2: 人工调用四工具闭环**

In Codex call `get_company_profile` for one authorized company, explicitly confirm one candidate, call `submit_assessment`, poll `get_assessment_status`, then call `get_assessment_report`. Do not submit a second task while the first is processing.

- [ ] **Step 3: 核对结果**

Acceptance requires: profile resolves to the confirmed entity; assessment reaches `completed`; `get_assessment_report` returns completed Markdown stating the financing result or its evidence gap and containing real direct evidence links where available. Null QCC links must display “来源链接不可用” and cannot make coverage true. A gaps-only completed report may omit product/role/sales recommendations. Any `failed` status is an acceptance failure, not an accepted explanatory outcome: record the reason, fix it, and rerun this task. This single completed run validates connectivity and contracts only. Contract/link-semantics changes invalidate the old link-coverage verdict until a new real run; never relabel it passed without rerunning.

- [ ] **Step 4: 记录验收结果并提交**

Write `docs/validation/real-e2e-result.md` with date, elapsed time, source statuses, whether financing was obtained or explicitly failed, whether every key conclusion has a link, and any adapter/schema mismatch. Do not include sensitive company details or claim sales accuracy from this one company.

```bash
rtk git add docs/validation/real-e2e-result.md
rtk git commit -m "test: validate one authorized real assessment flow"
```

## Final Verification Gate

Tasks 1–10 use the following implementation gate; Task 11 is the separate deferred real-environment gate above.

- [ ] Run `rtk npm test` — expected all unit/contract/integration tests PASS.
- [ ] Run `rtk npm run typecheck` — expected zero TypeScript errors.
- [ ] Run `rtk npm run build` — expected `dist/` generated successfully.
- [ ] Run `rtk rg -n "@modelcontextprotocol/sdk|DOUBAO_SEARCH_CREDENTIAL|QCC_MCP_EXECUTIVE|QCC_MCP_TENDER|TODO|TBD" package.json src tests README.md .env.example` — expected no matches.
- [ ] Run `rtk rg -n "API_KEY=.+|CREDENTIAL=.+|Bearer [A-Za-z0-9_-]{16}" . --glob '!package-lock.json' --glob '!.git/**'` — expected no real secrets.
- [ ] Run `rtk rg -n "cache_hit" docs/superpowers/specs/2026-08-28-target-customer-assessment-mcp-v0.1-design.md docs/superpowers/plans/2026-08-29-target-customer-assessment-mcp-v0.1.md` and inspect every match — expected only profile/submit contracts, examples, tests or explanatory prohibitions; no report output field.
- [x] Task 11 was rerun after the nullable-link/Ark-budget changes using the user-approved local `127.0.0.1` HTTP exception and a fresh temporary SQLite database. After a TDD fix for repetitive unavailable-link audit gaps exhausting the Ark prompt budget, the single repaired-code submission reached `completed` in 491 seconds. The report contained the legal entity, source timestamps, an explicit financing gap, source status labels, only real direct links or unavailable-link labels, seven opportunity rows for a non-null recommendation, and no detected unsupported personality/revenue/procurement claims. See `docs/validation/real-e2e-result.md`. This does not cover TLS, reverse proxy, production Host or Origin.
