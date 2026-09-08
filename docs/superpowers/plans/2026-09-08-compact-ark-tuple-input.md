# Compact Ark Tuple Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用固定 15 字段数组替代发送给 Ark 的逐条对象，在不丢失证据或削弱来源校验的前提下降低请求字节和批次数。

**Architecture:** `ResearchBundle` 在进程内保持不变，仅由 `buildArkMessages` 在网络边界转换为紧凑输入信封。现有压缩器和批次规划器继续处理完整对象，并通过生产使用的 `buildArkMessages` 计算真实请求字节；Ark 输出仍针对原批次的完整 `ResearchBundle` 校验。

**Tech Stack:** Node.js 24、TypeScript 7、Vitest、现有 Ark Chat Completions 适配器

**Spec:** `docs/superpowers/specs/2026-09-08-compact-ark-tuple-input-design.md`

## Global Constraints

- 每条材料保留原始 `evidenceId`，不得合并或生成聚合证据 ID。
- 元组固定为 15 位，并保留 `null` 占位；第 11 位必须是逐条 `collectedAt`，以满足现有来源校验。
- 不发送 `query`、`position`、`logId`、`sourceStatus` 或 `gaps`。
- 不新增运行时 Schema、模块、依赖、数据库字段或配置字段。
- 不修改 Ark 输出 `EvidenceBundle`、MCP、SQLite、机会规则或报告结构。
- `ARK_REQUEST_MAX_BYTES` 保持 `12288`。
- 只有普渡真实材料的规划结果 `≤16` 批时，才把本机 `.env` 改成 `MAX_ARK_CALLS=20`、`MAX_TOTAL_UPSTREAM_CALLS=36`。
- `.env` 不提交 Git，真实验证记录不得包含凭证或上游原始正文。
- 所有 shell 命令均以 `rtk` 开头。

## File Map

- Modify: `src/upstream/ark/prompt.ts` — 定义唯一的字段顺序，并在 Ark 网络边界生成紧凑输入。
- Modify: `tests/ark-adapter.test.ts` — 冻结输入协议、调整请求解析辅助函数并验证来源校验不回退。
- Modify: `tests/ark-batch-plan.test.ts` — 比较相同材料的对象基线与数组格式，验证全量规划及批次数下降。
- Temporary during real validation: `tmp/diagnose-ark-batches.ts` — 只采集 QCC/豆包并规划批次；运行后删除，不提交。
- Conditional local-only: `.env` — 真实诊断达标后将 Ark/总调用预算改为 `20/36`。

---

### Task 0: Checkpoint the already verified A+C baseline

**Files:**
- Existing modified production files: `src/orchestration/assessment-runner.ts`, `src/upstream/ark/batch-plan.ts`, `src/upstream/ark/payload-budget.ts`
- Existing modified tests: `tests/ark-adapter.test.ts`, `tests/ark-batch-plan.test.ts`, `tests/assessment-runner.test.ts`

**Interfaces:**
- Consumes: 当前工作树中已验证的正文首/中/尾保留、批次不重复携带 gaps、固定双并发实现。
- Produces: 一个干净、可回退的基线提交，后续元组协议提交不混入此前实现。

- [ ] **Step 1: Confirm the dirty files are exactly the known baseline**

Run:

```bash
rtk git status --short
rtk git diff --check
```

Expected: 仅出现上述 6 个已知代码/测试文件，以及本计划或规范文档；`git diff --check` 成功。

- [ ] **Step 2: Re-run the focused baseline tests**

Run:

```bash
rtk npm test -- --run tests/ark-adapter.test.ts tests/ark-batch-plan.test.ts tests/assessment-runner.test.ts
```

Expected: 三个测试文件全部通过。

- [ ] **Step 3: Commit only the six baseline files**

Run:

