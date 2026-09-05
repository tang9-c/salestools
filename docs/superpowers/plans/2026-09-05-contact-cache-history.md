# Contact Cache History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `get_contacts` 增加 30 天透明缓存、永久追加快照和与当前联系人分栏显示的历史任职证据。

**Architecture:** SQLite 仓储只持久化每次查询的当前联系人快照，联系人服务用规范化的 `query + region_hint` 生成稳定缓存键并在 30 天内跳过上游调用。返回前由纯函数把最新快照与更早快照投影为当前联系人和最多 10 条历史证据；服务级 singleflight 合并同进程同键并发刷新。

**Tech Stack:** Node.js 24、TypeScript 7、`node:sqlite`、`node:crypto`、Zod 4、MCP SDK 2、Vitest 3。

## Global Constraints

- 缓存键使用 `SHA-256(JSON.stringify([normalizedQuery, normalizedRegionHint]))`；规范化为 NFKC、trim、连续空白合并和英文小写，缺省地域为 `null`。
- 最新快照 `stored_at >= now - 30 * 86_400_000` 时视为新鲜；恰好 30 天命中，超过 1 毫秒刷新。
- 快照永久追加，不覆盖、不删除；正常空结果和部分结果也缓存，抛出的失败不缓存。
- 上游刷新失败时只允许 `ContactLookupError` 使用最新旧快照兜底；数据库读、解析、写错误必须继续抛出。
- 当前联系人和历史联系人每家公司分别最多 10 人；企业总数仍最多 3 家，当前企业优先，再补历史-only 企业。
- 历史状态固定为 `historical_evidence`，不得推断“在职”“离职”“卸任”或企业别名关系。
- 公开输出和持久化均不得包含邮箱、电话、搜索正文、模型原始输出或密钥。
- 不新增配置项、`force_refresh`、缓存元数据、历史分页、清理或反查接口。

---

### Task 1: 联系人快照契约、缓存键与历史投影

**Files:**
- Modify: `src/contracts/contact.ts`
- Create: `src/contacts/contact-cache.ts`
- Modify: `tests/contacts.test.ts`

**Interfaces:**
- Produces: `ContactSnapshotPayloadSchema`、`ContactSnapshotPayload`、`HistoricalContact`、`contactCacheIdentity(input)`、`projectContactHistory(snapshots)`。
- Consumes: 现有 `PublicIdentityTextSchema`、`DirectEvidenceUrlSchema`、`UtcTimestampSchema` 和联系人服务字段命名。

- [ ] **Step 1: 写公共历史契约和缓存键失败测试**

在 `tests/contacts.test.ts` 增加：

```ts
import {
  contactCacheIdentity,
  projectContactHistory,
  type StoredContactSnapshot,
} from '../src/contacts/contact-cache.js';

it('normalizes query and region into a stable isolated cache key', () => {
  const left = contactCacheIdentity({ query: '  ＡBC  科技 ', regionHint: ' 上海 ' });
  const right = contactCacheIdentity({ query: 'abc 科技', regionHint: '上海' });
  expect(left).toEqual(right);
  expect(contactCacheIdentity({ query: 'abc 科技' }).cacheKey)
    .not.toBe(left.cacheKey);
});

it('accepts strict historical contacts and rejects direct contact details', () => {
  const output = {
    companies: [{
      company_name: '测试制造有限公司',
      contacts: [],
      historical_contacts: [{
        name: '张三', title: '研发总监', source_url: 'https://example.cn/team',
        published_at: null, first_seen_at: '2026-01-01T00:00:00.000Z',
        last_seen_at: '2026-02-01T00:00:00.000Z', status: 'historical_evidence',
      }],
    }],
    warnings: [], collected_at: '2026-09-05T00:00:00.000Z',
  };
  expect(GetContactsOutputSchema.parse(output)).toEqual(output);
  expect(GetContactsOutputSchema.safeParse({
    ...output,
    companies: [{ ...output.companies[0], historical_contacts: [{
      ...output.companies[0].historical_contacts[0], email: 'x@example.cn',
    }] }],
  }).success).toBe(false);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `rtk npm test -- tests/contacts.test.ts`

Expected: FAIL，提示 `contact-cache.js` 不存在且历史输出不符合当前 schema。

- [ ] **Step 3: 扩展严格联系人契约**

在 `src/contracts/contact.ts` 导出可复用的当前联系人、快照和历史 schema，并保持所有对象 `.strict()`：

```ts
export const PublicContactSchema = z.object({
  name: PublicIdentityTextSchema,
  title: PublicIdentityTextSchema,
  source_url: DirectEvidenceUrlSchema,
  published_at: UtcTimestampSchema.nullable(),
}).strict();

