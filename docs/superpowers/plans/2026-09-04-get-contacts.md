# Get Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增同步 MCP 工具 `get_contacts`，仅从豆包检索到的限定公开网页中返回关键岗位人员姓名、职位和原始来源。

**Architecture:** 工具执行两条固定宽查询，把成功返回的中性 `DoubaoWebResult` 交给联系人专用方舟抽取器。抽取器输出内部候选，服务端再用原始搜索材料验证企业名、姓名、职位和 URL，去重并限制为最多 3 家企业、每家 10 人。v1 不调用企查查、不缓存、不返回邮箱或电话。

**Tech Stack:** Node.js 24、TypeScript、Zod 4、MCP SDK 2、Vitest、现有豆包搜索 HTTP 客户端和火山方舟接口。

## Global Constraints

- `query` 长度为 1–48，`region_hint` 长度为 1–16；输入 schema 必须为 strict。
- 只允许企业负责人、研发/技术、数字化/IT、采购和质量负责人。
- 来源只允许企业官网、官方新闻、公众号、招投标公告、专利文件和会议嘉宾页。
- 不返回或持久化邮箱、电话及其他直接联系方式；不新增数据库表。
- 企业最多 3 家，每家联系人最多 10 人；同一企业、姓名和职位只保留一条。
- 一次逻辑抽取最多允许两次方舟网络尝试；两次搜索也分别沿用 `retryOnce`。
- 输出 URL 必须逐字匹配本次豆包搜索返回的直接 URL；发布日期由服务端复制，不能采用模型生成值。

---

### Task 1: 联系人契约与固定搜索计划

**Files:**
- Create: `src/contracts/contact.ts`
- Modify: `src/contracts/index.ts`
- Create: `src/upstream/search/contact-search-plan.ts`
- Modify: `src/upstream/search/doubao-client.ts`
- Modify: `src/upstream/search/mapper.ts`
- Test: `tests/contacts.test.ts`
- Test: `tests/doubao-search.test.ts`

**Interfaces:**
- Produces: `GetContactsOutputSchema`、`GetContactsOutput`、`ContactExtractionCandidateSchema`、`buildContactSearchPlan(query, regionHint)`、中性的 `DoubaoWebSearchRequest`/`DoubaoWebResult` 和 `DoubaoSearchClient.searchWeb()`。
- Consumes: 现有豆包 HTTP 请求、响应信封解析和查询上限规则。

- [ ] **Step 1: 写联系人公开输出和固定查询的失败测试**

在 `tests/contacts.test.ts` 中先覆盖：两条查询均包含企业关键词；可选地域进入查询；查询长度不超过 100；公开输出拒绝额外的 `email`、`phone`、`source_type` 字段；结果上限由后续服务测试验证。

```ts
import { describe, expect, it } from 'vitest';
import { GetContactsOutputSchema } from '../src/contracts/index.js';
import { buildContactSearchPlan } from '../src/upstream/search/contact-search-plan.js';

describe('contact contracts and search plan', () => {
  it('builds exactly two bounded public-source queries', () => {
    const plan = buildContactSearchPlan('测试制造', '上海');
    expect(plan).toHaveLength(2);
    expect(plan.every(item => item.Query.includes('测试制造'))).toBe(true);
    expect(plan.every(item => item.Query.includes('上海'))).toBe(true);
    expect(plan.every(item => item.Query.length <= 100)).toBe(true);
    expect(plan.every(item => item.Filter.NeedUrl && item.Filter.NeedContent)).toBe(true);
  });

  it('rejects direct contact details from public output', () => {
    const result = GetContactsOutputSchema.safeParse({
      companies: [{
        company_name: '测试制造有限公司',
        contacts: [{
          name: '张三', title: '研发总监', source_url: 'https://example.cn/a',
          published_at: null, email: 'zhang@example.cn',
        }],
      }],
      warnings: [], collected_at: '2026-09-04T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `rtk npm test -- tests/contacts.test.ts`

Expected: FAIL，提示 `contact.ts` 或 `contact-search-plan.ts` 无法解析。

- [ ] **Step 3: 实现最小契约**

`src/contracts/contact.ts` 定义严格 schema：

```ts
import { z } from 'zod';
import { DirectEvidenceUrlSchema } from './research.js';
import { UtcTimestampSchema } from './identity.js';

export const ContactRoleCategorySchema = z.enum([
  'executive', 'research_and_development', 'digital_and_it', 'procurement', 'quality',
]);

