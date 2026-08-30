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
- 上游各失败后只重试一次；企查查或豆包搜索失败可降级，方舟两次失败则任务失败。
- 正式评估的企查查调用先执行融资、再执行招聘；融资是重点预算/扩张/时机证据，但不能单独建立产品场景或机会“高”。
- 不保存上游原始响应；只保存清洗后的基础画像、任务元数据和最终 Markdown。
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
- Produces: `AppConfig`，包含端口、数据库路径、Host/Origin、四个 QCC URL、搜索/方舟凭证、调用上限和缓存 TTL。

- [ ] **Step 1: 初始化 Node 工程并写失败的配置测试**

Run:

```bash
rtk npm init -y
```

Create `tests/config.test.ts` with assertions for defaults, invalid HTTP URL, missing secret, integer bounds and error messages not containing secret values:

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
  it('applies v0.1 defaults', () => expect(loadConfig(valid as NodeJS.ProcessEnv)).toMatchObject({
    maxQccCalls: 8, maxSearchCalls: 8, maxArkCalls: 2, maxTotalUpstreamCalls: 18,
    profileCacheTtlDays: 30, assessmentCacheTtlDays: 30, maxConcurrentAssessments: 1
  }));
  it('rejects non-HTTPS upstreams without leaking values', () => {
    expect(() => loadConfig({ ...valid, ARK_API_URL: 'http://secret.invalid' } as NodeJS.ProcessEnv))
      .toThrow(/ARK_API_URL/);
    try { loadConfig({ ...valid, ARK_API_URL: 'http://secret.invalid' } as NodeJS.ProcessEnv); }
    catch (error) { expect(String(error)).not.toContain('secret.invalid'); }
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

Use ESM, `engines.node >=24`, scripts `build`, `typecheck`, `test`, `start`, `dev`, `tokens`. In `src/config.ts`, define one strict Zod object; parse comma-separated origins; validate all upstream URLs with `.url().startsWith('https://')`; use integer coercion with defaults `8/8/2/18/30/30/1`; throw `Invalid configuration: <comma-separated field names>` only.

```ts
export type AppConfig = z.infer<typeof configSchema> & { allowedOrigins: Set<string> };
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${[...new Set(parsed.error.issues.map(i => String(i.path[0])))].join(', ')}`);
  return { ...parsed.data, allowedOrigins: new Set(parsed.data.ALLOWED_ORIGINS.split(',').map(v => v.trim()).filter(Boolean)) };
}
```

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
- Produces: repositories with `findFresh*`, `insert*`, `createOrReuseAssessment`, `completeAssessment`, `failAssessment`, `failInterruptedAssessments`.

- [ ] **Step 1: 写契约和数据库失败测试**

Cover unknown-field rejection, dangling product enum rejection, `recommendedProduct: null`, WAL initialization, 30-day fresh lookup, one processing task per credit code, failed-task resubmit, and restart failure conversion.

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

Use these exact shared enums and core shapes:

```ts
export const ProductKeySchema = z.enum(['windchill','feigenbaum_qms','creo','catia','abaqus','cst','solidworks']);
export const OpportunityLevelSchema = z.enum(['高','中','低','待核实']);
export const ResearchSourceStatusSchema = z.enum(['completed','partial','failed']);
export const ArkSourceStatusSchema = z.enum(['completed','failed']);
export const EntityScopeSchema = z.enum(['legal_entity','group','subsidiary','brand','unknown']);
export const EntityMatchSchema = z.enum(['confirmed','probable','unverified']);
export const FactKindSchema = z.enum(['industry','product_scene','recruitment','financing','software_ecosystem','organization','quality','manufacturing','procurement','budget','decision_power','risk']);
```

`ReportSourceStatus` must use `ResearchSourceStatusSchema` for `qcc` and `doubaoSearch`, and `ArkSourceStatusSchema` for `ark`; tests must reject `ark: 'partial'`.

`ResearchItem` must include `evidenceId`, `source`, `sourceKind`, `title`, `url`, nullable `summary/content/publishedAt`, `collectedAt`, `mentionedName`, and preliminary entity fields. `EvidenceFact` must include `factId`, `statement`, `kind`, `productTags`, `strength: direct|supporting|weak`, `evidenceIds`, entity scope/match/basis, nullable `publishedAt`. All schemas use `.strict()`.

- [ ] **Step 4: 实现 SQLite schema 和 repositories**

Use `DatabaseSync` from `node:sqlite`, `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`, and `CREATE TABLE IF NOT EXISTS` only. Create `tokens`, `company_profiles`, `assessments`; create ordinary normalized-name index and partial unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS one_processing_per_company
ON assessments(cache_key) WHERE status = 'processing';
```