export const ContactSnapshotPayloadSchema = z.object({
  companies: z.array(z.object({
    company_name: PublicIdentityTextSchema,
    contacts: z.array(PublicContactSchema).max(10),
  }).strict()).max(3),
  warnings: z.array(z.string()),
  collected_at: UtcTimestampSchema,
}).strict();

export const HistoricalContactSchema = PublicContactSchema.extend({
  first_seen_at: UtcTimestampSchema,
  last_seen_at: UtcTimestampSchema,
  status: z.literal('historical_evidence'),
}).strict();

export const GetContactsOutputSchema = z.object({
  companies: z.array(z.object({
    company_name: PublicIdentityTextSchema,
    contacts: z.array(PublicContactSchema).max(10),
    historical_contacts: z.array(HistoricalContactSchema).max(10),
  }).strict()).max(3),
  warnings: z.array(z.string()),
  collected_at: UtcTimestampSchema,
}).strict();

export type ContactSnapshotPayload = z.infer<typeof ContactSnapshotPayloadSchema>;
export type HistoricalContact = z.infer<typeof HistoricalContactSchema>;
```

- [ ] **Step 4: 实现缓存键和纯历史投影**

创建 `src/contacts/contact-cache.ts`，使用以下公开边界：

```ts
import { createHash } from 'node:crypto';
import type { ContactSnapshotPayload } from '../contracts/index.js';

export interface StoredContactSnapshot {
  snapshotId: number;
  cacheKey: string;
  normalizedQuery: string;
  normalizedRegionHint: string | null;
  payload: ContactSnapshotPayload;
  storedAt: string;
}

export function normalizeContactCachePart(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function contactCacheIdentity(input: { query: string; regionHint?: string }): {
  cacheKey: string; normalizedQuery: string; normalizedRegionHint: string | null;
} {
  const normalizedQuery = normalizeContactCachePart(input.query);
  const normalizedRegionHint = input.regionHint === undefined
    ? null : normalizeContactCachePart(input.regionHint);
  const cacheKey = createHash('sha256')
    .update(JSON.stringify([normalizedQuery, normalizedRegionHint]))
    .digest('hex');
  return { cacheKey, normalizedQuery, normalizedRegionHint };
}
```

`projectContactHistory(snapshots)` 接收按 `storedAt, snapshotId` 升序排列的非空数组并返回 `GetContactsOutput`。算法固定为：

1. 最后一个快照提供 `contacts`、`warnings` 和 `collected_at`。
2. 身份键是规范化 `company_name\0name\0title`；更早快照中、最新快照中不存在的身份才进入历史。
3. 相同历史身份聚合最早/最晚 `payload.collected_at`；来源取最后一次出现的记录。
4. 当前企业保持最新顺序；历史-only 企业按其最大 `last_seen_at` 倒序追加；企业合计截断到 3。
5. 每家历史联系人按 `last_seen_at` 倒序、再按姓名和职位稳定排序，截断到 10；历史-only 企业的 `contacts` 为 `[]`。

- [ ] **Step 5: 增加历史投影边界测试并运行**

测试至少构造三个 `StoredContactSnapshot`，验证：首次快照历史为空；消失身份进入历史；重新出现后移除；职位变化留下旧职位；历史-only 企业可见；当前企业优先；企业和历史联系人上限；同时间排序确定。

Run: `rtk npm test -- tests/contacts.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交契约和纯逻辑**

```bash
git add src/contracts/contact.ts src/contacts/contact-cache.ts tests/contacts.test.ts
git commit -m "feat: define contact history projection"
```

---

### Task 2: SQLite 追加式联系人快照仓储

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/contact-snapshot-repository.ts`
- Modify: `tests/db.test.ts`

**Interfaces:**
- Consumes: `ContactSnapshotPayloadSchema`、`StoredContactSnapshot`。
- Produces: `ContactSnapshotRepository.append(input)`、`findFresh(cacheKey, now, ttlDays)`、`findLatest(cacheKey)`、`findAll(cacheKey)`。

- [ ] **Step 1: 写表结构、边界和往返失败测试**

在 `tests/db.test.ts` 增加以下断言场景：

```ts
import { ContactSnapshotRepository } from '../src/db/contact-snapshot-repository.js';

it('creates and indexes append-only contact snapshots', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  expect(tables).toContainEqual({ name: 'contact_query_snapshots' });
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
  expect(indexes).toContainEqual({ name: 'contact_snapshots_cache_time' });
});