export const ContactExtractionCandidateSchema = z.object({
  companyName: z.string().trim().min(1),
  name: z.string().trim().min(1),
  title: z.string().trim().min(1),
  roleCategory: ContactRoleCategorySchema,
  sourceType: z.enum([
    'official_website', 'official_news', 'official_wechat', 'tender', 'patent', 'conference',
  ]),
  sourceUrl: DirectEvidenceUrlSchema,
}).strict();

export const GetContactsOutputSchema = z.object({
  companies: z.array(z.object({
    company_name: z.string().trim().min(1),
    contacts: z.array(z.object({
      name: z.string().trim().min(1),
      title: z.string().trim().min(1),
      source_url: DirectEvidenceUrlSchema,
      published_at: UtcTimestampSchema.nullable(),
    }).strict()).max(10),
  }).strict()).max(3),
  warnings: z.array(z.string()),
  collected_at: UtcTimestampSchema,
}).strict();
```

导出对应类型，并从 `src/contracts/index.ts` 统一导出。

- [ ] **Step 4: 实现两条固定查询**

`buildContactSearchPlan` 使用两组固定关键词：

```ts
const intents = [
  '官网 官方新闻 公众号 会议 嘉宾 董事长 总经理',
  '招投标 专利 研发 技术 信息化 数字化 采购 质量 负责人',
] as const;
```

把 `query` 和可选 `regionHint` 经 NFKC、trim 后拼接；输入边界保证最终查询不超过 100。每条查询均为 `SearchType: 'web'`、`Count: 10`、`Filter: { NeedUrl: true, NeedContent: true }`。

不要把模糊企业关键词伪装成现有 `SearchQuery` 的“已确认法定名称”。把豆包客户端拆出一个保持中立的低层接口：

```ts
interface DoubaoWebSearchRequest {
  Query: string;
  SearchType: 'web';
  Count: number;
  Filter: { NeedUrl: true; NeedContent: boolean; TimeRange?: 'OneYear' };
}

interface DoubaoWebResult {
  title: string;
  url: string;
  originalPublisher: string | null;
  originalDomain: string;
  summary: string | null;
  content: string | null;
  publishedAt: string | null;
  position: number;
  logId: string | null;
}
```

`DoubaoSearchClient.searchWeb(request)` 负责现有 HTTP 调用、信封校验和中性网页字段映射；现有 `search(SearchQuery)` 改为调用 `searchWeb()` 后再补充评估专用的主体归属和 `ResearchItem` 字段，保持原公开行为及既有测试不变。`tests/doubao-search.test.ts` 新增 `searchWeb()` 映射测试，并继续证明现有 `search()` 结果完全兼容。

- [ ] **Step 5: 运行联系人测试**

Run: `rtk npm test -- tests/contacts.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交契约与查询计划**

```bash
git add src/contracts/contact.ts src/contracts/index.ts src/upstream/search/contact-search-plan.ts src/upstream/search/doubao-client.ts src/upstream/search/mapper.ts tests/contacts.test.ts tests/doubao-search.test.ts
git commit -m "feat: define contact lookup contracts"
```

---

### Task 2: 方舟抽取、溯源校验与联系人服务

**Files:**
- Create: `src/upstream/ark/contact-extractor.ts`
- Create: `src/contacts/contact-service.ts`
- Modify: `tests/contacts.test.ts`

**Interfaces:**
- Consumes: `DoubaoSearchClient.searchWeb(DoubaoWebSearchRequest)`、`retryOnce`、`CallBudget`、`DoubaoWebResult`。
- Produces: `ContactExtractor.extract(items)` 和 `ContactService.get({ query, regionHint })`。

- [ ] **Step 1: 写服务行为的失败测试**

使用依赖注入的搜索客户端和抽取器，新增以下独立测试：

1. 两条查询均成功，返回经验证的联系人。
2. 一条查询失败，仍返回另一条结果并写入安全化 `warnings`。
3. 两条查询均失败时抛出通用 `ContactLookupError`。
4. 方舟失败时抛出通用 `ContactLookupError`。
5. 模型返回的 URL 不在本次搜索材料中时丢弃。
6. 企业名、姓名或职位不在同一条来源材料中时丢弃。
7. NFKC 与空白归一化后相同的企业、姓名、职位被去重，并选择查询序号更小、搜索排名更高的来源。
8. 限制最多 3 家企业、每家 10 人。
9. 无明确职位的专利发明人或招投标联系人不会被抽取器接受。
10. 全部搜索正常但没有合格人员时返回空结果和固定 warning。