```bash
rtk git add src/orchestration/assessment-runner.ts src/upstream/ark/batch-plan.ts src/upstream/ark/payload-budget.ts tests/ark-adapter.test.ts tests/ark-batch-plan.test.ts tests/assessment-runner.test.ts
rtk git commit -m "perf: improve Ark batch coverage"
```

Expected: 文档和 `.env` 不在该提交中。

---

### Task 1: Serialize the compact Ark input envelope

**Files:**
- Modify: `src/upstream/ark/prompt.ts`
- Modify: `tests/ark-adapter.test.ts`

**Interfaces:**
- Consumes: `buildArkMessages(bundle: ResearchBundle): Array<{ role: 'system' | 'user'; content: string }>`。
- Produces: 相同函数签名；用户消息变为 `{ identity, collectedAt, items }`，`items` 为固定 15 位数组。

- [ ] **Step 1: Add a request-payload test helper without changing production contracts**

在 `tests/ark-adapter.test.ts` 中保留现有 HTTP body 读取逻辑，但把网络载荷与供既有断言使用的解码结果分开：

```ts
type ArkInputTuple = [
  string, 'qcc' | 'doubao_search', 'company' | 'risk' | 'ipr' | 'operation' | 'web',
  string, string | null, string | null, string | null, string | null, string | null,
  string | null, string, string, 'legal_entity' | 'group' | 'subsidiary' | 'brand' | 'unknown',
  'confirmed' | 'probable' | 'unverified', string[],
];

interface ArkInputPayload {
  identity: ResearchBundle['identity'];
  collectedAt: string;
  items: ArkInputTuple[];
}

function requestPayload(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>): ArkInputPayload {
  const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
  const userMessage = body.messages.find((message: { role: string }) => message.role === 'user');
  return JSON.parse(userMessage.content);
}
```

把原来依赖 `requestResearch(...).items[n].field` 的断言改成读取元组固定下标；对需要可读字段的多处既有测试增加测试内 `tupleAsItem(tuple)` 辅助函数。该函数只能用于测试，不进入生产代码：

```ts
function tupleAsItem(tuple: ArkInputTuple) {
  return {
    evidenceId: tuple[0], source: tuple[1], sourceKind: tuple[2], title: tuple[3],
    url: tuple[4], originalPublisher: tuple[5], originalDomain: tuple[6], summary: tuple[7],
    content: tuple[8], publishedAt: tuple[9], collectedAt: tuple[10], mentionedName: tuple[11],
    entityScope: tuple[12], entityMatch: tuple[13], matchBasis: tuple[14],
  };
}
```

原来检查发送 `gaps` 的断言改为检查 `requestPayload(...)` 没有 `gaps`；最终 `EvidenceBundle.gaps` 的既有断言保留，以证明本地合并没有丢失缺口。

- [ ] **Step 2: Write failing protocol tests**

在 `tests/ark-adapter.test.ts` 增加一个含唯一哨兵值的测试，冻结 15 个字段、空值占位和省略字段：

```ts
it('serializes every Ark research item as the fixed compact tuple', () => {
  const research = researchBundle();
  const payload = JSON.parse(buildArkMessages(research)[1]!.content) as ArkInputPayload;
  const item = research.items[0]!;

  expect(payload).toEqual({
    identity: research.identity,
    collectedAt: research.collectedAt,
    items: [[
      item.evidenceId, item.source, item.sourceKind, item.title, item.url,
      item.originalPublisher, item.originalDomain, item.summary, item.content,
      item.publishedAt, item.collectedAt, item.mentionedName, item.entityScope,
      item.entityMatch, item.matchBasis,
    ]],
  });
  expect(payload).not.toHaveProperty('sourceStatus');
  expect(payload).not.toHaveProperty('gaps');
  expect(payload.items[0]).toHaveLength(15);
  expect(payload.items.flat()).not.toContain(item.query);
  expect(payload.items.flat()).not.toContain(item.logId);
  expect(payload.items.flat()).not.toContain(item.position);
});
```