it('appends history and treats exactly thirty days as fresh', () => {
  const repository = new ContactSnapshotRepository(db);
  repository.append({
    cacheKey: 'a'.repeat(64), normalizedQuery: '测试制造', normalizedRegionHint: null,
    payload: snapshotPayload, storedAt: '2026-08-06T00:00:00.000Z',
  });
  repository.append({
    cacheKey: 'a'.repeat(64), normalizedQuery: '测试制造', normalizedRegionHint: null,
    payload: newerPayload, storedAt: '2026-09-05T00:00:00.000Z',
  });
  expect(repository.findAll('a'.repeat(64))).toHaveLength(2);
  expect(repository.findFresh('a'.repeat(64), new Date('2026-10-05T00:00:00.000Z'), 30))
    ?.payload).toEqual(newerPayload);
  expect(repository.findFresh('a'.repeat(64), new Date('2026-10-05T00:00:00.001Z'), 30))
    .toBeNull();
});
```

另用 SQL 手工插入损坏 `result_json`，断言读取抛出 `ContactSnapshotDataError`，错误消息不包含 JSON、姓名、邮箱或电话。

- [ ] **Step 2: 运行数据库测试并确认失败**

Run: `rtk npm test -- tests/db.test.ts`

Expected: FAIL，表和仓储不存在。

- [ ] **Step 3: 新增追加式表和索引**

在 `SCHEMA_SQL` 追加：

```sql
CREATE TABLE IF NOT EXISTS contact_query_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  normalized_region_hint TEXT,
  result_json TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  stored_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS contact_snapshots_cache_time
ON contact_query_snapshots(cache_key, stored_at DESC, snapshot_id DESC);
```

- [ ] **Step 4: 实现严格仓储**

创建 `src/db/contact-snapshot-repository.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { ContactSnapshotPayloadSchema, UtcTimestampSchema, type ContactSnapshotPayload }
  from '../contracts/index.js';
import type { StoredContactSnapshot } from '../contacts/contact-cache.js';

export interface AppendContactSnapshotInput {
  cacheKey: string;
  normalizedQuery: string;
  normalizedRegionHint: string | null;
  payload: ContactSnapshotPayload;
  storedAt: string;
}

export class ContactSnapshotDataError extends Error {
  override readonly name = 'ContactSnapshotDataError';
  constructor(snapshotId: number, options?: ErrorOptions) {
    super(`Invalid stored contact snapshot ${snapshotId}`, options);
  }
}