每个 `DoubaoWebResult` 测试数据都显式包含 `url`、`title`、`summary`、`content`、`publishedAt`、`position` 和 `logId`，服务在合并两条查询结果时附加内部查询序号，避免只断言 mock 调用次数。

- [ ] **Step 2: 运行测试并确认因服务不存在而失败**

Run: `rtk npm test -- tests/contacts.test.ts`

Expected: FAIL，提示 `ContactService` 或 `ContactExtractor` 不存在。

- [ ] **Step 3: 实现联系人专用方舟抽取器**

`ContactExtractor` 复用现有方舟 URL、模型、凭据、AbortSignal 和 `ARK_REQUEST_MAX_BYTES`。请求使用 `response_format: { type: 'json_object' }`、`temperature: 0`，输入为带内部查询序号的 `DoubaoWebResult`，只让模型输出：

```ts
type InternalExtraction = {
  contacts: Array<{
    companyName: string;
    name: string;
    title: string;
    roleCategory: 'executive' | 'research_and_development' | 'digital_and_it' | 'procurement' | 'quality';
    sourceType: 'official_website' | 'official_news' | 'official_wechat' | 'tender' | 'patent' | 'conference';
    sourceUrl: string;
  }>;
};
```

提示词明确：不得输出邮箱、电话；不得把没有明确职位的专利发明人或招投标经办人当作联系人；只允许计划定义的岗位和六类来源。输入按查询顺序、`position` 排序并确定性截断摘要/正文，完整序列化请求不得超过现有字节上限。JSON、schema 或容量错误映射为现有 `ArkInvalidOutputError`，网络错误映射为 `ArkUnavailableError`。

- [ ] **Step 4: 实现服务端校验和同步服务**

`ContactService.get`：

```ts
interface GetContactsServiceInput { query: string; regionHint?: string }
interface SearchDependency { searchWeb(query: DoubaoWebSearchRequest): Promise<DoubaoWebResult[]> }
interface ExtractorDependency { extract(items: readonly RankedWebResult[]): Promise<ContactExtractionCandidate[]> }
```

服务建立 `CallBudget`，限制本工具最多 4 次豆包请求尝试、2 次方舟请求尝试、总计 6 次，并设置 `reserveArkCalls: 2`。两条搜索用 `Promise.all` 并各自通过 `retryOnce`；至少一条成功后将成功材料送入一次逻辑方舟抽取，方舟也通过 `retryOnce`。

验证算法必须：

- 以 `sourceUrl` 精确查找本次 `DoubaoWebResult`；找不到即丢弃。
- 对 `title + summary + content` 做 NFKC、大小写和连续空白归一化。
- 同一材料必须包含归一化后的 `companyName`、`name`、`title`。
- `published_at` 只复制匹配材料的 `publishedAt`。
- 按查询序号、`position`、URL 排序，再按归一化 `companyName/name/title` 去重。
- 先保留最多 3 家，再为每家保留最多 10 人。
- 公开输出只构造计划中的五个字段，绝不展开内部 `roleCategory` 或 `sourceType`。

- [ ] **Step 5: 运行联系人测试并修到通过**

Run: `rtk npm test -- tests/contacts.test.ts`

Expected: PASS，且没有未处理 Promise 或控制台警告。

- [ ] **Step 6: 提交联系人服务**

```bash
git add src/upstream/ark/contact-extractor.ts src/contacts/contact-service.ts tests/contacts.test.ts
git commit -m "feat: extract verified public contacts"
```

---

### Task 3: 注册第 5 个 MCP 工具并接入应用生命周期

**Files:**
- Modify: `src/mcp/tool-schemas.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/index.ts`
- Modify: `tests/mcp-tools.test.ts`
- Modify: `tests/mcp-e2e.test.ts`

**Interfaces:**
- Consumes: `ContactService.get` 和 `GetContactsOutputSchema`。
- Produces: MCP 工具 `get_contacts`。

- [ ] **Step 1: 写 MCP 契约和接线的失败测试**

在 `tests/mcp-tools.test.ts` 中把工具列表改为精确 5 个，并验证：

```ts
expect([...byName.keys()].sort()).toEqual([
  'get_assessment_report', 'get_assessment_status', 'get_company_profile',
  'get_contacts', 'submit_assessment',
]);
```