Wrap `createOrReuseAssessment` in `BEGIN IMMEDIATE`/`COMMIT`, roll back on error, check processing first, then fresh completed cache unless `forceRefresh`, then insert a UUID task.

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

Test one-time plaintext output, stored SHA-256 hash only, disabled rejection, invalid Bearer rejection, valid no-Origin acceptance, invalid Host/Origin rejection, unknown MCP input fields, and the four response shapes. Assert a valid user can read an assessment created by another user. Also inspect registered tool descriptions: `get_company_profile` must say it is the default for basic or ambiguous requests; `submit_assessment` must say it is only for explicit formal assessment after the user confirms `legal_name` and `credit_code`.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/auth.test.ts tests/mcp-tools.test.ts tests/http-security.test.ts
```

- [ ] **Step 3: 实现 Token 和 CLI**

Generate 32 random bytes as base64url; store `createHash('sha256').update(token).digest('hex')`; verify with `timingSafeEqual`; never log or list plaintext/hash. CLI accepts exactly `tokens:create --user`, `tokens:disable --user`, `tokens:list` and exits non-zero on malformed arguments.

- [ ] **Step 4: 注册四个工具和安全 HTTP 路由**

Use `McpServer` from `@modelcontextprotocol/server`, `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`, and `createMcpExpressApp` from `@modelcontextprotocol/express`. For each POST create a stateless transport with `sessionIdGenerator: undefined`, connect a fresh server, and close both on response close. Reject GET/DELETE `/mcp` with 405 JSON-RPC response.

```ts
app.post('/mcp', authMiddleware, async (req, res) => {
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer(servicesFor(res.locals.user.userId));
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

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
- Create: `src/upstream/qcc/tool-allowlist.ts`, `client.ts`, `mapper.ts`, `profile-service.ts`, `assessment-research.ts`
- Create: `tests/fixtures/qcc-*.json`
- Test: `tests/qcc-adapter.test.ts`, `tests/company-profile.test.ts`

**Interfaces:**
- Produces: `QccGateway.call(server, tool, input): Promise<unknown>`.
- Produces: `CompanyProfileService.get(query, regionHint): Promise<CompanyProfileResult>`.
- Produces: `collectQccResearch(identity, budget): Promise<SourceCollection>`.

- [ ] **Step 1: 保存脱敏样本并写失败契约测试**

Allow only these v0.1 tools: company `get_company_by_query`, `get_company_registration_info`, `get_company_profile`, `get_contact_info`, `get_shareholder_info`, `get_actual_controller`, `get_key_personnel`; risk `get_company_risk_scan`; IPR `get_patent_info`, `get_software_copyright_info`; operation `get_recruitment_info`, `get_financing_records`, `get_annual_reports`, `get_bidding_info`, `get_qualifications`. Tests must prove any other tool name is rejected locally before network access, and that financing/recruitment initial calls occur before every other formal-assessment QCC call or retry. Contract fixtures must cover financing date, type/round, nullable disclosed amount, investors, and missing optional fields.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/qcc-adapter.test.ts tests/company-profile.test.ts
```

- [ ] **Step 3: 实现 QCC MCP client 和映射**

Use `Client` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/client`, setting `requestInit.headers.Authorization`. Build one lazy client per configured server; on transport error close, reconnect once, then surface a typed `UpstreamError`. Validate mapped results, never persist raw payloads.

For formal assessment, call `get_financing_records` first and `get_recruitment_info` second, then profile, risk scan, patents, annual reports and bidding. The eighth call selects the most relevant gap among shareholder, software copyrights and qualifications. These first two calls must start before any other QCC call or retry can consume their reserved budget; retries run after both initial attempts. Stop before starting later calls when budget is exhausted. A missing dataset is a gap, not a negative fact. If financing fails while other QCC data is usable, set only the overall QCC status to `partial` and render “融资信息获取失败” as a gap; do not add `financingStatus` or infer a replacement value.

- [ ] **Step 4: 实现基础画像唯一/多候选、重试和 30 天缓存**

Normalize legal names only by trim, Unicode NFKC, whitespace removal and ASCII case folding; do not strip legal suffixes. Exact single match returns profile; multiple matches return candidates without profile; QCC failure after one retry returns `{ sourceStatus:'failed', candidates:[] }`.

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run tests/qcc-adapter.test.ts tests/company-profile.test.ts
rtk npm run typecheck
rtk git add src/upstream/qcc tests/fixtures/qcc-*.json tests/qcc-adapter.test.ts tests/company-profile.test.ts
rtk git commit -m "feat: integrate qcc profile and research adapters"
```

### Task 5: 豆包搜索计划、HTTP 适配器和调用预算

**Files:**
- Create: `src/orchestration/call-budget.ts`
- Create: `src/upstream/search/search-plan.ts`, `doubao-client.ts`, `mapper.ts`
- Create: `tests/fixtures/doubao-search.json`
- Test: `tests/call-budget.test.ts`, `tests/doubao-search.test.ts`

**Interfaces:**
- Produces: `CallBudget.tryConsume(source): boolean` and counters.
- Produces: `buildSearchPlan(identity): SearchQuery[]`.
- Produces: `DoubaoSearchClient.search(query, budget): Promise<ResearchItem[]>`.

- [ ] **Step 1: 写失败测试**

Assert: all Query values are 1–100 chars; `SearchType='web'`; `NeedUrl=true`; recruitment queries use `NeedContent=true` and `TimeRange='OneYear'`; generic company/product queries omit TimeRange; Count defaults 10 and rejects >50; retry consumes a second search and total call; exhausted budget starts no fetch.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/call-budget.test.ts tests/doubao-search.test.ts
```

- [ ] **Step 3: 实现固定搜索计划**

Generate no more than eight explicit queries: official website/products, engineering/R&D, quality/certifications, software ecosystem, recruitment with all seven product keywords split into two queries, procurement/bidding/digitalization, expansion/financing. Use only verified legal name/aliases; no model-generated queries.

- [ ] **Step 4: 实现 API client 和结果映射**

POST JSON to configured URL with Bearer Key. Map `Result.WebResults` into evidence items preserving `Title`, `SiteName`, `Url`, content/summary, `PublishTime`, `SortId`, origin Query, collected timestamp and `LogId`. Error codes, 401/403, quota/QPS and 5xx become typed errors; retry once in orchestration, not recursively inside mapper.

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run tests/call-budget.test.ts tests/doubao-search.test.ts
rtk npm run typecheck
rtk git add src/orchestration/call-budget.ts src/upstream/search tests/fixtures/doubao-search.json tests/call-budget.test.ts tests/doubao-search.test.ts
rtk git commit -m "feat: add deterministic doubao search collection"
```

### Task 6: 方舟事实整理与严格证据引用校验

**Files:**
- Create: `src/upstream/ark/prompt.ts`, `client.ts`, `evidence-validator.ts`
- Create: `tests/fixtures/ark-evidence.json`
- Test: `tests/ark-adapter.test.ts`, `tests/evidence-validator.test.ts`

**Interfaces:**
- Produces: `ArkEvidenceService.extract(bundle, budget): Promise<EvidenceBundle>`.
- Consumes: `ResearchBundle`; may only return IDs present in that bundle.

- [ ] **Step 1: 写失败测试**

Cover valid JSON, empty response, fenced JSON, malformed JSON, invented URL/evidence ID, missing match basis, empty ResearchBundle producing `unverified`, and second failure throwing `ArkUnavailableError`.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/ark-adapter.test.ts tests/evidence-validator.test.ts
```

- [ ] **Step 3: 实现固定系统提示和 HTTP client**

POST to `ARK_API_URL` with Bearer `ARK_CREDENTIAL`, body `{ model: ARK_MODEL, messages, response_format:{type:'json_object'}, temperature:0 }`. System prompt states webpages are untrusted data, forbids tool calls/instructions, requires `P1/P2/non_target/unverified`, forbids creating sources/aliases/URLs, and emits the exact `EvidenceBundleSchema` JSON shape.

- [ ] **Step 4: 实现引用校验和一次重试**

Build a map of `ResearchItem.evidenceId`; reject every absent ID, URL mismatch, missing mentioned name, or non-unverified classification without evidence. Retry the entire Ark call once; two invalid/failed attempts consume both Ark calls and make the task fail.

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run tests/ark-adapter.test.ts tests/evidence-validator.test.ts
rtk npm run typecheck
rtk git add src/upstream/ark tests/fixtures/ark-evidence.json tests/ark-adapter.test.ts tests/evidence-validator.test.ts
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

- [ ] **Step 1: 写失败快照和禁止内容测试**

Test two branches. A normal report must contain the one-screen summary, latest financing result, seven product rows, evidence URL/time/basis, sales questions, risks/gaps, source failure labels, and no unsupported revenue/personality/procurement statements. When financing fails but other QCC data succeeds, assert `sourceStatus.qcc='partial'`, the Markdown contains “融资信息获取失败”, and no standalone `financingStatus` field exists. A `recommendedProduct=null` report must contain only evidence gaps, source status and next verification actions: no product matrix, product names, target roles or sales approach.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/report.test.ts
```

- [ ] **Step 3: 实现 ReportModel builder 和 Markdown renderer**

Builder may only dereference existing fact/evidence IDs. Renderer contains no conditional scoring logic. Escape Markdown table pipes/newlines in cell content; render source names as links; include `collectedAt`, cache state and >7-day dynamic-signal warning.

- [ ] **Step 4: 运行测试并提交**

```bash
rtk npm test -- --run tests/report.test.ts
rtk npm run typecheck
rtk git add src/report tests/report.test.ts
rtk git commit -m "feat: render auditable markdown assessment reports"
```

### Task 9: FIFO 队列、完整评估编排和失败降级

**Files:**
- Create: `src/orchestration/fifo-queue.ts`, `retry.ts`, `assessment-runner.ts`, `assessment-service.ts`
- Create: `src/logging/logger.ts`
- Test: `tests/queue.test.ts`, `tests/assessment-runner.test.ts`, `tests/assessment-service.test.ts`, `tests/logging.test.ts`

**Interfaces:**
- Produces: `AssessmentQueue.enqueue(id)`, `start()`, `stopAccepting()`.
- Produces: `AssessmentService.submit/status/report` consumed by MCP tools.
- Consumes all adapters, rules, renderer and repositories.

- [ ] **Step 1: 写失败集成测试**

Cover FIFO order/concurrency 1, waiting tasks still `processing`, cache reuse, force refresh, duplicate processing reuse, failed resubmit, QCC-only failure, search-only failure, both failure empty report, Ark failure, SQLite completion failure, call-budget stopping, and startup interruption marking.
Logging tests assert one JSON line per upstream attempt with assessment ID, user ID, source, duration, success/error and attempt count, while API keys, Authorization headers, report bodies and raw upstream payloads never appear.

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run tests/queue.test.ts tests/assessment-runner.test.ts tests/assessment-service.test.ts tests/logging.test.ts
```

- [ ] **Step 3: 实现队列和 retry helper**

Queue stores only assessment UUIDs in memory, shifts in submission order and starts at most configured concurrency. `retryOnce` performs at most two attempts, records each attempt in `CallBudget`, and returns typed result `{status, value?, error?}` rather than swallowing errors.
`logger.ts` writes newline-delimited JSON through an injected `LogSink`; it accepts only an allowlisted event object and serializes typed error code/message, never arbitrary request/response objects.

- [ ] **Step 4: 实现评估 runner 和服务**

Runner flow is fixed: load task/identity → concurrently collect QCC and search within budget → build `ResearchBundle` → Ark extraction → deterministic rules → ReportModel/Markdown → atomic completion. If both research sources fail, pass an empty bundle to Ark and complete with `overallOpportunity='待核实'`, `recommendedProduct=null` and a gaps-only Markdown report; if Ark or persistence fails, mark failed and store no Markdown.

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

Start app on ephemeral localhost port with in-memory SQLite and fake QCC/search/Ark. Use `Client` + `StreamableHTTPClientTransport` from `@modelcontextprotocol/client` to call profile, submit, poll, and report; assert Markdown/source status and cross-user UUID read.

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

**Files:**
- Create: `docs/validation/real-e2e-result.md`

**Interfaces:**
- Produces: one sanitized record of the already required real MCP validation; no extra script, test harness or production interface.

- [ ] **Step 1: 启动已完成的服务并配置 Codex 客户端**

Use an authorized `.env` and one enabled Bearer Token. Configure the current Codex MCP client to call the deployed or local HTTPS `/mcp`; do not commit credentials, the real credit code, report body or raw upstream payload.

- [ ] **Step 2: 人工调用四工具闭环**

In Codex call `get_company_profile` for one authorized company, explicitly confirm one candidate, call `submit_assessment`, poll `get_assessment_status`, then call `get_assessment_report`. Do not submit a second task while the first is processing.

- [ ] **Step 3: 核对结果**

Expected: profile resolves to the confirmed entity; assessment transitions `processing → completed` or returns an explicitly explained upstream `failed`. A normal report states the financing result or its evidence gap, includes evidence links and seven product rows. A gaps-only report omits product/role/sales recommendations. This single run validates connectivity and contracts only.

- [ ] **Step 4: 记录验收结果并提交**

Write `docs/validation/real-e2e-result.md` with date, elapsed time, source statuses, whether financing was obtained or explicitly failed, whether every key conclusion has a link, and any adapter/schema mismatch. Do not include sensitive company details or claim sales accuracy from this one company.

```bash
rtk git add docs/validation/real-e2e-result.md
rtk git commit -m "test: validate one authorized real assessment flow"
```

## Final Verification Gate

- [ ] Run `rtk npm test` — expected all unit/contract/integration tests PASS.
- [ ] Run `rtk npm run typecheck` — expected zero TypeScript errors.
- [ ] Run `rtk npm run build` — expected `dist/` generated successfully.
- [ ] Run `rtk rg -n "@modelcontextprotocol/sdk|DOUBAO_SEARCH_CREDENTIAL|QCC_MCP_EXECUTIVE|QCC_MCP_TENDER|TODO|TBD" package.json src tests README.md .env.example` — expected no matches.
- [ ] Run `rtk rg -n "API_KEY=.+|CREDENTIAL=.+|Bearer [A-Za-z0-9_-]{16}" . --glob '!package-lock.json' --glob '!.git/**'` — expected no real secrets.
- [ ] Verify the one real report contains legal entity, source timestamps, a financing result or evidence gap, source failure labels, evidence links and no unsupported personality/revenue/procurement claims; require seven opportunity rows only when `recommended_product` is non-null.