export interface ContactSnapshotStore {
  append(input: AppendContactSnapshotInput): void;
  findFresh(cacheKey: string, now: Date, ttlDays: number): StoredContactSnapshot | null;
  findLatest(cacheKey: string): StoredContactSnapshot | null;
  findAll(cacheKey: string): StoredContactSnapshot[];
}
```

所有读取通过单一 `toStoredSnapshot(row)`：先 `JSON.parse`，再用 `ContactSnapshotPayloadSchema.parse` 校验，并校验 `collected_at === payload.collected_at`、`stored_at` 为 UTC 时间、缓存键为 64 位小写十六进制；失败统一抛出不含原始数据的 `ContactSnapshotDataError`。`append` 先 parse payload 和时间，再执行纯 `INSERT`。`findFresh` 使用 `stored_at >= cutoff` 并按 `stored_at DESC, snapshot_id DESC LIMIT 1`；`findLatest` 同排序无 cutoff；`findAll` 按升序返回。

- [ ] **Step 5: 运行仓储测试并验证无敏感持久化**

Run: `rtk npm test -- tests/db.test.ts`

Expected: PASS。额外读取 `result_json` 并断言不包含 `email`、`phone`、测试电话号码、搜索正文或模型原始输出字段。

- [ ] **Step 6: 提交仓储**

```bash
git add src/db/schema.ts src/db/contact-snapshot-repository.ts tests/db.test.ts
git commit -m "feat: persist contact query snapshots"
```

---

### Task 3: 联系人服务缓存、兜底与 singleflight

**Files:**
- Modify: `src/contacts/contact-service.ts`
- Modify: `tests/contacts.test.ts`

**Interfaces:**
- Consumes: `ContactSnapshotStore`、`contactCacheIdentity`、`projectContactHistory`。
- Produces: 保持 `ContactService.get(input): Promise<ContactServiceOutput>`；`ContactServiceOutput` 增加 `historicalContacts`。

- [ ] **Step 1: 写缓存命中、刷新和失败语义测试**

把现有测试工厂改为注入内存 `ContactSnapshotStore`。测试内存仓储必须完整实现生产接口，避免 mock 出与真实 TTL 不一致的行为：

```ts
class MemoryContactSnapshots implements ContactSnapshotStore {
  readonly rows: StoredContactSnapshot[] = [];

  constructor(initial: StoredContactSnapshot[] = []) {
    this.rows.push(...initial);
  }

  append(input: AppendContactSnapshotInput): void {
    this.rows.push({ ...input, snapshotId: this.rows.length + 1 });
  }

  findFresh(cacheKey: string, now: Date, ttlDays: number): StoredContactSnapshot | null {
    const cutoff = now.getTime() - ttlDays * 86_400_000;
    return this.findAll(cacheKey).filter(row => Date.parse(row.storedAt) >= cutoff).at(-1) ?? null;
  }

  findLatest(cacheKey: string): StoredContactSnapshot | null {
    return this.findAll(cacheKey).at(-1) ?? null;
  }

  findAll(cacheKey: string): StoredContactSnapshot[] {
    return this.rows.filter(row => row.cacheKey === cacheKey)
      .sort((a, b) => a.storedAt.localeCompare(b.storedAt) || a.snapshotId - b.snapshotId);
  }
}
```

增加独立测试；实例构造沿用现有 `webResult()`、`candidate()` fixture：

```ts
it('returns a fresh snapshot without search or Ark calls', async () => {
  const identity = contactCacheIdentity({ query: '测试制造' });
  const snapshots = new MemoryContactSnapshots([{
    snapshotId: 1, ...identity, payload: snapshotPayload, storedAt: collectedAt,
  }]);
  let upstreamCalls = 0;
  const instance = new ContactService({
    snapshots,
    searchClient: { searchWeb: async () => { upstreamCalls += 1; return []; } },
    extractor: { extract: async () => {
      upstreamCalls += 1;
      return { contacts: [], selection: { totalPages: 0, includedPages: 0, textTruncated: false } };
    } },
    now: () => new Date(collectedAt),
  });
  const result = await instance.get({ query: '测试制造' });
  expect(upstreamCalls).toBe(0);
  expect(result.collectedAt).toBe(collectedAt);
  expect(result.companies[0]?.historicalContacts).toEqual([]);
});