新增合法输入映射断言 `{ query: '测试制造', regionHint: '上海' }`；验证空字符串、49 字符 query、17 字符 region、未知字段和 `force_refresh` 均在调用服务前拒绝。验证 text content 与 structured content 完全一致，输出没有 `email`、`phone`、`role_category`、`source_type`。

在 `tests/mcp-e2e.test.ts` 注入联系人服务替身，通过 HTTP Bearer Token 调用 `get_contacts`，验证鉴权和 snake_case 响应。

- [ ] **Step 2: 运行 MCP 测试并确认缺少第 5 个工具**

Run: `rtk npm test -- tests/mcp-tools.test.ts tests/mcp-e2e.test.ts`

Expected: FAIL，工具列表缺少 `get_contacts`。

- [ ] **Step 3: 注册输入 schema 和工具**

`src/mcp/tool-schemas.ts`：

```ts
export const GetContactsInputSchema = z.object({
  query: z.string().trim().min(1).max(48),
  region_hint: z.string().trim().min(1).max(16).optional(),
}).strict();
```

`McpServices` 增加 `getContacts`；`buildMcpServer` 注册 `get_contacts`，描述明确说明仅用于公开职业身份检索，不返回邮箱和电话，也不保证法人主体确认。输入从 snake_case 映射到 service camelCase，输出始终经 `GetContactsOutputSchema.parse`。

- [ ] **Step 4: 接入应用与关闭流程**

在 `createApplication` 中创建 `ContactExtractor` 和 `ContactService`，复用已存在的 `searchClient`、方舟配置和根 AbortSignal。`servicesFor` 注入 `getContacts` 并通过 `activity.track` 跟踪，使进程关闭时等待或取消在途联系人查询。若联系人抽取器单独持有 HTTP 资源，纳入 `closeUpstreams`；若只使用 `fetch`，不增加空的 close 方法。

- [ ] **Step 5: 运行 MCP 测试**

Run: `rtk npm test -- tests/mcp-tools.test.ts tests/mcp-e2e.test.ts tests/lifecycle.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交 MCP 接线**

```bash
git add src/mcp/tool-schemas.ts src/mcp/tools.ts src/index.ts tests/mcp-tools.test.ts tests/mcp-e2e.test.ts tests/lifecycle.test.ts
git commit -m "feat: expose get_contacts MCP tool"
```

---

### Task 4: 文档、隐私回归和全量验证

**Files:**
- Modify: `README.md`
- Modify: `tests/http-security.test.ts` only if its exact tool-count or response assertions require the fifth tool
- Test: `tests/contacts.test.ts`

**Interfaces:**
- Produces: 用户可见的第 5 个工具说明和完成的回归证据。

- [ ] **Step 1: 写文档断言或人工核对清单**

README 必须把“四个 MCP 工具”改为“五个 MCP 工具”，并记录：输入字段、两类宽查询、最多 3 家/每家 10 人、仅公开职业身份、六类允许来源、不返回邮箱电话、不缓存、不保证法人主体已确认、部分搜索失败会返回 warning。

- [ ] **Step 2: 更新 README**

只修改工具说明和必要的上游行为描述，不改部署、鉴权或正式评估语义。

- [ ] **Step 3: 运行隐私与持久化检查**

Run: `rtk rg -n "contacts_cache" src tests README.md`

Expected: 不出现联系人缓存表。

Run: `rtk rg -n "force_refresh" src/mcp/tool-schemas.ts README.md`

Expected: `force_refresh` 只属于既有正式评估，不出现在 `get_contacts` 输入说明中。

Run: `rtk rg -n "email|phone|邮箱|电话" src/contracts/contact.ts src/contacts src/upstream/ark/contact-extractor.ts`

Expected: 只允许出现在明确禁止这些字段的提示词或拒绝测试中，不能出现在公开输出 schema、返回对象或数据库写入中。

- [ ] **Step 4: 运行完整验证**

```bash
rtk npm test
rtk npm run typecheck
rtk npm run build
```

Expected: 所有测试通过，类型检查与构建退出码均为 0。

- [ ] **Step 5: 检查最终差异**

Run: `rtk git diff --check`

Expected: 无空白错误。

Run: `rtk git status --short`

Expected: 只包含本计划列出的联系人功能、测试和 README 文件。

- [ ] **Step 6: 提交文档与最终回归**

```bash
git add README.md tests/contacts.test.ts tests/http-security.test.ts
git commit -m "docs: document public contact lookup"
```
