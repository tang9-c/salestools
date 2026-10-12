# Company Contact Data Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有数据存储和证据规则的前提下，实现组织与企业的可靠关联，并让搜索、图谱、企业画像、两个问答工具和报告入口共享已有资料。

**Architecture:** Node SQLite 保存显式主体关联和关联操作回执；图谱继续保存联系人、组织和项目。新增一个 CompanyContextService 读取现有仓储及图谱，工具通过它获取摘要、详情和问答材料。使用既有证据 ID 和来源定位信息，不迁移报告、不建设统一主体库。

**Tech Stack:** Node.js >=24、TypeScript、node:sqlite、Zod 4、MCP SDK、Rust/rusqlite/sqlite-knowledge-graph、Vitest、现有 MCP App 与 Playwright、GitHub Actions Ubuntu runner。无新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-12-company-contact-data-reuse-design.md`（设计提交 `7809286`）。执行前必须阅读规格及本计划。

## Global Constraints

- “本次不建设独立统一主体库、全局证据库、通用冲突引擎、网页版本系统、变化通知、补查材料持久化或新的聚合缓存。”
- “浏览已有资料不触发外部调查或正式评估。”
- “只有 confirmed 关联可用于跨库统计、报告展示和事实回答。”
- “不将家庭关系或联系方式加入企业概览和跨库问答材料。”
- “一个组织同一时刻最多关联一家企业”；多个组织节点可关联同一企业，不自动合并。
- “报告目录独立使用 report_offset/report_limit（默认 10，上限 50）”。
- related_updates：“首版限制 20 条，按记录时间倒序返回，注明范围、截断及不可用来源”。
- “问答首版最多补充 20 条跨库材料、读取 12 个相关图谱档案及最新一个已完成报告的快照”。
- “同一文件多次导入不成为多个独立来源”；原报告正文不改写。
- 禁止本地构建，包括 npm run dev、npm run build、cargo build/test/check 和间接 native 编译、页面 bundle、Docker 构建。本地仅类型/语法/diff 检查及不产出构建物的解释器测试。
- native/full-suite/页面 bundle/容器 gate 使用 `.github/workflows/contact-upload-validation.yml`；只读权限、合成资料、临时数据库、空 CI env，不发布或部署，不读取生产密钥。
- 真实宿主验收记录环境版本、tested SHA、实际结果和脱敏证据；Chromium 不替代真实宿主。

---

## 执行边界、文件结构与验证约定

这是一个有共同依赖的交付：关联与查询层先落地，各入口再接入；按下面 10 个任务顺序执行，无需拆成独立平台项目。每个任务可单独检查和提交。

执行前运行 `git status --short`、`git diff --name-only`、`git diff --cached --name-only`，记录基线。已有未提交修改包含 `src/mcp/contact-search-tools.ts`、图谱测试、README 和验证文档，禁止覆盖、顺手提交或清理。若需隔离，执行阶段使用 using-git-worktrees 技能；不能只检出 HEAD 后丢掉所依赖的未提交图谱能力。选择复用现有工作区时只暂存本任务新增文件和确属本任务的 diff hunk。当前在 main，开始实现时创建 `codex/company-contact-data-reuse` 分支；若该分支已存在，先检查其状态再决定复用，禁止强制覆盖。所有远程红/绿验证使用该执行分支的实际提交 SHA。

本计划中的代码块锁定接口、关键实现和回归断言；实现必须补齐同一步明确列出的行为，不得将示例当作跳过其他验收项的许可。

| 文件 | 职责 |
| --- | --- |
| `src/companies/company-context-types.ts`（新） | 内部关联、分页、摘要和引用类型；不导入 MCP 或模型 SDK |
| `src/companies/company-link.ts`（新） | 信用代码和名称判断、身份摘要、关联判定及写前检查 |
| `src/db/company-link-repository.ts`（新） | 显式关联、版本 CAS、审计回执；SQLite 事务 |
| `src/companies/company-context-service.ts`（新） | 共享读取入口，批量汇总、分页、故障隔离 |
| `src/companies/company-evidence.ts`（新） | 既有证据适配、请求内去重、引用校验与预算 |
| `src/contracts/company-context.ts`（新） | 对外扩展字段的 Zod Schema；不改变旧字段意义 |
| `src/mcp/company-link-tools.ts`（新） | link_company 的鉴权入口 |
| `rust/contact-graph/src/company_context.rs`（新） | 精确组织索引、批量身份读、有限职业关系查询 |
| 现有仓储、问答、MCP 注册和 `web/contact-search-graph.ts` | 接入上述能力，避免整文件重构 |

所有新 TypeScript 测试采用导入真实模块、内存 SQLite 或明确的 graph mock；不 spawn Rust、不 import `src/index.ts` 启动应用、不触发 bundle。现有测试在纳入本地命令前检查是否隐式启动 native；不确定的测试全部放远程 CI。用 `node node_modules/vitest/vitest.mjs run <明确文件列表>`，禁止本地无文件参数跑全套。

每个任务先添加行为测试，再运行得到预期失败，实施后运行同一范围及 `npm run typecheck`。Rust 和浏览器 bundle 任务的红/绿验证均在远程完成，不为省时在本机编译。每次提交只包含本任务文件/变更；提交消息见任务末尾，提交前 `git diff --cached --check`。

## Task 1: 关联记录与最小公共类型

**Files:**
- Create: `src/companies/company-context-types.ts`, `src/db/company-link-repository.ts`, `tests/company-link-repository.test.ts`
- Modify: `src/db/schema.ts`, `src/db/database.ts`（仅迁移确有需要的部分）

**Interfaces:** Consumes `DatabaseSync`、现有 `initializeDatabase`。Produces 以下类型和仓储方法，后续任务统一使用蛇形字段。

```ts
export type LinkState = 'unlinked' | 'candidate' | 'confirmed' | 'conflict' | 'revoked';
export type ReadState = 'ok' | 'partial' | 'unavailable' | 'not_applicable';
export interface ReadMeta { state: ReadState; warnings: string[] }
export interface Count { count: number | null; loaded_count: number; complete: boolean }
export interface Page<T> { items: T[]; total: number | null; next_offset: number | null; complete: boolean }
export interface CompanyLink {
  organization_id: string; credit_code: string | null;
  state: 'confirmed' | 'revoked'; version: number;
  identity_hash: string; organization_version: number;
  note: string; actor: string; updated_at: string;
}
export interface LinkWrite {
  action: 'confirm' | 'unlink'; organization_id: string; credit_code?: string;
  operation_id: string; expected_link_version: number;
  expected_organization_version: number; note: string;
}
export interface LinkResolution {
  state: LinkState; organization_id: string; credit_code: string | null;
  basis: 'manual' | 'identifier_match' | null; version: number;
  candidates: Array<{ credit_code: string; legal_name: string }>;
  warnings: string[];
}
// CompanyLinkRepository(db: DatabaseSync)
// get(id: string): CompanyLink | null
// getMany(ids: string[]): Map<string, CompanyLink>
// byCreditCode(code: string): CompanyLink[]
// replay(input: LinkWrite, actor: string): CompanyLink | null
// write(input: LinkWrite, actor: string, identityHash: string, now: string): CompanyLink
```

- [ ] **1. 添加 CAS 和撤销重放失败测试。** 使用下列独立测试；再覆盖同 operation_id 换参数、换 actor、替换目标、事务失败不留下半条回执。

```ts
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { CompanyLinkRepository } from '../src/db/company-link-repository.js';
it('replays unlink before checking the now-stale expected version', () => {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  try {
    const repo = new CompanyLinkRepository(db);
    const input = { action: 'unlink' as const, organization_id: 'o1', operation_id: 'unlink-1',
      expected_link_version: 0, expected_organization_version: 1, note: '解除自动匹配' };
    const first = repo.write(input, 'sales-a', 'hash1', '2026-10-12T00:00:00Z');
    expect(first).toMatchObject({ state: 'revoked', version: 1 });
    expect(repo.write(input, 'sales-a', 'hash1', '2026-10-12T00:01:00Z')).toEqual(first);
    expect(() => repo.write({ ...input, operation_id: 'unlink-2' }, 'sales-a', 'hash1',
      '2026-10-12T00:02:00Z')).toThrow('LINK_VERSION_CONFLICT');
  } finally { db.close(); }
});
```

- [ ] **2. 运行红测试。** `node node_modules/vitest/vitest.mjs run tests/company-link-repository.test.ts`；初始应因仓储未实现失败。
- [ ] **3. 添加幂等初始化 DDL。** 不修改现有表；用 `(actor,operation_id)` 标识调用者操作，request_json 保存规范化输入并比较，result_json 保存回执及 before_json 供审计。信用代码不做唯一约束，因为多个组织可连同一家企业。

```sql
CREATE TABLE IF NOT EXISTS company_links (
  organization_id TEXT PRIMARY KEY, credit_code TEXT,
  state TEXT NOT NULL CHECK(state IN ('confirmed','revoked')),
  version INTEGER NOT NULL CHECK(version > 0), identity_hash TEXT NOT NULL,
  organization_version INTEGER NOT NULL, note TEXT NOT NULL,
  actor TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS company_links_credit_code ON company_links(credit_code);
CREATE TABLE IF NOT EXISTS company_link_operations (
  actor TEXT NOT NULL, operation_id TEXT NOT NULL, request_json TEXT NOT NULL,
  before_json TEXT, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(actor, operation_id)
);
```

- [ ] **4. 实现事务顺序。** `write` 先查重放，再 BEGIN IMMEDIATE、事务内再查重放、读取旧版本、CAS、写新记录和操作回执、COMMIT；任一步失败 ROLLBACK。输入 JSON 使用固定字段顺序序列化，不混入 now 或 identityHash，保证重试不会因数据随后变化而变成新请求。操作参数不同抛 `OPERATION_CONFLICT`，actor 为空拒绝。`replay` 不存在回执才返回 null。
- [ ] **5. 运行绿测试、类型检查并提交。** `node node_modules/vitest/vitest.mjs run tests/company-link-repository.test.ts`；`npm run typecheck`。Expected: 重放保持同一版本且数据库重新 initialize 不丢记录。Commit: `feat(companies): persist versioned organization links`。

## Task 2: 有界、精确的图谱读取

**Files:**
- Create: `rust/contact-graph/src/company_context.rs`, `rust/contact-graph/tests/company_context.rs`
- Modify: `rust/contact-graph/src/lib.rs`, `rust/contact-graph/src/protocol.rs`, `rust/contact-graph/src/store.rs`, `rust/contact-graph/src/import_commit.rs`, `rust/contact-graph/src/claims.rs`, `rust/contact-graph/src/snapshot_sync.rs`, `rust/contact-graph/src/lifecycle.rs`, `src/contacts/graph-client.ts`
- Modify: `src/companies/company-context-types.ts`（OrganizationIdentity、RecentRecord）
- Test: `tests/contact-graph-client.test.ts`（native 行为只在 CI）

**Interfaces:** Consumes 现有 Store 和图谱 JSON 协议。Produces 三个内部只读 op（不是新 MCP 工具），沿用 256 KiB 响应上限。

```ts
export interface OrganizationIdentity {
  entity_id: string; version: number; name: string | null; legal_name: string | null;
  identifiers: Array<{ '@type': 'PropertyValue'; propertyID: string; value: string }>;
  archived: boolean; identity_complete: boolean;
  evidence: import('../contracts/index.js').ContactEvidence[];
  conflicts: import('../contracts/index.js').ContactEvidence[];
}
// company_organizations:
// { entity_ids: string[], credit_codes: string[], normalized_names: string[], offset: number, limit: number }
// => Page<OrganizationIdentity>; OR 匹配三组过滤器，空过滤器拒绝，limit 1..50。
// company_relations:
// { organization_ids: string[], offset: number, limit: number }
// => Page<ContactRelation>; 正式职业边，limit 1..50，按 relation_id 稳定排序。
// company_recent_records:
// { organization_ids: string[], since: string, limit: number }
// => Page<RecentRecord>; 只读取相关实体/职业关系的 metadata.updated_at、证据 collected_at。
export interface RecentRecord {
  kind: 'entity' | 'relation' | 'evidence' | 'profile' | 'assessment'; id: string; entity_id?: string;
  recorded_at: string; label: string; // label 只含职业范围内的安全描述
}
```

- [ ] **1. 新建 Rust 协议测试。** 使用独立临时库，先验证空过滤器被拒绝、明确 ID 查询无数据时正确为空；再用现有 save_contact/save_relation 协议创建合成节点，覆盖同名 Person 不被当组织、归档、项目客户方向、无家庭边、稳定分页。

```rust
use contact_graph::{protocol::parse_and_dispatch, store::Store};
use serde_json::json;
#[test]
fn empty_filter_cannot_scan_the_library() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let response = parse_and_dispatch(&serde_json::to_vec(&json!({
        "version":1,"request_id":"company-1","op":"company_organizations",
        "payload":{"entity_ids":[],"credit_codes":[],"normalized_names":[],"offset":0,"limit":50}
    })).unwrap(), &store);
    assert_eq!(response["error"]["code"], "VALIDATION_ERROR");
}
```

- [ ] **2. 远程运行红测试。** 在执行分支推送该测试，通过现有 workflow 的 Rust 阶段运行；新增 op 前应为未知 op，而不是期望的 VALIDATION_ERROR。禁止本地 cargo test。
- [ ] **3. 实现精确组织检索索引。** 图谱内添加一个派生键表，索引 name/legalName 的规范化值及信用代码；它只用于检索，不保存企业报告或聚合结果。规范化与 normalizeQccLegalName 一致：NFKC、去空白、ASCII 小写。Rust 已依赖 unicode-normalization，无需新库。信用代码 propertyID 仅接受 `统一社会信用代码`、`credit_code`、`uscc` 的规范化形式，不能将任意 identifier 当信用代码。

```sql
CREATE TABLE IF NOT EXISTS company_organization_keys (
  entity_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('name','credit_code')),
  value TEXT NOT NULL, PRIMARY KEY(entity_id,kind,value)
);
CREATE INDEX IF NOT EXISTS company_organization_key_lookup
  ON company_organization_keys(kind,value,entity_id);