it('falls back only on upstream failure and does not renew stale TTL', async () => {
  const identity = contactCacheIdentity({ query: '测试制造' });
  const snapshots = new MemoryContactSnapshots([{
    snapshotId: 1, ...identity, payload: snapshotPayload,
    storedAt: '2026-07-01T00:00:00.000Z',
  }]);
  const failed = new UpstreamError('doubao_search', 'AUTHENTICATION_ERROR', 'private detail');
  const instance = new ContactService({
    snapshots,
    searchClient: { searchWeb: async () => { throw failed; } },
    extractor: { extract: async () => {
      throw new Error('extractor must not run');
    } },
    now: () => new Date('2026-09-05T00:00:00.000Z'),
  });
  const before = snapshots.findAll(identity.cacheKey).length;
  const result = await instance.get({ query: '测试制造' });
  expect(result.warnings).toContain('实时刷新失败，使用超过 30 天的历史缓存');
  expect(snapshots.findAll(identity.cacheKey)).toHaveLength(before);
});
```

其中 `snapshotPayload` 是通过 `ContactSnapshotPayloadSchema.parse` 创建的固定 fixture，包含一家企业、一名联系人、空 warnings 和 `collected_at === collectedAt`。

还必须验证：无旧快照上游失败；刷新成功追加新快照；正常空结果和部分 warning 被缓存；仓储读/解析/写错误原样抛出且不兜底；同键并发只进行一次搜索/抽取；不同地域并发不合并；rejected promise 后 Map 条目被清除并允许下一次重试。

- [ ] **Step 2: 运行联系人服务测试并确认失败**

Run: `rtk npm test -- tests/contacts.test.ts`

Expected: FAIL，`ContactService` 尚未接受快照仓储且没有历史字段。

- [ ] **Step 3: 将现有上游流程提取为一次刷新**

把当前公开方法声明：

```ts
async get(input: GetContactsServiceInput): Promise<ContactServiceOutput>
```

改为：

```ts
private async fetchSnapshot(input: GetContactsServiceInput): Promise<ContactSnapshotPayload>
```

方法体内从 `const budget = new CallBudget(...)` 到 `companies` 构造完成的既有语句逐字保留，不得改变预算、重试或证据校验逻辑。把既有最终返回语句替换为：

```ts
return ContactSnapshotPayloadSchema.parse({
  companies: companies.map(company => ({
    company_name: company.companyName,
    contacts: company.contacts.map(contact => ({
      name: contact.name,
      title: contact.title,
      source_url: contact.sourceUrl,
      published_at: contact.publishedAt,
    })),
  })),
  warnings,
  collected_at: this.now().toISOString(),
});
```

不要把历史或缓存警告写入模型请求；快照只包含严格 `ContactSnapshotPayloadSchema` 允许的当前结果。

- [ ] **Step 4: 实现透明缓存和旧快照兜底**

把选项和主流程改为：

```ts
export interface ContactServiceOptions {
  searchClient: ContactSearchDependency;
  extractor: ContactExtractorDependency;
  snapshots: ContactSnapshotStore;
  now?: () => Date;
}

const CONTACT_CACHE_TTL_DAYS = 30;
const STALE_WARNING = '实时刷新失败，使用超过 30 天的历史缓存';

async get(input: GetContactsServiceInput): Promise<ContactServiceOutput> {
  const identity = contactCacheIdentity(input);
  const fresh = this.options.snapshots.findFresh(
    identity.cacheKey, this.now(), CONTACT_CACHE_TTL_DAYS,
  );
  if (fresh !== null) {
    return toServiceOutput(projectContactHistory(this.options.snapshots.findAll(identity.cacheKey)));
  }
  return this.singleflight(identity.cacheKey, () => this.refreshAndStore(input, identity));
}
```

`refreshAndStore` 在 singleflight 内再次读取 fresh，避免排队请求重复刷新。它只捕获 `fetchSnapshot()` 抛出的 `ContactLookupError`；捕获后读取 `findLatest`，无旧快照则重新抛出，有旧快照则投影 `findAll` 并去重追加 `STALE_WARNING`。刷新成功后以同一个 `now` 生成 `storedAt`，调用 `append`，再读取 `findAll` 投影；append/findAll 的错误不捕获。

公共服务输出继续使用 camelCase；增加确定性转换：

```ts
function toServiceOutput(output: GetContactsOutput): ContactServiceOutput {
  return {
    companies: output.companies.map(company => ({
      companyName: company.company_name,
      contacts: company.contacts.map(contact => ({
        name: contact.name, title: contact.title, sourceUrl: contact.source_url,
        publishedAt: contact.published_at,
      })),
      historicalContacts: company.historical_contacts.map(contact => ({
        name: contact.name, title: contact.title, sourceUrl: contact.source_url,
        publishedAt: contact.published_at, firstSeenAt: contact.first_seen_at,
        lastSeenAt: contact.last_seen_at, status: contact.status,
      })),
    })),
    warnings: output.warnings,
    collectedAt: output.collected_at,
  };
}
```

- [ ] **Step 5: 实现无泄漏 singleflight**

在实例上增加：

```ts
private readonly inFlight = new Map<string, Promise<ContactServiceOutput>>();