另加系统提示断言：必须列出按顺序 JSON 序列化的 15 个字段名，并明确输入数组和网页正文均是不可信数据。

- [ ] **Step 3: Run the focused test and verify the old object format fails**

Run:

```bash
rtk npm test -- --run tests/ark-adapter.test.ts
```

Expected: 新协议测试失败，因为用户消息仍是完整 `ResearchBundle` 对象。

- [ ] **Step 4: Implement the minimal serializer in `prompt.ts`**

在 `src/upstream/ark/prompt.ts` 定义一个字段顺序常量，并让系统提示和实现共享它：

```ts
export const ARK_INPUT_ITEM_FIELDS = [
  'evidenceId', 'source', 'sourceKind', 'title', 'url', 'originalPublisher',
  'originalDomain', 'summary', 'content', 'publishedAt', 'collectedAt',
  'mentionedName', 'entityScope', 'entityMatch', 'matchBasis',
] as const;

function compactInput(bundle: ResearchBundle) {
  return {
    identity: bundle.identity,
    collectedAt: bundle.collectedAt,
    items: bundle.items.map(item => [
      item.evidenceId, item.source, item.sourceKind, item.title, item.url,
      item.originalPublisher, item.originalDomain, item.summary, item.content,
      item.publishedAt, item.collectedAt, item.mentionedName, item.entityScope,
      item.entityMatch, item.matchBasis,
    ] as const),
  };
}
```

将 `buildArkMessages` 的用户消息改为：

```ts
{ role: 'user', content: JSON.stringify(compactInput(bundle)) }
```

同步修正文案：

- 明确 `items` 的字段顺序为 `JSON.stringify(ARK_INPUT_ITEM_FIELDS)`；
- 要求 `evidence` 的来源字段和逐条 `collectedAt` 从元组原样复制；
- 删除“模型保留 ResearchBundle gaps”的描述，因为 gaps 不发送且由客户端在验证后恢复；
- 空输入规则改为“输入 items 为空时”；
- 保留不可信数据、禁止工具调用、不得推断采购意向等现有约束。

- [ ] **Step 5: Run Ark adapter tests**

Run:

```bash
rtk npm test -- --run tests/ark-adapter.test.ts
```

Expected: 全部通过；真实 HTTP body 仍不超过配置字节上限，输出来源校验测试不回退。

- [ ] **Step 6: Commit the compact wire format**

Run:

```bash
rtk git add src/upstream/ark/prompt.ts tests/ark-adapter.test.ts
rtk git commit -m "perf: compact Ark input serialization"
```

---

### Task 2: Prove batch reduction without dropping evidence

**Files:**
- Modify: `tests/ark-batch-plan.test.ts`

**Interfaces:**
- Consumes: `buildArkMessages` 的新数组格式和现有 `planArkBatches(bundle, maxBytes, measureBytes)`。
- Produces: 一个回归测试，证明相同材料在相同上限下比完整对象格式批次更少，且每个唯一证据 ID 恰好规划一次。

- [ ] **Step 1: Add an object-format baseline byte measurer**

在测试文件中增加：

```ts
function serializedObjectBytes(candidate: ResearchBundle): number {
  const messages = buildArkMessages(candidate).map(message => message.role === 'user'
    ? { ...message, content: JSON.stringify(candidate) }
    : message);
  return Buffer.byteLength(JSON.stringify({
    model: 'ep-test', messages,
    response_format: { type: 'json_object' }, temperature: 0,
  }), 'utf8');
}
```

- [ ] **Step 2: Extend the 92-item planner test**

在现有 92 条材料测试中同时生成对象基线与紧凑计划：