```

```rust
// company_context.rs 对外签名；内部使用现有 graph.connection()。
pub fn organizations(store: &Store, raw: &serde_json::Value)
    -> Result<serde_json::Value, crate::store::AppError>;
pub fn relations(store: &Store, raw: &serde_json::Value)
    -> Result<serde_json::Value, crate::store::AppError>;
pub fn recent_records(store: &Store, raw: &serde_json::Value)
    -> Result<serde_json::Value, crate::store::AppError>;
pub(crate) fn refresh_keys(store: &Store, entity_id: &str)
    -> Result<(), crate::store::AppError>;
```

将 refresh_keys 放在保存组织、导入创建/合并组织、确认组织字段 claim、快照同步、归档/恢复的现有事务内；所有实体写路径逐一核对。首次迁移在一个事务中回填已有组织并记录迁移版本，失败不留下“已迁移”标记。后续启动不重扫全库。查询索引后仍校验实体类型及 archived/merged_into；键表不能替代当前状态。组织 identity 响应只附名称/identifier 相关证据及其冲突，不含电话、邮件或全份档案。身份证据因响应预算不完整时 identity_complete=false；resolver 必须拒绝自动确认，也不能用缺失证据证明显式关联仍然有效。

- [ ] **4. 实现职业边与近期记录 SQL。** organization_ids 每批最多 50；company_relations 取直接职业边、项目 clientOrganization 边及这些项目的 memberOf 边，排除“员工参加项目即企业项目”的路径。只允许 worksFor、alumniOf、affiliation、memberOf、clientOrganization，排除归档边及归档端点。先 DISTINCT relation_id 再分页，取 limit+1 确定下一页。company_recent_records 按时间倒序、kind/id 打破同时间并列，过滤 since 之后、安全字段和可达职业路径，最多 20 条；不含 claim 或 import job。
- [ ] **5. 接入协议和 TS allowlist。** 这三个 op 都为只读，不能进入 graph-client 的写重试集合。响应过大时减小页直到至少返回一项并推进游标；单项仍过大返回 RESPONSE_TOO_LARGE。上层将其表示为不可用而非空记录。
- [ ] **6. 远程绿测并提交。** CI: `cargo test --locked --manifest-path rust/contact-graph/Cargo.toml --test company_context` 及既有完整 Rust 阶段。新增查询计划断言使用键索引；测试所有写路径更改名称/代码后旧键消失、新键可查。Commit: `feat(graph): add bounded company context reads`。

## Task 3: 主体判定、写入检查与企业仓储查询

**Files:**
- Create: `src/companies/company-link.ts`, `tests/company-link.test.ts`, `tests/company-context-repositories.test.ts`, `tests/fixtures/company-context.ts`（本任务先定义本文末尾的组织/画像常量；Task 4 再加入 createContextFixture，避免提前依赖未来 service）
- Modify: `src/db/profile-repository.ts`, `src/db/assessment-repository.ts`

**Interfaces:** Consumes Task 1/2 类型和仓储、StoredCompanyProfile、GraphClient。Produces `identityHash`, `validCreditCode`, `resolveCompanyLink` 以及 `CompanyLinkService.change`。

```ts
// identityHash(org: OrganizationIdentity): string
// validCreditCode(code: string): boolean
// resolveCompanyLink(org: OrganizationIdentity, saved: CompanyLink | null,
//                    profiles: StoredCompanyProfile[]): LinkResolution
// CompanyLinkService({ graph: GraphClient, links: CompanyLinkRepository,
//                      profiles: ProfileRepository, now: () => Date })
// change(input: LinkWrite, actor: string): Promise<CompanyLink>
// ProfileRepository additions:
// findByCreditCodes(codes: string[]): StoredCompanyProfile[]  // 含过期记录，只供展示
// findByNormalizedNames(names: string[]): StoredCompanyProfile[]
// AssessmentRepository additions:
// summariesByCreditCodes(codes: string[]): Map<string, ReportSummary>
// listCompleted(code: string, offset: number, limit: number): Page<ReportItem>
export interface ReportItem {
  assessment_id: string; generated_at: string; collected_at: string;
  overall_opportunity: string; recommended_product: string | null;
}
export interface ReportSummary { count: number; latest: ReportItem | null }
```

- [ ] **1. 添加校验和身份摘要测试。** 以下前缀仅用作离线合成测试样例，不调用外部接口；测试计算出的校验位，不依赖现有测试代码恰好通过校验。

```ts
import { expect, it } from 'vitest';
import { identityHash, validCreditCode } from '../src/companies/company-link.js';
it('checks the checksum and ignores non-identity fields', () => {
  const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const weights = [1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28];
  const prefix = '91310000123456789';
  const code = prefix + alphabet[(31 - [...prefix].reduce((s,c,i) => s + alphabet.indexOf(c)*weights[i], 0)%31)%31];
  expect(validCreditCode(code)).toBe(true);
  expect(validCreditCode(code.slice(0,17) + (code[17] === '0' ? '1' : '0'))).toBe(false);
  const org = { entity_id:'o1', version:1, name:'甲公司', legal_name:null,
    identifiers:[], archived:false, identity_complete:true, evidence:[], conflicts:[] };
  expect(identityHash(org)).toBe(identityHash({ ...org, version:2 }));
  expect(identityHash(org)).not.toBe(identityHash({ ...org, name:'乙公司' }));
});
```

再添加 resolveCompanyLink 表驱动用例：仅名称 candidate；代码有证据且法定名/曾用名一致 confirmed；aliases/brands 单独相同不能确认；无来源代码不确认；不同有效代码 conflict；revoked 压制自动匹配；显式确认后 identity_hash 变化 conflict。名称/代码 evidence 必须对应当前值且不是 conflicts 中的证据，分页未读全不能假装无冲突。

- [ ] **2. 本地红测试。** `node node_modules/vitest/vitest.mjs run tests/company-link.test.ts tests/company-context-repositories.test.ts`。
- [ ] **3. 实现身份摘要与代码校验。** Hash 只使用规范化 name/legalName 和按 propertyID/value 排序去重的 identifier；不包含版本、证据时间或联系方式。

```ts
const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const weights = [1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28];
export function validCreditCode(code: string): boolean {
  if (code.length !== 18 || [...code].some(c => !alphabet.includes(c))) return false;
  const sum = [...code.slice(0,17)].reduce((n,c,i) => n + alphabet.indexOf(c)*weights[i], 0);
  return code[17] === alphabet[(31 - sum % 31) % 31];
}
```

自动判定只读已有画像；显式撤销优先。被归档组织不给跨库资料。保存的 identity_hash 不匹配时返回 conflict。人工确认名称候选允许审核说明，但有效代码冲突时拒绝；目标画像不存在拒绝。

- [ ] **4. 实现 change 写入流程。** 先校验 actor 和输入格式，再 links.replay，命中直接返回持久化回执；未命中才读当前组织并检查 expected_organization_version、目标画像和代码，最后 links.write。以 SQLite 事务提交作为操作完成点：提交后只返回保存的 CompanyLink，不再因随后图谱变化改成操作失败。回执 state 表示该版本曾保存的状态，不承诺现在仍有效；工具说明明确要求用 get_contact(include_company_context=true) 读取当前关联状态。并发身份变化由后续 resolver 的 identity_hash 校验返回 conflict，禁止继续汇总错误主体。首次和重试均返回完全相同的操作回执，不附会变化的当前状态、不新增 replayed 字段、不在重试路径再读图谱。写前版本错误和事务未提交错误仍正常失败。

此步骤的 service 测试必须在真实 links.write 提交后、change 返回前改变 mock 图谱身份；断言首次及重复调用深度相等、只写入一条操作记录、重试未读图谱，并由 resolveCompanyLink 检查当前身份已为 conflict。具体可执行用例见本文末尾“修正项回归代码 A”。
- [ ] **5. 实现批量仓储方法。** 使用绑定参数或 json_each 输入，空数组返回空集合；不字符串拼接用户代码。画像旧的 fresh 方法不改语义。报告查询只取 completed，按 completed_at DESC, assessment_id DESC 排序，汇总 SQL 不选择 report_markdown/evidence_snapshot_json。增加 assessments(credit_code,status,completed_at,assessment_id) 索引。测试同一企业两个报告、失败记录不计数、两个企业不串、无记录 count=0、过期画像可展示而 fresh 查询仍为空。
- [ ] **6. 绿测与提交。** 运行本任务两个测试和 Task 1 测试、`npm run typecheck`。Commit: `feat(companies): resolve and validate organization identities`。

## Task 4: 共享摘要、详情、反向查询和后续资料

**Files:**
- Create: `src/companies/company-context-service.ts`, `tests/company-context-service.test.ts`
- Modify: `src/companies/company-context-types.ts`

**Interfaces:** Consumes Tasks 1–3。构造依赖 `{graph?: GraphClient, links, profiles, assessments, now, profileTtlDays}`，仓储类型使用上面真实类的 Pick；不注入通用数据适配器注册表。Produces 以下方法：

```ts
export interface CompanySummary extends ReadMeta {
  link: LinkResolution; has_profile: boolean | null;
  report_count: number | null; latest_report_at: string | null;
}
export interface CompanyDetail extends CompanySummary {
  profile: import('../db/profile-repository.js').StoredCompanyProfile | null;
  latest_report: ReportItem | null; reports: Page<ReportItem>;
}
export interface CompanyOverview extends ReadMeta {
  organization_ids: string[]; organizations_complete: boolean;
  people: Count; projects: Count; reports: ReportSummary | null;
}
export interface RelatedUpdates extends ReadMeta {
  since: string; scope: string[]; items: RecentRecord[]; truncated: boolean;
}
// CompanyContextService methods:
// summaries(ids: string[], signal?:AbortSignal): Promise<Map<string,CompanySummary>>
// detail(id: string, offset: number, limit: number, signal?:AbortSignal): Promise<CompanyDetail>
// overview(code: string, signal?:AbortSignal): Promise<CompanyOverview>
// relatedUpdates(code: string, since: string, signal?:AbortSignal): Promise<RelatedUpdates>
```

- [ ] **1. 写行为测试。** 内存 SQLite 使用 Tasks 1/3 仓储，GraphClient 用 vi.fn 按 op 返回 Task 2 协议；不得只 mock 本任务 service。至少固定以下断言：

完整 fixture 与候选只读测试见文末“共享测试 fixture”，取消分页测试见回归 D；直接采用其中实际构造 service/db 并调用接口的用例。

测试文件的 setup 直接以 `initializeDatabase(new DatabaseSync(':memory:'))` 创建仓储，用 profiles.upsert 插入合法 fixture；组织 fixture 使用 Task 2 OrganizationIdentity 形状。每个用例 finally 关闭 db。另测已撤销节点不出现在 overview、纯自动节点可反向找到、两组织同一人物只计一人、图谱失败时报告仍可用。

- [ ] **2. 本地运行红测试。** `node node_modules/vitest/vitest.mjs run tests/company-context-service.test.ts`。
- [ ] **3. 实现 summaries/detail。** summaries 将最多 50 个组织 ID 发一次或字节上限内少量批量请求，收集 code/name 后批量读取画像、关联、报告。图谱缩页时追踪剩余 ID，最多 20 页；超限返回部分状态。候选/冲突/撤销返回 null 报告字段，避免泄漏错误归属。detail 对 confirmed 才读报告目录，limit 1..50，offset 非负；空数据不是失败。
- [ ] **4. 实现 overview。** 合并 links.byCreditCode 返回的 ID 与 company_organizations 按 code、legalName、formerNames 返回的候选，对每个候选再次调用同一 resolver，过滤 revoked/conflict。分页读取 company_relations，最多 20 页；使用 Set 计算端点 ID，排除归档、家庭、未知组织归属。任何分页未完成，Count.count=null、complete=false，loaded_count 为已见节点数。组织候选截断同样使关联计数不完整。

```ts
const count = (ids: Set<string>, complete: boolean): Count => ({
  count: complete ? ids.size : null, loaded_count: ids.size, complete,
});
// 图谱关闭：{state:'not_applicable', people:count(new Set(),false), ...}
// 图谱请求失败：state='partial'（画像/报告可用）或 'unavailable'（全不可用）。
```

- [ ] **5. 实现 relatedUpdates。** 在已确认组织集合上调用 company_recent_records，补入本公司画像 collectedAt 和其他报告 completedAt > since 的摘要；不能仅返回关系的当前页。每源对外最多取 20 条，以 complete/next_offset 判断是否截断，合并按 recorded_at、kind、id 稳定倒序、取前 20；明确 scope 包含哪些成功来源。RecentRecord 的 profile/assessment 项无需 entity_id，图谱项必须有 entity_id。缺少时间项不纳入。源错误产生 warning；本接口不声称事件发生时间或完整变更历史。

上述四个方法将同一 signal 传给每次 graph.request 的第三参数；循环开始和每次 await 后执行 signal?.throwIfAborted()。取消与超时必须向调用者传播，不能被普通源故障 catch 转成空数据后继续翻页。未提供 signal 的直接调用在方法入口创建 AbortSignal.timeout(30_000)，内层复用它，不为每一页重置期限。Node SQLite 同步查询前后检查 signal；不宣称可以打断已经执行的同步 SQL。取消回归见“修正项回归代码 D”。
- [ ] **6. 绿测与提交。** `node node_modules/vitest/vitest.mjs run tests/company-context-service.test.ts tests/company-context-repositories.test.ts`；`npm run typecheck`。Commit: `feat(companies): aggregate existing company context`。

## Task 5: MCP 读入口、link_company 和应用装配

**Files:**
- Create: `src/contracts/company-context.ts`, `src/mcp/company-link-tools.ts`, `tests/company-context-tools.test.ts`
- Modify: `src/contracts/index.ts`, `src/mcp/tool-schemas.ts`, `src/mcp/tools.ts`, `src/mcp/contact-tools.ts`, `src/mcp/contact-search-tools.ts`, `src/index.ts`, `src/orchestration/assessment-service.ts`
- Test: `tests/contact-library-tools.test.ts`, `tests/contact-search-tools.test.ts`, `tests/mcp-tools.test.ts`

**Interfaces:** Consumes CompanyContextService/CompanyLinkService。Produces 对外 company_context、generated_at、related_updates 字段，Task 4 类型对应同名 Zod Schema，JSON 内使用蛇形字段。StoredCompanyProfile 在对外 profile 中转换成 `{legal_name, credit_code, basic_profile, collected_at, stale}`，不直接外露仓储内部字段。

- [ ] **1. 写 MCP 合约测试。** 沿用现有测试中的内存 transport/client/server 建立方式，以 mock 基础服务和真实 Schema 验证：旧参数仍成功；include_company_context=false 不读附加资料；link_company 缺 auth 拒绝；相同 ID 重放；搜索部分失败仍保留 items/total；报告生成时间正确且历史正文不变。

完整 MCP transport 测试见文末回归 B，包含报告接线和 get_contact 参数隔离。新增纯 service 注入，不 import 会启动 native 的 index.ts。添加断言 generated_at 对 pending/failed 不要求存在。

`registerContactTools(server,library,companyContext?:Pick<CompanyContextService,'detail'>)` 增加可选第三参数；原调用无需改动。拆分 include_company_context/report_offset/report_limit 后，library.get 只接收原图谱分页参数，detail 接收独立报告分页参数。

- [ ] **2. 运行红测试。** 本地仅 `tests/company-context-tools.test.ts` 与已确认不启动 native 的工具测试；完整 mcp-tools 在 CI。
- [ ] **3. 注册 link_company。** action=confirm/unlink，expected_organization_version >=1、expected_link_version >=0、note 非空最多 500 字符；confirm 必须有合法 credit_code。actor 使用现有 context.http.authInfo.clientId，鉴权规则参照 contact-tools.ts，不从参数取 actor。

```ts
server.registerTool('link_company', {
  description:'确认或解除组织与已有企业画像的关联；需要版本、审核说明和稳定操作 ID。',
  inputSchema: LinkCompanyInputSchema,
}, async (input, context) => {
  const actor = context.http?.authInfo?.clientId;
  if (!actor) throw new Error('Authenticated client is required');
  const result = await links.change(input, actor);
  return { content:[{type:'text' as const,text:JSON.stringify(result)}], structuredContent:{...result} };
});
```

LinkCompanyInputSchema 在本任务 `src/contracts/company-context.ts` 定义并导出，逐字段对应 LinkWrite；result 是 CompanyLink，不包含操作回执表的历史 before_json。

- [ ] **4. 接入三个读取入口。** contact-search-tools 的 App 和非 App 分支共享一个 handler：先 search.search，再按 Organization label 批量 summaries，映射到原 items；保持 mode/warnings/reasons/排序。get_contact 将新参数拆出，默认不调用 detail。get_company_profile 仅唯一主体且成功提供 basic_profile 时取 overview；多候选保留原响应，不合并信息。仓储或图谱失败转成附加区 unavailable，不能捕获并吞掉基础工具原错误。
- [ ] **5. 报告入口独立扩展参数并接线。** 新建 AssessmentReportInputSchema 包含 assessment_id、include_related_updates=false；get_assessment_status 继续使用旧 AssessmentIdInputSchema。AssessmentService.report 从 record.completedAt 提供 generatedAt，tools.ts 输出转换为 generated_at，保持 presentStoredReport 和数据库正文不变。

在同一个 AssessmentService 增加异步方法 `reportWithUpdates(input:{assessmentId:string;includeRelatedUpdates?:boolean}, context?:Pick<CompanyContextService,'relatedUpdates'>, signal?:AbortSignal)`：先 required 读实际记录，再使用 report 得到原展示；只有 status=completed 且 includeRelatedUpdates=true 才调用 context.relatedUpdates(record.creditCode,record.completedAt,signal)。信用代码和时间一律取记录，不接受调用者提供。返回原展示结果加独立的 relatedUpdates 字段；工具映射为 related_updates 并通过输出 Schema。false、processing、failed 不调用附加查询且不返回该字段。图谱能力未启用时 true 返回 not_applicable；context 普通异常时保留报告并返回 unavailable、items=[]、scope=[]、since=completedAt、truncated=false、warnings=['RELATED_UPDATES_UNAVAILABLE']。signal 已取消则传播取消，不伪装成普通源故障。

`McpServices.getAssessmentReport` 的输入类型增加 includeRelatedUpdates 可选字段，index.ts 回调接到 assessmentService.reportWithUpdates(input, companyContext, abortController.signal)；tools.ts 将 include_related_updates 显式映射为 includeRelatedUpdates。其余报告内部调用仍可用原同步 report。模型和 App 的 get_assessment_report 使用同一处理函数，保留既有鉴权，设置 `_meta.ui.visibility=['model','app']`。组织 App 只接受当前报告目录的 ID；服务端独立报告查询继续按原权限读取，不能把前端目录检查宣称为新的服务端权限边界。具体 service 及 MCP 回归见“修正项回归代码 B”。
- [ ] **6. 装配可选服务。** index.ts 在 graph 可用时创建 links 和 CompanyContextService，CompanyLinkService；向 MсpServices 和 contact tool 注册函数注入可选能力。图谱禁用时原六个基础工具继续可用，附加区明确 not_applicable；link_company 不注册。服务 options 类型不导致现有测试必须提供新依赖。
- [ ] **7. 绿测、类型检查与提交。** `node node_modules/vitest/vitest.mjs run tests/company-context-tools.test.ts tests/contact-search-tools.test.ts`；`npm run typecheck`。`contact-library-tools.test.ts` 会导入 createApplication，整体留在远程 gate。Commit: `feat(mcp): expose linked company context and link management`。

## Task 6: 问答材料与跨库引用

**Files:**
- Create: `src/companies/company-evidence.ts`, `tests/company-evidence.test.ts`, `tests/company-context-budget.test.ts`
- Modify: `src/companies/company-context-types.ts`, `src/companies/company-context-service.ts`, `src/contracts/company-context.ts`
- Create: `src/contacts/relation-evidence.ts`; Modify: `src/contacts/contact-answer.ts`（仅提取既有纯证据校验函数，行为不变）

**Interfaces:** Consumes 既有 ContactEvidence/ContactRelation 和评估 EvidenceSnapshot。Produces `ContextCitation`, `ContextMaterial`, `dedupeMaterials`, `validateContextRefs` 及 `CompanyContextService.materials`。

```ts
export interface ContextCitation {
  ref: string; source_type:'contact'|'profile'|'assessment'; subject_id:string;
  quote?:string; value?:unknown; evidence_id?:string; entity_id?:string;
  relation_id?:string; assessment_id?:string; source_url?:string;
  file_name?:string; page?:number; collected_at?:string; published_at?:string;
}
export interface ContextMaterial {
  citation:ContextCitation; statement:string; source_key:string;
  predicate:string; object:string; employment_status?:string;
}
export interface ContextMaterials extends ReadMeta {
  items:ContextMaterial[]; omitted_count:number; contacts_read:number;
}
export interface MaterialReadContext {
  readonly signal:AbortSignal;
  remaining_contacts:number; remaining_materials:number;
  readonly selected_report_id:string|null;
  report_reads:number;
  report:import('../db/assessment-repository.js').AssessmentRecord|null|undefined;
  contacts:Map<string,Record<string,unknown>|null>;
}
// dedupeMaterials(items: ContextMaterial[]): ContextMaterial[]
// validateContextRefs(refs: string[], included: ContextMaterial[]): ContextCitation[]
// createMaterialReadContext(signal:AbortSignal, selectedReportId:string|null): MaterialReadContext
// selectReportForQuestion(reports:ReportItem[], explicitId?:string): string|null
// readSelectedReport(context:MaterialReadContext, load:(id:string)=>AssessmentRecord|null): AssessmentRecord|null
// CompanyContextService.materials(code:string, question:string,
//   context:MaterialReadContext): Promise<ContextMaterials>
```

MaterialReadContext 在整个问答入口只创建一次：remaining_contacts=12、remaining_materials=20、report_reads=0、report=undefined、contacts=new Map()；所有公司共享该对象。由读取服务在发请求前扣减档案预算、接受材料时扣减材料预算，调用方不得二次扣减。原联系人问答已读取的档案复用同一 contacts Map 并计数。上下文不得缓存到 service 实例上跨请求复用。

报告先选后读：ask_company 有显式 assessment_id 时选该记录并核对主体，否则通过轻量 summariesByCreditCodes 选本公司的最新已完成记录。ask_contacts 先取得问题实际涉及的已确认企业集合，批量读报告摘要，在整个集合按 generated_at DESC、assessment_id DESC 选唯一一条；随后 selected_report_id 固定，不在遍历下一家公司时改选。其他公司的背景仅用画像和职业/项目证据；问题需要多个报告时注明本次报告读取范围。

`readSelectedReport` 是请求内唯一报告全文/快照读取入口：没有 selected_report_id 返回 null；已有 report（含 null）直接复用；首次读之前 signal.throwIfAborted() 并将 report_reads 置 1，成功或未找到都缓存，后续不再读。已经被 ask_company 主体校验读取的同一记录直接放进 context.report 并设置 report_reads=1；原报告复用逻辑不能再额外 assessments.get/findLatestCompletedWithSnapshot。载入记录必须 completed、ID 正确、属于预先选定的企业且当前 materials 的 code 一致，其他公司调用不得引用该快照。读取失败或旧报告不适合当前问题时不改选第二个报告。回归测试见“修正项回归代码 C”。

取消传递：ask_company 将现有 combined signal 交给 createMaterialReadContext；ask_contacts.ask 增加可选第二参数 signal，在入口与 30 秒期限合并后创建 context；其 get/select/共享查询均复用此 signal。每次图谱请求通过 graph.request(op,payload,context.signal)，每页前后检查取消；正常源失败可 partial，取消直接结束请求。新近涉及公司背景的请求也不能先在原 get/select 无期限读取后才创建上下文。一个请求的 12 档案/20 材料/1 报告是总量上限，不能按公司重置。

- [ ] **1. 写去重/拒绝伪造引用测试。** 不用同一 source_key 把不同事实删掉；它只标识独立来源。合并键使用来源、主体、predicate、object、statement；同文件不同事实仍保留，同事实重复导入合并一条。

```ts
import { expect,it } from 'vitest';
import { dedupeMaterials,validateContextRefs } from '../src/companies/company-evidence.js';
it('deduplicates repeated imports but preserves different facts', () => {
  const make = (ref:string, statement:string) => ({
    citation:{ref,source_type:'contact' as const,subject_id:'p1',quote:statement},
    statement,source_key:'file:abc',predicate:'worksFor',object:'甲公司',
  });
  const items = dedupeMaterials([make('contact:e1','曾任甲公司工程师'),
    make('contact:e2','曾任甲公司工程师'),make('contact:e3','任职时间为2022年')]);
  expect(items).toHaveLength(2);
  expect(() => validateContextRefs(['contact:missing'],items)).toThrow('UNSUPPORTED_CONTEXT_REFERENCE');
});
```

- [ ] **2. 本地运行红测试。** `node node_modules/vitest/vitest.mjs run tests/company-evidence.test.ts tests/company-context-budget.test.ts`。
- [ ] **3. 实现适配和预算。** contact ref=`contact:<evidence_id>`，profile ref 包含代码、collectedAt、字段路径，assessment ref 包含 assessment_id 与原 evidenceId；使用 encodeURIComponent 编码组成部分，避免分隔符碰撞。source_key 优先 file_sha256/text_sha256，其次原 URL 或原来源 ID。URL 相同而 statement 不同的材料都保留，不把报告作为其底层证据之外的又一个独立来源。snapshot 仅采用合法主体匹配、已有事实支持的证据；不将报告推荐产品直接变成当前购买意向。
- [ ] **4. 实现 materials 读取与既有冲突过滤。** 使用 overview(code,context.signal) 得到确认组织；按问题含义选组织职业边和项目两跳，共享上述请求预算，不无上限递归。单档案证据/关系最多各 5 页，分页未完成标 partial；取消规则按上段执行。profile 只映射可展示字段；将 supportedRelationEvidence 提取到 src/contacts/relation-evidence.ts，保留原引文与主体检查。

补充 `conflicts` 到联系人内部 Detail，并保留图谱原记录中的冲突证据。新增纯函数 `filterConflictedEvidence(evidence:ContactEvidence[], conflicts:ContactEvidence[]):{usable:ContactEvidence[];blocked:ContactEvidence[]}`：按 subject_kind、subject_id、field_path 建立冲突键；冲突涉及 `$relation` 时整条关系不进入可支持事实，冲突涉及 role/日期等字段时不使用该字段相关证据形成结论。相反引文仍保留为歧义来源，不能选择其中一个升级成 supported；不同 relation_id 的独立历史任职段不因职位值不同就被合并为冲突。只消费已有结构与已定位的矛盾，不引入自动裁决或新的事实数据库。

先过滤冲突，再调用 supportedRelationEvidence，最后生成 ContextMaterial。blocked 非空时返回具体字段的“存在冲突，无法确认” warning；仅有冲突材料则 insufficient，仍有独立可支持材料时可以部分回答，但不把冲突字段放进 supported claim。ask_contacts 现有选取路径同样调用过滤器；模型输入不能用未过滤 evidence 绕过。已有报告快照中带冲突/不确定归属的事实继续按原分类降级，不升级成 supported。测试必须覆盖“同一任职关系职位冲突”“一条关系级冲突阻断该边”“其他独立关系仍可回答”“有明确不重叠日期的任职段不被误删”，可执行用例见“修正项回归代码 E”。

为未知任职生成的材料 statement 必须写“有任职记录，当前状态未知”；不得把 unknown 转为 current。每条项目客户结论分别携带 memberOf 与 clientOrganization 所需材料，缺少一跳只返回证据不足。仅使用 context 固定选中的报告，时效规则仍由现有问答服务判断，过期快照不能经 context 旁路重新加入。
- [ ] **5. 绿测与提交。** `node node_modules/vitest/vitest.mjs run tests/company-evidence.test.ts tests/company-context-budget.test.ts tests/contact-answer.test.ts`；`npm run typecheck`。Commit: `feat(companies): adapt bounded cross-source evidence`。

## Task 7: 两个问答入口组合已有资料

**Files:**
- Modify: `src/orchestration/company-question-service.ts`, `src/upstream/ark/company-answer.ts`, `src/contracts/company-question.ts`, `src/contacts/contact-answer.ts`, `src/mcp/contact-answer-tools.ts`, `src/mcp/tool-schemas.ts`, `src/mcp/tools.ts`, `src/index.ts`
- Test: `tests/company-question.test.ts`, `tests/contact-answer.test.ts`, `tests/contact-answer-tools.test.ts`
- Create: `tests/company-context-answers.test.ts`

**Interfaces:** Consumes Task 6 ContextMaterials/MaterialReadContext。CompanyQuestionOptions 增加可选 `companyContext:Pick<CompanyContextService,'materials'>`，报告选择仍使用现有 assessments；ContactAnswerOptions 增加可选 companyContext（overview、materials）和报告摘要读取依赖，用于先选唯一报告。CompanyAnswerInput 增加 `context?:ContextMaterial[]`；输出增加可选 `context_citations:ContextCitation[]` 和 `context_warnings:string[]`。模型 claim 增加 `contextRefs?:string[]`，保留 evidenceIds；旧 sources/citations/facts 的形状不改变。

- [ ] **1. 写真实服务的组合问答测试。** 复用 company-question.test.ts 中的内存仓储及 fake answer 回调；graph mock 提供真实 contact detail，禁止仅断言 mock 被调用。测试仅有联系人材料也能回答相应问题；公司背景不足不影响已确认人物关系；姓名/就读问题不调用公司背景；伪造 contextRefs 被过滤；仍保留原采购推断限制。

先在 `tests/company-question.test.ts` 的现有 setup options 中增加 `companyContext?:CompanyQuestionOptions['companyContext']`，构造 CompanyQuestionService 时透传该属性；从 service 文件导入 CompanyQuestionOptions 类型。fake answer 的返回类型增加 `includedContextRefs?:string[]`。以下测试放入该文件已有 describe 内，直接复用其完整内存数据库 setup：

```ts
it('answers a contact question from actual supplied context without fresh research', async () => {
  const materials = vi.fn(async () => ({state:'ok' as const,warnings:[],omitted_count:0,
    contacts_read:1,items:[{
      citation:{ref:'contact:e-work',source_type:'contact' as const,subject_id:'p1',
        entity_id:'p1',relation_id:'r1',evidence_id:'e-work',quote:'张某曾在测试装备有限公司任工程师'},
      statement:'张某有测试装备有限公司工程师任职记录，当前状态未知。',
      source_key:'file:synthetic',predicate:'worksFor',object:'测试装备有限公司',employment_status:'unknown',
    }]}));
  const runtime = setup({companyContext:{materials}});
  runtime.answer.mockResolvedValueOnce({claims:[{category:'supported',
    text:'库内张某有测试装备有限公司工程师任职记录，当前状态未知。',
    evidenceIds:[],contextRefs:['contact:e-work']}],includedEvidenceIds:[],
    includedContextRefs:['contact:e-work']});
  const result = await runtime.service.ask({...runtime.input,question:'这家公司库内有哪些联系人？'});
  expect(materials).toHaveBeenCalledTimes(1);
  expect(result.status).toBe('answered');
  expect(result.markdown).toContain('当前状态未知');
  expect(result.context_citations?.map(c => c.ref)).toEqual(['contact:e-work']);
  expect(result.sources).toEqual([]);
  expect(runtime.search).not.toHaveBeenCalled();
  expect(runtime.qccCall).not.toHaveBeenCalled();
});
```

- [ ] **2. 本地红测试。** `node node_modules/vitest/vitest.mjs run tests/company-context-answers.test.ts tests/company-question.test.ts tests/contact-answer.test.ts tests/contact-answer-tools.test.ts`。
- [ ] **3. 扩展公司模型输入/输出预算。** body() 将 context 与现有 items/facts 一起计入字节预算；输出 includedContextRefs 只列真正进入模型的资料。模型 prompt 将公司背景、人物关系、项目客户分别描述；不得从职位推出采购权。至少存在 web evidence 或 context 才可请求模型；只有 context 时不能沿用旧的 selected.length===0 直接失败分支。

```ts
// CompanyAnswerClaimSchema 增加可选字段，不改变旧字段要求。
contextRefs: z.array(z.string()).max(20).optional()
// CompanyAnswerOutput 增加：includedContextRefs: string[]
// 渲染前严格验证实际纳入输入的引用；声明有依据却两个集合都为空则丢弃 supported claim。
const refs = claim.contextRefs ?? [];
const citations = validateContextRefs(refs, includedContext);
const hasSupport = claim.evidenceIds.length > 0 || citations.length > 0;
```

`includedContext` 必须由模型客户端返回的实际入参集合筛选；不得用所有检索结果进行宽松验证。现有购买意向、主体归属和主题缺失检查继续执行；contact/profile 材料不能作为采购意向的直接支持。

- [ ] **4. 调整 company-question execute。** 原主体画像及显式报告校验仍最先执行，但通过 Task 6 请求上下文选取/读取唯一报告，复用同一记录。将 execute 的 combined signal 传给 createMaterialReadContext，调用 `companyContext.materials(input.creditCode,input.question,readContext)`。纯联系人/项目查询有充分库内材料时不为缺少网页触发无关补查；要求最新公开动态或库内资料不足时保留原最多 1 次 QCC、2 次搜索、1 次模型预算。无 web confirmed 但有有效 context 时不能在原 early return 结束。复用 snapshot 证据与 context 内同 report ref 去重，选取同一份事实一次。普通源失败只加 warning；取消必须传播到原 ask 的失败/取消处理，不能继续补查。
- [ ] **5. 调整联系人问答。** 仅对企业背景相关问题执行 overview/materials；先完成已有个人关系解析，不能用背景绕过关系证据。确定性关系回答可附独立的企业背景段，复合模型回答增加 contextRefs 严格校验。保留原 facts/citations 的对应关系；若原复合答案过滤了 citations，facts 同步按实际引用过滤以满足现有 Schema。仅名字、就读、毕业问题不查企业报告；多个雇主逐一标主体，不能只取第一个当现任。
- [ ] **6. 输出映射与绿测。** contracts/company-question.ts、mcp/tool-schemas.ts、contact-answer-tools.ts 及 tools.ts 中 result 映射都显式允许 context_citations/context_warnings。运行本任务测试及 `npm run typecheck`。Commit: `feat(answers): combine company and contact evidence with citations`。

## Task 8: 图谱组织详情与历史报告入口

**Files:**
- Modify: `web/contact-search-graph.ts`, `web/contact-search-graph-model.ts`, `web/contact-search-graph.html`
- Test: `tests/contact-search-graph-model.test.ts`, `tests/contact-search-graph-browser.test.ts`, `tests/contact-search-graph-app.test.ts`

**Interfaces:** Consumes Task 5 JSON；图谱后台自动展开只用原 get_contact，用户选择 Organization 才传 include_company_context=true；历史目录用 report_offset，报告内容用 get_assessment_report。

- [ ] **1. 写浏览器回归。** 在现有 open(reply) SDK 宿主 harness 中按参数返回 company_context；断言初次一跳加载没有 report 调用，选择组织后展示候选/confirmed 不同文案，翻报告页不改关系分页，打开报告保持图谱。增加慢响应切换节点、报告失败重试和恶意 HTML 字符串用例。模型测试验证新增字段不影响原图节点/边。

以下代码加入已有 browser 文件，复用其中已定义的 open、detail、result、completed 和根组织 fixture；无需新宿主框架。新增按钮可访问名称固定为“报告下一页”和“查看报告 <assessment_id>”，供真实用户及测试使用。

```ts
it('loads company detail on selection, pages history and opens the selected report', async () => {
  const reports = Array.from({length:11},(_,i) => ({
    assessment_id:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
    generated_at:'2026-10-12T00:00:00Z',collected_at:'2026-10-11T00:00:00Z',
    overall_opportunity:'中',recommended_product:null,
  }));
  const h = await open(call => {
    if (call.name === 'get_contact') {
      const base = detail(String(call.arguments.entity_id));
      if (!call.arguments.include_company_context) return result(base);
      const offset = Number(call.arguments.report_offset ?? 0);
      return result({...base,company_context:{state:'ok',warnings:[],
        link:{state:'confirmed',organization_id:'o1',credit_code:'synthetic',basis:'manual',
          version:1,candidates:[],warnings:[]},
        has_profile:true,report_count:11,latest_report_at:reports[0].generated_at,
        profile:{legal_name:'云杉智造',credit_code:'synthetic',basic_profile:{industry:'装备制造'},
          collected_at:'2026-10-11T00:00:00Z',stale:false},
        latest_report:reports[0],reports:{items:reports.slice(offset,offset+10),total:11,
          next_offset:offset===0?10:null,complete:true}}});
    }
    if (call.name === 'get_assessment_report') return result({
      assessment_id:call.arguments.assessment_id,status:'completed',legal_name:'云杉智造',
      markdown:'# 第十一份历史报告',generated_at:reports[10].generated_at,
      collected_at:reports[10].collected_at,overall_opportunity:'中',recommended_product:null,
      dynamic_signal_freshness:'current',source_status:{qcc:'completed',doubao_search:'completed',ark:'completed'},
    });
    throw new Error(`Unexpected tool ${call.name}`);
  });
  await completed(h.ui);
  expect(h.calls.some(c => c.name==='get_assessment_report')).toBe(false);
  expect(h.calls.filter(c => c.name==='get_contact')
    .every(c => c.arguments.include_company_context!==true)).toBe(true);
  await h.ui.locator('#node-list button').click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('装备制造');
  await h.ui.getByRole('button',{name:'报告下一页',exact:true}).click();
  await expect.poll(() => h.calls.some(c => c.name==='get_contact' && c.arguments.report_offset===10)).toBe(true);
  await h.ui.getByRole('button',{name:`查看报告 ${reports[10].assessment_id}`,exact:true}).click();
  await expect.poll(() => h.ui.locator('#detail').innerText()).toContain('第十一份历史报告');
  expect(h.calls.find(c => c.name==='get_assessment_report')?.arguments)
    .toMatchObject({assessment_id:reports[10].assessment_id});
  expect(await h.ui.locator('#node-list button').count()).toBe(1);
  expect(h.calls.filter(c => c.arguments.report_offset===10)
    .every(c => Number(c.arguments.relation_offset ?? 0)===0)).toBe(true);
});
```

- [ ] **2. 远程红测。** 此任务依赖真实 SDK bundle；由现有 workflow 构建后运行 browser/app 测试，本地不运行构建脚本。
- [ ] **3. 扩展选中详情请求。** DetailRequest 增加 reportOffset=0；get_contact 新参数只用于组织选择。关系/证据翻页保留 reportOffset；报告翻页不改变原 offsets。独立使用 detailVersion/requestVersion 丢弃过期响应，不能让旧报告覆盖新选中主体。取消/断连保持现有行为。

```ts
const args = { entity_id: operation.id,
  evidence_offset: operation.offsets.evidence, evidence_limit:10,
  relation_offset: operation.offsets.relations, relation_limit:20,
  claim_offset: operation.offsets.unverified_claims, claim_limit: input?.include_unverified ? 20 : 0,
  ...(isOrganization ? {include_company_context:true,report_offset:operation.reportOffset,report_limit:10} : {}),
};
```

isOrganization 从已加载 entity.label 或图模型节点类型判断；类型尚未加载时先取原详情，确认为 Organization 再读 company_context，不对所有人物默认增查。

- [ ] **4. 展示画像和报告。** 复用 textContent 渲染器，展示关联状态、stale/采集时间、既有机会等级/推荐产品和报告目录。candidate 仅列候选名字，report_count=null 显示未知，不显示 0。报告原 Markdown 首版放 `<pre>` 或现有安全渲染机制，不引入未净化 innerHTML。历史入口按钮调用已对 App 开放的 get_assessment_report，明确显示 generated_at；点击前从当前目录校验 assessment_id，迟到结果必须丢弃。
- [ ] **5. 远程绿测与提交。** 现有 browser/app/model 测试通过，确认输入脚本字符串按文本显示、无家庭资料或联系方式。Commit: `feat(graph-app): show linked company profiles and report history`。

## Task 9: 贯通验证和文档

**Files:**
- Create: `tests/company-context-integration.test.ts`, `docs/validation/2026-10-12-company-contact-data-reuse.md`
- Modify: `docs/PRD.md`, `docs/QUICKSTART.md`, `skills/salestools-contact-management/SKILL.md`

**Interfaces:** Consumes Tasks 1–8，使用现有 MCP 注册和真实内存仓储；native 集成只在远程。无新增产品接口。

- [ ] **1. 添加端到端合成场景。** 真实临时图谱创建一个企业、两个组织节点、一个人物、一个项目、两个已完成报告；第一组织有可核对代码自动匹配，第二组织经 link_company 人工匹配。依次读取六个入口，两个组织中的同一人物只计一次，原报告 markdown 存储值前后完全相同。不得使用真实简历或生产账号。

```ts
// 集成测试的断言，before/after 来自同一 SQLite 仓储；tools 为 MCP client。
expect(overview.people).toMatchObject({count:1,complete:true});
expect(overview.projects).toMatchObject({count:1,complete:true});
expect(overview.reports?.count).toBe(2);
expect(assessments.get(reportId)?.reportMarkdown).toBe(beforeReportMarkdown);
await tools.callTool({name:'link_company',arguments:unlinkInput});
expect((await context.summaries([organizationId])).get(organizationId)?.link.state).toBe('revoked');
expect((await context.overview(creditCode)).organization_ids).not.toContain(organizationId);
```

fixture 工具调用使用 authenticated transport 的真实 actor；unlinkInput 携带实际版本，不硬编码测试上一步版本。另覆盖坏代码、唯一同名候选、图谱关闭、截断、来源失败、未授权 link、重复操作、并发 identityHash 变化。另一公司报告 ID 场景分别验证：App 拒绝打开不在当前节点目录的 ID；企业问答拒绝主体不符的显式报告。独立 get_assessment_report 保持原报告读取权限，不凭 UUID 推断新的节点权限。
- [ ] **2. 远程红/绿验证。** 将此集成测试纳入现有全套 Vitest 自动发现；不能为运行测试而本地启动 native 构建。所有实现完成后在同一 tested SHA 上通过 workflow 两个 job；失败时修正对应任务并只重跑受影响检查后再跑远程完整 gate。
- [ ] **3. 更新实际使用说明。** 文档说明 link_company 参数示例、candidate 不可当 confirmed、自动关联是只读、解除抑制自动关联、旧画像可展示而问答仍受新鲜度约束、unknown 不是现任。更新工具数为启用相应服务时新增 1 个模型可见工具；不要硬改无条件总数。解释 get_contact 的独立报告分页、context_citations、related_updates 的记录时间范围。
- [ ] **4. 建立真实宿主验收记录。** 使用脱敏合成企业运行组织搜索→展开→点击组织→历史翻页→报告阅读→解除后重查，分别记录 Codex/ChatGPT 实际可用宿主版本、SHA、结果和证据路径。没有宿主环境写“未执行及原因”，不能填通过。Chromium 结果单列。未能完成真实宿主验收时功能不得标记整体验收通过。
- [ ] **5. 提交文档与贯通测试。** `git diff --check`，仅暂存相关变更。Commit: `test(companies): verify cross-entry data reuse and document limits`。

## Task 10: 最终检查与交付记录

**Files:** Modify `docs/validation/2026-10-12-company-contact-data-reuse.md`（只填实际结果）。

**Interfaces:** Consumes 实际 Git SHA、CI run URL 和真实宿主证据；Produces 可审核的验收记录，不产生新运行时代码。

- [ ] **1. 核对工作区差异。** `git status --short`、`git diff --check`，对照执行前基线，确认原有工作未混入本功能提交。
- [ ] **2. 执行最终非构建类型检查。** `npm run typecheck`；本地仅重跑新增纯 TypeScript 测试文件，禁止全套和 native。已有检查通过后无新变更不反复运行。
- [ ] **3. 提交执行分支并运行远程 gate。** 下面脚本读取实际分支；先检查仓库现有 push workflow 的触发范围，避免推动发布分支。不得调用发布 workflow。

```bash
task_branch=$(git branch --show-current)
case "$task_branch" in codex/*) ;; *) exit 1 ;; esac
task_sha=$(git rev-parse HEAD)
git push -u origin HEAD
gh workflow run contact-upload-validation.yml --ref "$task_branch"
gh run list --workflow contact-upload-validation.yml --branch "$task_branch" --limit 5 --json databaseId,headSha,status,conclusion,url
```

从返回中选择 headSha 等于 task_sha 的 run；若没有匹配结果，不把其他 SHA 的成功当成本次验证。Task 2/8 的远程红/绿阶段也使用这一实际分支与 SHA 流程。
- [ ] **4. 记录两个 job 与宿主验收。** 同一 tested SHA 上 native-and-browser、production-container 成功；记录不适用/失败及真实原因。未通过不提交“验收完成”的结论。
- [ ] **5. 提交最终验证文档。** Commit: `docs: record company context validation results`。报告功能范围、CI 链接、真实宿主覆盖与剩余限制；不自动部署生产。

## 规格覆盖与计划自审

| 规格要求 | 任务 |
| --- | --- |
| 最小主体关联、状态、撤销抑制、幂等/并发 | 1、3、5 |
| 自动/人工关联正反向一致，不逐次全库扫描 | 2、3、4 |
| 批量摘要、独立报告分页、失效计数与部分失败 | 4、5、8 |
| 来源去重、职业范围、时间语义、权限延续 | 4、6、7 |
| 跨库问答及实际输入引用校验、原采购约束 | 6、7 |
| 历史报告不变、生成时间、单列后续资料 | 4、5、9 |
| 图谱/App、服务关闭时兼容、六入口贯通 | 5、8、9 |
| 本地禁构建、远程完整 gate、真实宿主证据 | 全局约束、2、8、9、10 |

写计划阶段不执行实现测试、不启动图谱、不改应用代码。完成本文后先由用户选择 subagent-driven-development 或 executing-plans 的执行方式。

## 修正项回归代码与具体接线

以下均是实施时写入指定测试文件的代码，不在规划阶段运行。新增 fixture 只服务这些行为测试，不作为应用层架构。

### 共享合成资料

Task 3 在 `tests/fixtures/company-context.ts` 写入以下常量。信用代码由离线合成前缀计算，禁止向外部接口查询。

```ts
import type { StoredCompanyProfile } from '../../src/db/profile-repository.js';
import type { OrganizationIdentity } from '../../src/companies/company-context-types.js';
const chars='0123456789ABCDEFGHJKLMNPQRTUWXY';
const weights=[1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28];
const prefix='91310000123456789';
export const CODE=prefix+chars[(31-[...prefix].reduce((n,c,i)=>n+chars.indexOf(c)*weights[i],0)%31)%31];
export const AT='2026-10-12T00:00:00.000Z';
export const ORG:OrganizationIdentity={entity_id:'o1',version:1,name:'测试装备有限公司',
  legal_name:null,identifiers:[],archived:false,identity_complete:true,evidence:[],conflicts:[]};
export const PROFILE:StoredCompanyProfile={
  identity:{legalName:'测试装备有限公司',creditCode:CODE,formerNames:[],aliases:[],
    englishNames:[],brands:[],officialDomains:[],registeredAddress:null,
    parentLegalName:null,subsidiaryLegalNames:[]},
  normalizedLegalName:'测试装备有限公司',collectedAt:AT,
  basicProfile:{industry:null,region:null,company_type:null,founded_year:null,
    registered_capital:null,legal_representative:null,website:null,
    employee_range:null,risk_summary:null,collected_at:AT},
};
```

OrganizationIdentity 与 RecentRecord 的归属文件固定为 `src/companies/company-context-types.ts`；Task 2 的 Files 清单同时修改该文件。Task 4 再向此 fixture 文件加入以下 imports/function，不使 Task 3 提前导入尚不存在的共享 service：

```ts
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { initializeDatabase } from '../../src/db/database.js';
import { ProfileRepository } from '../../src/db/profile-repository.js';
import { AssessmentRepository } from '../../src/db/assessment-repository.js';
import { CompanyLinkRepository } from '../../src/db/company-link-repository.js';
import { CompanyContextService } from '../../src/companies/company-context-service.js';
import { identityHash } from '../../src/companies/company-link.js';
import type { GraphClient } from '../../src/contacts/graph-client.js';
export function createContextFixture() {
  const db=initializeDatabase(new DatabaseSync(':memory:'));
  const links=new CompanyLinkRepository(db), profiles=new ProfileRepository(db);
  const assessments=new AssessmentRepository(db);
  const org=structuredClone(ORG);
  profiles.upsert(PROFILE);
  links.write({action:'confirm',organization_id:'o1',credit_code:CODE,
    operation_id:'fixture-link',expected_link_version:0,expected_organization_version:1,
    note:'合成数据人工关联'},'test',identityHash(org),AT);
  const request=vi.fn(async (op:string,_payload:unknown,_signal?:AbortSignal):Promise<unknown> => {
    if(op==='company_organizations') return {items:[org],total:1,next_offset:null,complete:true};
    if(op==='company_relations'||op==='company_recent_records')
      return {items:[],total:0,next_offset:null,complete:true};
    throw new Error(`Unexpected graph operation: ${op}`);
  });
  const graph={request,close:async()=>{}} as unknown as GraphClient;
  const service=new CompanyContextService({graph,links,profiles,assessments,
    now:()=>new Date(AT),profileTtlDays:30});
  return {db,links,profiles,assessments,org,request,graph,service};
}
```

Task 4 将以下完整用例写入 `tests/company-context-service.test.ts`：

```ts
import { expect,it } from 'vitest';
import { createContextFixture,AT } from './fixtures/company-context.js';
it('does not attach company reports to a name-only candidate or write during search',async()=>{
  const f=createContextFixture();
  try {
    f.db.exec('DELETE FROM company_link_operations; DELETE FROM company_links;');
    const before=f.db.prepare('SELECT count(*) AS n FROM company_links').get();
    const result=await f.service.summaries(['o1']);
    expect(result.get('o1')?.link.state).toBe('candidate');
    expect(result.get('o1')?.report_count).toBeNull();
    expect(f.db.prepare('SELECT count(*) AS n FROM company_links').get()).toEqual(before);
    expect(f.request.mock.calls.some(([op])=>op==='save_contact')).toBe(false);
  } finally {f.db.close();}
});
```

### A. 提交后身份变化与幂等回执

Task 3 写入 `tests/company-link.test.ts`；复用上述常量，**不**导入 Task 4 才加入的 createContextFixture。首次提交后修改组织，回放不读图谱，当前 resolver 独立返回 conflict。

```ts
import { DatabaseSync } from 'node:sqlite';
import { expect,it,vi } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { CompanyLinkRepository } from '../src/db/company-link-repository.js';
import { CompanyLinkService,resolveCompanyLink } from '../src/companies/company-link.js';
import type { GraphClient } from '../src/contacts/graph-client.js';
import { ORG,PROFILE,CODE,AT } from './fixtures/company-context.js';
it('returns the same committed receipt even when identity changes immediately after commit',async()=>{
  const db=initializeDatabase(new DatabaseSync(':memory:'));
  try {
    const profiles=new ProfileRepository(db); profiles.upsert(PROFILE);
    const links=new CompanyLinkRepository(db), org=structuredClone(ORG);
    const request=vi.fn(async()=>({items:[structuredClone(org)],total:1,next_offset:null,complete:true}));
    const graph={request,close:async()=>{}} as unknown as GraphClient;
    const originalWrite=links.write.bind(links);
    vi.spyOn(links,'write').mockImplementationOnce((...args)=>{
      const receipt=originalWrite(...args);
      org.name='另一个组织'; org.version=2;
      return receipt;
    });
    const service=new CompanyLinkService({graph,links,profiles,now:()=>new Date(AT)});
    const input={action:'confirm' as const,organization_id:'o1',credit_code:CODE,
      operation_id:'race',expected_link_version:0,expected_organization_version:1,note:'人工确认合成主体'};
    const first=await service.change(input,'test');
    const reads=request.mock.calls.length;
    const replay=await service.change(input,'test');
    expect(replay).toEqual(first);
    expect(request).toHaveBeenCalledTimes(reads);
    expect(db.prepare('SELECT count(*) AS n FROM company_link_operations').get()?.n).toBe(1);
    expect(resolveCompanyLink(org,links.get('o1'),[PROFILE]).state).toBe('conflict');
  } finally {db.close();}
});
```

### B. 报告后续资料的工具贯通

Task 5 在 `tests/company-context-tools.test.ts` 加入以下用例。真实 AssessmentService 与真实 MCP handler/Schema 配合 fake 仓储；覆盖 false 不查、true 按记录主体和完成时间查、附加源失败保留正文、processing 不查。该文件不 import index.ts、不启动 native。

```ts
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect,it,vi } from 'vitest';
import { AssessmentService } from '../src/orchestration/assessment-service.js';
import type { AssessmentRepository } from '../src/db/assessment-repository.js';
import { buildMcpServer,type McpServices } from '../src/mcp/tools.js';
import { CODE,AT } from './fixtures/company-context.js';
it('routes report updates opt-in through the real tool without changing the report',async()=>{
  const id='10000000-0000-4000-8000-000000000001';
  const record={assessmentId:id,status:'completed',creditCode:CODE,legalName:'测试装备有限公司',
    reportMarkdown:'# 原报告',overallOpportunity:'中',recommendedProduct:null,
    sourceStatus:{qcc:'completed',doubaoSearch:'completed',ark:'completed'},collectedAt:AT,completedAt:AT};
  const assessments={get:vi.fn(()=>record)} as unknown as AssessmentRepository;
  const updates={state:'partial' as const,warnings:['GRAPH_UNAVAILABLE'],since:AT,
    scope:['profiles'],truncated:false,items:[{kind:'profile' as const,id:CODE,
      recorded_at:'2026-10-12T01:00:00.000Z',label:'画像更新'}]};
  const relatedUpdates=vi.fn(async (_code:string,_since:string,_signal?:AbortSignal)=>updates);
  const service=new AssessmentService({assessments,queue:{enqueue:()=>false},
    assessmentCacheTtlDays:30,now:()=>new Date(AT)});
  const server=buildMcpServer({getAssessmentReport:input=>
    service.reportWithUpdates(input,{relatedUpdates})} as McpServices);
  const client=new Client({name:'company-context-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const base=await client.callTool({name:'get_assessment_report',arguments:{assessment_id:id}});
    expect(base.isError).not.toBe(true);
    expect(base.structuredContent?.generated_at).toBe(AT);
    expect(relatedUpdates).not.toHaveBeenCalled();
    const loaded=await client.callTool({name:'get_assessment_report',arguments:{
      assessment_id:id,include_related_updates:true}});
    expect(loaded.isError).not.toBe(true);
    expect(relatedUpdates.mock.calls[0]?.slice(0,2)).toEqual([CODE,AT]);
    expect(loaded.structuredContent?.related_updates).toEqual(updates);
    expect(loaded.structuredContent?.markdown).toBe(base.structuredContent?.markdown);
    relatedUpdates.mockRejectedValueOnce(new Error('source unavailable'));
    const partial=await client.callTool({name:'get_assessment_report',arguments:{
      assessment_id:id,include_related_updates:true}});
    expect(partial.isError).not.toBe(true);
    expect(partial.structuredContent?.related_updates).toMatchObject({state:'unavailable'});
    expect(partial.structuredContent?.markdown).toBe(base.structuredContent?.markdown);
    record.status='processing'; relatedUpdates.mockClear();
    const pending=await client.callTool({name:'get_assessment_report',arguments:{
      assessment_id:id,include_related_updates:true}});
    expect(pending.structuredContent?.status).toBe('processing');
    expect(relatedUpdates).not.toHaveBeenCalled();
    expect(record.reportMarkdown).toBe('# 原报告');
  } finally {await client.close(); await server.close();}
});
```

同文件补充以下 imports 和 get_contact 参数隔离测试，复用上面的 Client、InMemoryTransport、expect/it/vi：

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { ContactLibraryService } from '../src/contacts/library-service.js';
import { registerContactTools } from '../src/mcp/contact-tools.js';
import type { GraphClient } from '../src/contacts/graph-client.js';
import type { CompanyDetail } from '../src/companies/company-context-types.js';
it('keeps company query parameters out of the graph request',async()=>{
  const request=vi.fn(async (_op:string,_payload:unknown)=>({
    entity_id:'o1',label:'Organization',name:'测试学校',evidence:[],relations:[],conflicts:[],
  }));
  const detail=vi.fn(async (_id:string,_offset:number,_limit:number):Promise<CompanyDetail>=>({
    state:'ok',warnings:[],
    link:{state:'unlinked',organization_id:'o1',credit_code:null,basis:null,version:0,candidates:[],warnings:[]},
    has_profile:false,report_count:null,latest_report_at:null,profile:null,latest_report:null,
    reports:{items:[],total:0,next_offset:null,complete:true},
  }));
  const server=new McpServer({name:'contact-context-test',version:'1'});
  registerContactTools(server,new ContactLibraryService({request} as unknown as GraphClient),{detail});
  const client=new Client({name:'client',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const base=await client.callTool({name:'get_contact',arguments:{entity_id:'o1'}});
    expect(base.isError).not.toBe(true);
    expect(detail).not.toHaveBeenCalled();
    const enriched=await client.callTool({name:'get_contact',arguments:{
      entity_id:'o1',evidence_offset:2,include_company_context:true,report_offset:10,report_limit:10,
    }});
    expect(enriched.isError).not.toBe(true);
    expect(enriched.structuredContent?.company_context).toMatchObject({link:{state:'unlinked'}});
    expect(request).toHaveBeenLastCalledWith('get_contact',{entity_id:'o1',evidence_offset:2});
    expect(detail).toHaveBeenCalledTimes(1);
    expect(detail.mock.calls[0]?.slice(0,3)).toEqual(['o1',10,10]);
  } finally {await client.close();await server.close();}
});
```

### C. 多公司共享一个报告读取额度

Task 6 在 company-evidence.ts 定义上述三个小函数：selectReportForQuestion 返回 explicitId（由调用者校验）或摘要排序后的第一个 ID；createMaterialReadContext 创建固定报告选择；readSelectedReport 缓存读取结果（含 null）。`selected_report_id` 为 readonly，不能在遍历公司时改写。实现关键分支：

```ts
export function readSelectedReport(context:MaterialReadContext,
  load:(id:string)=>AssessmentRecord|null):AssessmentRecord|null {
  context.signal.throwIfAborted();
  if(context.report!==undefined) return context.report;
  if(context.selected_report_id===null) return context.report=null;
  if(context.report_reads!==0) throw new Error('REPORT_BUDGET_EXHAUSTED');
  context.report_reads=1;
  try {return context.report=load(context.selected_report_id);}
  catch(error) {context.report=null; throw error;}
}
```

相应完整测试写入 `tests/company-context-budget.test.ts`：

```ts
import { expect,it,vi } from 'vitest';
import { createMaterialReadContext,readSelectedReport,selectReportForQuestion } from '../src/companies/company-evidence.js';
it('selects one newest report across employers and does not reread even a missing record',()=>{
  const reports=[
    {assessment_id:'old',generated_at:'2026-10-10T00:00:00Z',collected_at:'2026-10-10T00:00:00Z',overall_opportunity:'中',recommended_product:null},
    {assessment_id:'new',generated_at:'2026-10-12T00:00:00Z',collected_at:'2026-10-12T00:00:00Z',overall_opportunity:'中',recommended_product:null},
  ];
  const context=createMaterialReadContext(new AbortController().signal,selectReportForQuestion(reports));
  const load=vi.fn((_id:string)=>null);
  for(const _employer of ['甲公司','乙公司']) readSelectedReport(context,load);
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledWith('new');
  expect(context.report_reads).toBe(1);
  expect(selectReportForQuestion(reports,'old')).toBe('old');
});
```

Task 7 在多雇主联系人测试中另外断言：传给两次 materials 的第三参数是同一个 MaterialReadContext，汇总后的 assessments.get 只读取选定快照一次；不同公司不能引用另一公司的 selected report。加入两个 employer 的已确认关系 fixture，并使用 vi.spyOn(assessments,'get') 检查实际读取，不用模型调用次数代替快照读取次数。

### D. 取消后不再翻页

Task 4 写入 `tests/company-context-service.test.ts`，复用完整 createContextFixture；在第一页返回过程中取消，之后不能再调用图谱或将取消转换为空结果。

```ts
import { expect,it } from 'vitest';
import { createContextFixture,CODE } from './fixtures/company-context.js';
it('propagates cancellation before requesting a second graph page',async()=>{
  const f=createContextFixture(), controller=new AbortController();
  try {
    f.request.mockImplementation(async(_op,_payload,signal)=>{
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('stop'));
      return {items:[f.org],total:2,next_offset:1,complete:false};
    });
    await expect(f.service.overview(CODE,controller.signal)).rejects.toThrow('stop');
    expect(f.request).toHaveBeenCalledTimes(1);
  } finally {f.db.close();}
});
```

Task 7 在两个问答入口各增加一例，用同一外部 AbortController 取消实际共享查询，断言不再调用后续 graph 页或上游补查。ask_company 继续返回既有超时/取消 failed 结果；ask_contacts 返回 failed 并注明取消，不能返回“未找到关系”。

### E. 已标记冲突不成为支持事实

Task 6 在 `tests/company-evidence.test.ts` 中加入完整用例；相应函数定义在 company-evidence.ts，既有 relation-evidence.ts 仍只负责主体与引文检查，避免循环导入。

```ts
import { expect,it } from 'vitest';
import type { ContactEvidence } from '../src/contracts/index.js';
import { filterConflictedEvidence } from '../src/companies/company-evidence.js';
const proof=(id:string,relation:string,field:string,value:string):ContactEvidence=>({
  evidence_id:id,subject_kind:'relation',subject_id:relation,field_path:field,value,
  quote:`测试人 ${value}`,source_type:'manual',locator_status:'not_applicable',
  collected_at:'2026-10-12T00:00:00.000Z',
});
it('blocks a disputed role but keeps an independent relationship',()=>{
  const role=proof('role','r1','properties.role.roleName','工程师');
  const disputed=proof('disputed','r1','properties.role.roleName','采购主管');
  const independent=proof('other','r2','$relation','另一段任职');
  const result=filterConflictedEvidence([role,disputed,independent],[disputed]);
  expect(result.blocked.map(e=>e.evidence_id)).toEqual(['role','disputed']);
  expect(result.usable.map(e=>e.evidence_id)).toEqual(['other']);
});
it('blocks an entire relation when the relation itself is disputed',()=>{
  const relation=proof('relation','r1','$relation','任职');
  const role=proof('role','r1','properties.role.roleName','工程师');
  expect(filterConflictedEvidence([relation,role],[relation]).usable).toEqual([]);
});
it('does not conflate different historical employment segments',()=>{
  const early=proof('early','r-2020','properties.role.roleName','2020年工程师');
  const later=proof('later','r-2024','properties.role.roleName','2024年主管');
  expect(filterConflictedEvidence([early,later],[]).usable).toEqual([early,later]);
});
```

### 修正验收对应表

| 审查项 | 修正位置与验收 |
| --- | --- |
| 后续资料没有接线 | Task 5 reportWithUpdates → MCP 字段映射；回归 B |
| 提交后冲突导致重放结果变化 | Task 3 固定提交回执，当前 resolver 独立校验；回归 A |
| 普通事实冲突过滤缺失 | Task 6 过滤器与 Task 7 双入口消费；回归 E |
| 多公司读取多个报告 | Task 6 固定选择与请求内单次读取，Task 7 共用；回归 C |
| 没有取消接口 | Task 4 signal 与 Task 6 请求上下文、Task 7 入口传递；回归 D |
| 只有断言、没有测试过程 | Task 7 实际 service.ask、Task 8 实际选择/翻页/打开，以及 A–E fixtures 与调用 |