private singleflight(
  cacheKey: string,
  operation: () => Promise<ContactServiceOutput>,
): Promise<ContactServiceOutput> {
  const existing = this.inFlight.get(cacheKey);
  if (existing !== undefined) return existing;
  const pending = operation().finally(() => {
    if (this.inFlight.get(cacheKey) === pending) this.inFlight.delete(cacheKey);
  });
  this.inFlight.set(cacheKey, pending);
  return pending;
}
```

- [ ] **Step 6: 运行联系人测试并提交**

Run: `rtk npm test -- tests/contacts.test.ts`

Expected: PASS，既有证据校验、调用预算和错误安全化测试继续通过。

```bash
git add src/contacts/contact-service.ts tests/contacts.test.ts
git commit -m "feat: cache contact lookups with history"
```

---

### Task 4: 应用接线、MCP 映射和文档

**Files:**
- Modify: `src/index.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/logging/logger.ts`
- Modify: `tests/mcp-tools.test.ts`
- Modify: `tests/mcp-e2e.test.ts`
- Modify: `tests/lifecycle.test.ts`
- Modify: `tests/logging.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ContactSnapshotRepository` 和新的 `ContactServiceOutput.historicalContacts`。
- Produces: 对外 snake_case `historical_contacts`，并在正式应用数据库中共享缓存。

- [ ] **Step 1: 写 MCP 映射和应用重启缓存失败测试**

更新 `tests/mcp-tools.test.ts` 的联系人 fixture：

```ts
historicalContacts: [{
  name: '李四', title: '技术总监', sourceUrl: 'https://example.cn/old-team',
  publishedAt: null, firstSeenAt: '2025-01-01T00:00:00.000Z',
  lastSeenAt: '2025-06-01T00:00:00.000Z', status: 'historical_evidence',
}],
```

预期 MCP 输出必须包含对应 `historical_contacts`、`first_seen_at`、`last_seen_at` 和固定状态，且 output schema 不出现 `cache_hit`、`cached_at`、邮箱或电话。

在 `tests/mcp-e2e.test.ts` 或 `tests/lifecycle.test.ts` 使用同一个临时 SQLite 文件启动、关闭、再启动应用；第二次调用相同 `query + region_hint` 时让上游 mock 抛错，仍应返回第一次快照，证明缓存跨进程生命周期持久化。再用另一 token 调用同键，断言共享同一公开缓存。

- [ ] **Step 2: 运行接线测试并确认失败**

Run: `rtk npm test -- tests/mcp-tools.test.ts tests/mcp-e2e.test.ts tests/lifecycle.test.ts`

Expected: FAIL，应用未注入仓储且 MCP 未映射历史字段。

- [ ] **Step 3: 接入正式仓储**

在 `src/index.ts` 创建并注入单例仓储：

```ts
import { ContactSnapshotRepository } from './db/contact-snapshot-repository.js';