```ts
const objectPlan = planArkBatches(input, 12_288, serializedObjectBytes);
const compactPlan = planArkBatches(input, 12_288, serializedBytes);
const plannedIds = compactPlan.batches.flatMap(batch =>
  batch.bundle.items.map(entry => entry.evidenceId));

expect(compactPlan.batches.length).toBeLessThan(objectPlan.batches.length);
expect(plannedIds).toHaveLength(compactPlan.candidateCount);
expect(new Set(plannedIds).size).toBe(compactPlan.candidateCount);
expect(compactPlan.unplannedItems).toEqual([]);
expect(compactPlan.batches.every(batch => batch.requestBytes <= 12_288)).toBe(true);
```

保留确定性重复规划断言，避免通过随机装箱获得偶然结果。

- [ ] **Step 3: Run the planner and provenance suites**

Run:

```bash
rtk npm test -- --run tests/ark-batch-plan.test.ts tests/evidence-validator.test.ts tests/ark-evidence-merge.test.ts
```

Expected: 全部通过；92 个候选没有遗漏或重复，虚构 ID 和被省略批次的 ID 仍被拒绝。

- [ ] **Step 4: Commit the efficiency regression test**

Run:

```bash
rtk git add tests/ark-batch-plan.test.ts
rtk git commit -m "test: verify compact Ark batch efficiency"
```

---

### Task 3: Verify the repository and gate the real Pudu run

**Files:**
- Temporary: `tmp/diagnose-ark-batches.ts`
- Conditional local-only: `.env`

**Interfaces:**
- Consumes: QCC/豆包真实凭证、已确认主体“深圳市普渡科技股份有限公司 / 91440300359857967F”、`ArkEvidenceService.planBatches`。
- Produces: 不含正文或凭证的批次指标；仅在 `batchCount <= 16` 时启用本机 `20/36` 并执行一次正式评估。

- [ ] **Step 1: Run full deterministic verification before spending upstream calls**