const contactSnapshots = new ContactSnapshotRepository(database);
const contactService = new ContactService({
  searchClient: {
    searchWeb: query => {
      if (searchClient.searchWeb === undefined) {
        throw new UpstreamError(
          'doubao_search', 'INVALID_RESPONSE', 'Contact web search is unavailable',
        );
      }
      return searchClient.searchWeb(query);
    },
  },
  extractor: contactExtractor,
  snapshots: contactSnapshots,
  cacheLogger: logger,
  now: overrides.now,
});
```

把 `const logger = new JsonlLogger(...)` 移到 `ContactService` 构造之前。仓储与数据库生命周期一致；`servicesFor(userId)` 继续共享同一 `contactService`，因此不同 token 命中同一公开缓存。

为满足损坏快照的安全日志要求，在 `JsonlLogger` 增加：

```ts
logContactCacheError(event: {
  operation: 'read' | 'parse' | 'write'; cacheKey: string; error: Error;
}): void {
  this.sink.write(`${JSON.stringify({
    event: 'contact_cache_error',
    timestamp: this.now().toISOString(),
    operation: event.operation,
    cache_key_prefix: event.cacheKey.slice(0, 12),
    error: { name: event.error.name, message: safeMessage(event.error.message) },
  })}\n`);
}
```

`ContactServiceOptions.cacheLogger` 使用最小接口 `Pick<JsonlLogger, 'logContactCacheError'>`。所有仓储调用分别由 `cacheOperation(operation, cacheKey, action)` 包裹：捕获时记录上述事件后原样抛出，绝不转为 stale 成功。`tests/logging.test.ts` 验证日志只有缓存键前 12 位且敏感样例被 `[REDACTED]`。

- [ ] **Step 4: 映射历史 snake_case 输出**

在 `contactsOutput` 的公司映射中增加：

```ts
historical_contacts: company.historicalContacts.map(contact => ({
  name: contact.name,
  title: contact.title,
  source_url: contact.sourceUrl,
  published_at: contact.publishedAt,
  first_seen_at: contact.firstSeenAt,
  last_seen_at: contact.lastSeenAt,
  status: contact.status,
})),
```

更新工具描述，说明“当前联系人和历史网页任职证据分栏返回；历史证据不代表离职状态”。工具数量保持 5。

- [ ] **Step 5: 更新 README**

将“结果不缓存”替换为明确说明：同一规范化企业关键词和地域 30 天内不重复搜索；快照永久追加；历史联系人独立显示且不代表离职；过期刷新失败使用旧快照并告警；简称、全称、别名及不同地域不会自动合并。继续保留不返回邮箱和电话的安全边界。

- [ ] **Step 6: 运行接线测试并提交**

Run: `rtk npm test -- tests/mcp-tools.test.ts tests/mcp-e2e.test.ts tests/lifecycle.test.ts`

Expected: PASS。

```bash
git add src/index.ts src/mcp/tools.ts src/logging/logger.ts tests/mcp-tools.test.ts tests/mcp-e2e.test.ts tests/lifecycle.test.ts tests/logging.test.ts README.md
git commit -m "feat: expose cached contact history"
```

---

### Task 5: 全量验证与安全回归

**Files:**
- Modify only if verification exposes a defect in the files already listed above.

**Interfaces:**
- Consumes: 完整 MCP 服务、SQLite 仓储和联系人缓存路径。
- Produces: 可构建、类型安全且全部测试通过的联系人缓存历史功能。

- [ ] **Step 1: 检查持久化和公开契约中的敏感字段**

Run: `rtk rg -n "email|phone|mobile|telephone" src/contacts src/db/contact-snapshot-repository.ts src/contracts/contact.ts src/mcp/tools.ts`

Expected: 只允许出现用于“禁止直接联系方式”的校验或工具描述，不得出现可持久化或公开的邮箱、电话字段。

- [ ] **Step 2: 运行联系人及数据库重点测试**

Run: `rtk npm test -- tests/contacts.test.ts tests/db.test.ts tests/mcp-tools.test.ts tests/mcp-e2e.test.ts tests/lifecycle.test.ts`

Expected: PASS，无未处理 Promise 或控制台警告。

- [ ] **Step 3: 运行全量测试**

Run: `rtk npm test -- --run`

Expected: 全部测试 PASS。

- [ ] **Step 4: 运行类型检查和构建**

Run: `rtk npm run typecheck && rtk npm run build`

Expected: 两条命令退出码均为 0。

- [ ] **Step 5: 检查差异和工作区**

Run: `rtk git diff --check && rtk git status --short`

Expected: 无空白错误；只包含本计划范围内的预期文件。如果前四个任务均已提交，此处工作区应为空。

- [ ] **Step 6: 仅在验证阶段产生修复时提交**

如果验证产生修复，用 `rtk git status --short` 枚举文件，仅 `git add` 本计划已列出的实际修复文件，然后执行 `git commit -m "test: harden contact cache history"`。如果没有修复，不创建空提交。