Run:

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
```

Expected: 全部测试、类型检查、构建和空白检查通过。

- [ ] **Step 2: Create a temporary read-only planning harness**

用 `apply_patch` 创建 `tmp/diagnose-ark-batches.ts`。脚本必须：

1. `dotenv.config()` 后使用 `loadConfig(process.env)`；
2. 用现有 `ProfileRepository` 查找信用代码 `91440300359857967F`；若缓存不存在，只调用 `CompanyProfileService.get('深圳市普渡科技股份有限公司')` 获取并保存主体画像；
3. 创建 `CallBudget({ qcc: 8, doubaoSearch: 8, ark: 20, total: 36 }, { reserveArkCalls: 20 })`；
4. 并行执行 `QccResearchCollector.collectQccResearch(...)` 和按 `buildSearchPlan(identity)` 顺序调用的 8 次豆包搜索；搜索调用必须复用 `retryOnce('doubao_search', budget, ...)`；
5. 用两边的 `items/sourceStatus/gaps` 构建并解析 `ResearchBundleSchema`；
6. 仅调用 `new ArkEvidenceService(...).planBatches(research)`，不得调用 `extract`、`extractWithAudit` 或创建 assessment；
7. 只输出以下指标，不输出原始材料：

```ts
import { DatabaseSync } from 'node:sqlite';
import { config as loadDotEnv } from 'dotenv';
import {
  ResearchBundleSchema,
  type IdentityProfile,
  type ResearchItem,
  type ResearchSourceStatus,
} from '../src/contracts/index.js';
import { loadConfig } from '../src/config.js';
import { initializeDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { CallBudget } from '../src/orchestration/call-budget.js';
import { retryOnce, safeUpstreamErrorMessage } from '../src/orchestration/retry.js';
import { ArkEvidenceService } from '../src/upstream/ark/client.js';
import { QccResearchCollector, type SourceCollection } from '../src/upstream/qcc/assessment-research.js';
import { QccGateway } from '../src/upstream/qcc/client.js';
import { CompanyProfileService } from '../src/upstream/qcc/profile-service.js';
import { DoubaoSearchClient } from '../src/upstream/search/doubao-client.js';
import { buildSearchPlan } from '../src/upstream/search/search-plan.js';

const LEGAL_NAME = '深圳市普渡科技股份有限公司';
const CREDIT_CODE = '91440300359857967F';

async function collectSearch(
  identity: IdentityProfile,
  budget: CallBudget,
  client: DoubaoSearchClient,
): Promise<SourceCollection> {
  const items: ResearchItem[] = [];
  const gaps: string[] = [];
  const errors: string[] = [];
  let failedCalls = 0;
  let stoppedByBudget = false;
  for (const query of buildSearchPlan(identity)) {
    if (!budget.canConsume('doubao_search')) {
      stoppedByBudget = true;
      gaps.push('豆包搜索调用预算已用尽');
      break;
    }
    const result = await retryOnce('doubao_search', budget, () => client.search(query));
    if (result.status === 'completed') {
      items.push(...result.value);
    } else {
      failedCalls += 1;
      errors.push(safeUpstreamErrorMessage('doubao_search', result.error.code));
      gaps.push(`豆包搜索查询失败：${query.purpose}`);
      if (result.error.code === 'BUDGET_EXHAUSTED') stoppedByBudget = true;
    }
  }
  const status: ResearchSourceStatus = items.length === 0
    ? 'failed'
    : failedCalls > 0 || stoppedByBudget ? 'partial' : 'completed';
  return {
    items,
    sourceStatus: {
      status,
      error: status === 'failed' ? errors[0] ?? '豆包搜索未返回可用资料' : errors[0] ?? null,
    },
    gaps: [...new Set(gaps)],
  };
}

const envPath = process.env.SALESTOOLS_ENV_PATH;
loadDotEnv(envPath === undefined ? {} : { path: envPath });
const config = loadConfig(process.env);
const database = initializeDatabase(new DatabaseSync(':memory:'));
const profiles = new ProfileRepository(database);
const qccGateway = new QccGateway({
  urls: {
    company: config.qccMcpCompanyUrl,
    risk: config.qccMcpRiskUrl,
    ipr: config.qccMcpIprUrl,
    operation: config.qccMcpOperationUrl,
  },
  apiKey: config.qccApiKey,
});

try {
  let profile = profiles.findFreshByCreditCode(CREDIT_CODE, new Date(), config.profileCacheTtlDays);
  if (profile === null) {
    const profileService = new CompanyProfileService(qccGateway, profiles, {
      profileCacheTtlDays: config.profileCacheTtlDays,
      maxQccCalls: config.maxQccCalls,
      maxTotalCalls: config.maxTotalUpstreamCalls,
    });
    const result = await profileService.get(LEGAL_NAME);
    if (result.sourceStatus !== 'completed') throw new Error('无法获取已确认主体画像');
    profile = profiles.findFreshByCreditCode(CREDIT_CODE, new Date(), config.profileCacheTtlDays);
  }
  if (profile === null || profile.identity.legalName !== LEGAL_NAME) {
    throw new Error('主体画像与已确认法定主体不一致');
  }

  const budget = new CallBudget(
    { qcc: 8, doubaoSearch: 8, ark: 20, total: 36 },
    { reserveArkCalls: 20 },
  );
  const qccCollector = new QccResearchCollector(qccGateway);
  const searchClient = new DoubaoSearchClient({
    url: config.doubaoSearchApiUrl,
    apiKey: config.doubaoSearchApiKey,
  });
  const [qcc, search] = await Promise.all([
    qccCollector.collectQccResearch(profile.identity, budget),
    collectSearch(profile.identity, budget, searchClient),
  ]);
  const research = ResearchBundleSchema.parse({
    identity: profile.identity,
    items: [...qcc.items, ...search.items],
    sourceStatus: { qcc: qcc.sourceStatus, doubaoSearch: search.sourceStatus },
    gaps: [...new Set([...qcc.gaps, ...search.gaps])],
    collectedAt: new Date().toISOString(),
  });
  const ark = new ArkEvidenceService({
    url: config.arkApiUrl,
    model: config.arkModel,
    credential: config.arkCredential,
    requestMaxBytes: config.arkRequestMaxBytes,
  });
  const plan = ark.planBatches(research);
  console.log(JSON.stringify({
    legalName: profile.identity.legalName,
    originalCount: plan.originalCount,
    candidateCount: plan.candidateCount,
    deduplicatedCount: plan.deduplicatedCount,
    batchCount: plan.batches.length,
    unplannedCount: plan.unplannedItems.length,
    maxRequestBytes: Math.max(...plan.batches.map(batch => batch.requestBytes)),
    qccStatus: qcc.sourceStatus.status,
    doubaoStatus: search.sourceStatus.status,
  }, null, 2));
} finally {
  await qccGateway.close();
  database.close();
}
```

脚本使用 `try/finally` 关闭 `QccGateway` 和 SQLite 数据库。

- [ ] **Step 3: Run the real planning diagnostic and remove the harness**

Run:

```bash
rtk env SALESTOOLS_ENV_PATH=/Users/tang-codeing/code/salestools/.env npm exec -- tsx tmp/diagnose-ark-batches.ts
```

Expected:

- `legalName` 精确为“深圳市普渡科技股份有限公司”；
- `unplannedCount` 为 `0`；
- `maxRequestBytes <= 12288`；
- 记录实际 `batchCount`。

随后用 `apply_patch` 删除 `tmp/diagnose-ark-batches.ts`，并运行：

```bash
rtk git status --short
```

Expected: 临时脚本不再出现，且没有上游原始数据被写入仓库。

- [ ] **Step 4: Enforce the configuration gate**

如果 `batchCount > 16`：停止，不修改 `.env`，不提交正式评估；报告 `originalCount/candidateCount/batchCount/maxRequestBytes`。

如果 `batchCount <= 16`：用 `apply_patch` 只修改被 `.gitignore` 忽略的本机 `.env`：

```dotenv
MAX_ARK_CALLS=20
MAX_TOTAL_UPSTREAM_CALLS=36
```

Run:

```bash
rtk env SALESTOOLS_ENV_PATH=/Users/tang-codeing/code/salestools/.env npm exec -- tsx -e "import { config } from 'dotenv'; import { loadConfig } from './src/config.ts'; config({path:process.env.SALESTOOLS_ENV_PATH}); const c=loadConfig(process.env); console.log(JSON.stringify({ark:c.maxArkCalls,total:c.maxTotalUpstreamCalls}))"
```

Expected: `{"ark":20,"total":36}`。不要修改或提交 `.env.example`。

- [ ] **Step 5: Run one formal real assessment only after the gate passes**

通过本地 HTTP MCP 使用现有有效 Bearer Token：

1. 调用 `get_company_profile`，输入 `query="深圳市普渡科技股份有限公司"`；
2. 确认返回信用代码为 `91440300359857967F`；
3. 调用 `submit_assessment`，输入精确法定名称、信用代码和 `force_refresh=true`；
4. 轮询 `get_assessment_status` 直到 `completed` 或 `failed`；
5. `completed` 时调用 `get_assessment_report`，检查审计字段。

验收必须同时满足：

- `batchCount <= 16`；
- `successfulBatchCount + failedBatchCount === batchCount`；
- `processedCount + unprocessedCount === candidateCount`；
- 不存在因 `BUDGET_EXHAUSTED` 产生的未处理批次；
- 日志显示 Ark 最大同时在途调用数为 2；
- 任一真实批次失败均明确记录，不能被当作成功；
- 报告及日志不泄露凭证。

- [ ] **Step 6: Final repository check**

Run:

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
rtk git status --short --branch
```

Expected: 所有验证通过；`.env` 和临时诊断脚本未进入 Git；仅剩预期文档状态或干净工作树。
