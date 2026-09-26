# 联系人管理升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将公开联系人快照扩展为可从简历／名片导入、人工确认、编辑、建立关系、检索并回答有来源问题的共享联系人库。

**Architecture:** 保留 Node.js 主服务及原有公开搜索路径。Python 直接调用 Docling 解析本地 PDF／图片并按文本块回传；Node 复用方舟客户端抽取、校验与确认候选；Rust 进程调用 `sqlite-knowledge-graph`，独占新图数据库并在事务中保存实体、关系、证据和幂等操作结果。

**Tech Stack:** Node.js >=24、TypeScript、Express 5、Zod 4、Vitest、`node:sqlite`；Python >=3.10、Docling、pytest；Rust、rusqlite、serde_json、`sqlite-knowledge-graph`；Docker/GHCR。

**Spec:** `docs/superpowers/plans/2026-09-25-contact-management-upgrade.md`。本文件是执行清单；字段定义、状态语义和验收阈值以该规格为准。

## Global Constraints

- 首版业务节点只有 `Person` 和 `Organization`；业务属性使用规格中完整白名单，项目扩展只放在人物 `extensions`。
- 必须实际调用 `sqlite-knowledge-graph` Rust API；不能仅复制其表结构或把 Python 示例当作真实 API。Rust 依赖从 Git 固定提交 [`d81ac7e`](https://github.com/hiyenwong/sqlite-knowledge-graph/tree/d81ac7e3e9efd553553a7a0d263907fdd571e957) 起步，并提交 `Cargo.lock`。执行时先做 Task 2 的真实 API/事务验证。
- Python 运行时依赖 Docling；Docling Graph 不作为运行依赖。实现同类能力前先读其源码与测试，记录参考提交（本计划基线 [`bbcd0e4`](https://github.com/docling-project/docling-graph/tree/bbcd0e4846fadfcadac2800784783e59cd2722a9)）、文件和必要差异；移植源码时遵守其许可。
- 上传只接本地 PDF、JPG、PNG；单文件不超过 20 MB，PDF 不超过 50 页，图片／渲染页不超过 2500 万像素。上传需现有 Bearer、Host、Origin 校验，不接受 URL。
- 未完成文件最多 10 个；解析并发 1；单任务处理最多 15 分钟；临时产物最多 1 GB；每文档最多 8 批、16 次模型请求（含重试）；JSON Lines 单帧 UTF-8 不超过 256 KiB。
- 不长期保存原件、页面图片或完整 OCR 正文；仅存文件名、SHA-256、必要短引文、可靠页码和候选。不要记录模型请求正文或敏感字段值。
- 新库为所有有效 Token 共享；审计保留真实 `userId`。所有图数据库写入（含导入状态、快照同步和向量）带稳定 `operation_id`，相同调用者、类型及规范化请求的重试返回原结果；内容或调用者不同则冲突。后台写入使用固定调用者 `system` 和确定性的操作 ID，不能与用户 ID 混用。
- `worksFor` 每段任职独立关系；`parent` 子女指向父母；`children` 是反向视图；`spouse`／`colleague` 对称。归档不自动恢复，已知来源重放也不能重新建可见档案。
- 向量使用独立的 `ARK_EMBEDDING_API_URL`、`ARK_EMBEDDING_MODEL`、`ARK_EMBEDDING_CREDENTIAL`；配置不完整时关键词查询仍工作。旧 `get_contacts` 保持只返回公开姓名／职位，不因新库而泄露电话邮箱。
- 图数据库与原业务数据库分别保存。新功能默认关闭，启用时显式配置路径；迁移先备份并提供 dry-run。发布镜像仍走 `.github/workflows/publish-image.yml` 的 `linux/amd64`、`linux/arm64`。
- 执行命令以 `rtk` 开头；不读取或提交 `.env` 中的凭据。本计划只写计划，不执行下列代码或提交命令。

---

## 文件与职责图

下表锁定主要落点；新增文件按职责拆开，既有公开搜索文件仅增读快照入口，不重构其投影逻辑。每项更改都先保留独立测试周期，完成后再进入下一项。

| 文件 | 唯一职责 |
|---|---|
| `src/contracts/contact-graph.ts`、`src/contracts/contact-import.ts` | 正式档案／关系及导入候选的 Zod 契约 |
| `tests/fixtures/contact-contracts/`、`docs/superpowers/specs/contact-data-contract.md` | 三语言共享正反 JSON 样例与协议字段清单 |
| `rust/contact-graph/src/{main,protocol,store,validation}.rs` | JSON Lines 边界、图谱调用、事务仓储及最终业务约束 |
| `src/contacts/{graph-client,snapshot-sync}.ts` | Rust 请求／响应与旧快照顺序同步 |
| `python/contact_worker/{main,parser}.py` | Docling 解析、OCR 和带来源的文本块输出 |
| `src/contacts/{upload-store,import-jobs,document-extractor}.ts` | 上传生命周期、待确认任务、方舟抽取与引文核对 |
| `src/contacts/{library-service,identity-match}.ts` | 编辑、合并、关系管理、人工确认与候选匹配 |
| `src/contacts/{embedding-client,contact-search,contact-answer}.ts` | 独立嵌入端点、混合检索、事实问答 |
| `src/mcp/{http-app,tool-schemas,tools}.ts`、`src/index.ts` | 鉴权上传、新 MCP 工具与进程生命周期 |
| `src/cli/contact-upload.ts`、`Dockerfile`、现有发布工作流 | 批量本地上传与双平台部署 |

已在上述 Docling Graph 基线提交核对过的优先入口如下，执行 Tasks 7/9 时继续读对应实现与测试，而非仅凭文件名推测行为：

| 本地功能 | 上游源码 | 上游测试 |
|---|---|---|
| 解析与分块 | [`document_processor.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/docling_graph/core/extractors/document_processor.py)、[`document_chunker.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/docling_graph/core/extractors/document_chunker.py) | [`test_document_processor.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/tests/unit/core/extractors/test_document_processor.py)、[`test_document_chunker.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/tests/unit/core/extractors/test_document_chunker.py) |
| 模型抽取与响应校验 | [`llm_backend.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/docling_graph/core/extractors/backends/llm_backend.py)、[`response_handler.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/docling_graph/llm_clients/response_handler.py) | [`test_llm_backend.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/tests/unit/core/extractors/backends/test_llm_backend.py)、[`test_response_handler.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/tests/unit/llm_clients/test_response_handler.py) |
| 引文与来源定位 | [`anchor_scan.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/docling_graph/core/provenance/anchor_scan.py)、[`binder.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/docling_graph/core/provenance/binder.py) | [`test_anchor_scan.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/tests/unit/core/provenance/test_anchor_scan.py)、[`test_binder.py`](https://github.com/docling-project/docling-graph/blob/bbcd0e4846fadfcadac2800784783e59cd2722a9/tests/unit/core/provenance/test_binder.py) |

接口约定：JSON Lines 请求为 `{version:1,request_id,op,payload}`；成功为 `{version:1,request_id,ok:true,result}`，失败为 `{version:1,request_id,ok:false,error:{code,message}}`。Rust `op` 白名单在 Task 2 固定，Node 不得向其传任意 SQL；Python 协议只允许 `parse`，取消时由 Node 终止解析子进程。对外 MCP 参数用 snake_case，返回业务属性保持 Schema.org camelCase。以下测试片段是各任务必须首先写出的最小断言；同任务的文字约束均是必测行为，不因片段简短而省略。

测试片段中的 `graph()/request()/graph_with_person_and_org()/works_for()` 是 Task 3–4 测试文件中建立临时图库及完整合法请求的本地辅助函数；`repository/store/upload/onePagePdf/parser/sample_pdf/extractor/signal/service/fileId/userId/graph/candidateId/callTool/personId/validEnv/search/stablePersonId/ask/savedSpouseEvidenceId/runUploadCli/files/truth` 是各对应测试文件在 Step 1 创建的 fixture 或变量，不是新的生产接口。辅助函数需建立真实临时数据库、模拟 HTTP/MCP 或受控模型响应，不用空桩让断言通过。

## Task 1：固定新联系人契约与共享样例

**Files:**
- Create: `src/contracts/contact-graph.ts`, `src/contracts/contact-import.ts`, `docs/superpowers/specs/contact-data-contract.md`
- Create: `tests/fixtures/contact-contracts/person-valid.json`, `organization-valid.json`, `worksfor-valid.json`, `person-invalid-unknown.json`, `relation-invalid-endpoint.json`, `block-valid.json`, `block-invalid.json`, `cases.json`
- Modify: `src/contracts/index.ts`
- Test: `tests/contact-contracts.test.ts`

**Interfaces:** Produces `ContactEntitySchema`, `ContactRelationSchema`, `ContactEvidenceSchema`, `ParsedBlockSchema`, `ImportCandidateSchema` and inferred TypeScript types. `Person.properties` has exactly the 31 standard fields in the spec; `extensions` has `nativePlace`, `hobbies`, `maritalStatus`, `instantMessaging`. Organization and nested objects use strict whitelists. Full outputs normalize every applicable array to `[]`; input edits distinguish omission from clear.

- [ ] **Step 1: Write failing contract tests and JSON examples.** Start with a valid Person containing two emails, two WeChat accounts, a `hasCredential` item, and one `worksFor` relation. Add negative examples for unknown field, null scalar, bad date, wrong relation endpoints, malformed block, duplicate account after normalization, and `maritalStatus.status="single"`. Put the remaining shared positive/negative cases in `tests/fixtures/contact-contracts/cases.json` as `{id,entrypoint,input?,steps?,expected_valid,expected_error?}` records; use `steps` only for stateful cases such as version conflicts and relation dedup. Cover every group enumerated in the Spec's “实施时共享正反样例必须覆盖” paragraph: minimal/full entity arrays, organization identifier, all 21 added Person properties, nested-object unknown keys and leaf evidence, two employment episodes and status conflicts, partial dates and birth/death ordering, relation direction/dedup, per-value evidence, clear/version conflicts, language fallback, assistant versus self contact channels, all four extensions, marital/spouse conflicts, multi-account dedup/label conflicts, and invalid inferred account IDs. Node and Rust run their applicable cases from the same JSON; Python runs only parsed-block cases. Do not duplicate fixtures separately per language.

```ts
import { ContactEntitySchema, ContactRelationSchema } from '../src/contracts/contact-graph.js';
import { readFileSync } from 'node:fs';
const person = JSON.parse(readFileSync(new URL('./fixtures/contact-contracts/person-valid.json', import.meta.url), 'utf8'));
const bad = JSON.parse(readFileSync(new URL('./fixtures/contact-contracts/person-invalid-unknown.json', import.meta.url), 'utf8'));
it('keeps multiple contacts and rejects unknown fields', () => {
  expect(ContactEntitySchema.parse(person).extensions.instantMessaging).toHaveLength(2);
  expect(ContactEntitySchema.safeParse(bad).success).toBe(false);
});
it('allows a separate worksFor edge per employment episode', () => {
  expect(ContactRelationSchema.parse({
    relation_id: 'r_1', source_id: 'p_1', target_id: 'o_1', relation_type: 'worksFor',
    properties: { role: { '@type': 'OrganizationRole', roleName: '经理', startDate: '2022' } },
  }).relation_type).toBe('worksFor');
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-contracts.test.ts`; expected: import failure for the two new schemas.
- [ ] **Step 3: Implement exact schemas.** Use `z.discriminatedUnion('label', [...])` for Person/Organization, `.strict()` at every object level, enum for relationship types, `z.array(z.string().trim().min(1))` for contact arrays, custom calendar/precision checks for `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, and post-parse endpoint validation. Do **not** import `PublicIdentityTextSchema` because it intentionally forbids contact information.

```ts
export const PersonExtensionsSchema = z.object({
  nativePlace: z.string().trim().min(1).optional(),
  hobbies: z.array(z.string().trim().min(1)).default([]),
  maritalStatus: z.object({
    status: z.enum(['never_married', 'married', 'divorced', 'widowed', 'other']),
    asOf: PartialDateSchema.optional(),
  }).strict().optional(),
  instantMessaging: z.array(z.object({
    platform: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    accountId: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
  }).strict()).default([]),
}).strict();
```

The same file defines `PartialDateSchema`, `PersonPropertiesSchema`, `OrganizationPropertiesSchema`, evidence and relation schemas from the spec tables. Keep evidence metadata outside business properties; `children` normalizes to stored `parent` with exchanged endpoints. `contact-data-contract.md` lists each fixture/case ID and its expected pass/fail result and the JSON Lines envelope above. Assert every Spec-required case ID is present, so a missing shared case fails Task 1 instead of silently reducing cross-language coverage.
- [ ] **Step 4: Verify green and old behavior.** Run `rtk npm test -- --run tests/contact-contracts.test.ts tests/contracts.test.ts`; expected: all pass. Run `rtk npm run typecheck`; expected: exit 0.
- [ ] **Step 5: Commit only this deliverable.** Run `rtk git add src/contracts/contact-graph.ts src/contracts/contact-import.ts src/contracts/index.ts tests/contact-contracts.test.ts tests/fixtures/contact-contracts docs/superpowers/specs/contact-data-contract.md docs/superpowers/plans/2026-09-25-contact-management-upgrade.md docs/superpowers/plans/2026-09-26-contact-management-implementation.md` then `rtk git commit -m "feat(contacts): define shared graph and import contracts"`.

## Task 2：验证并固定 Rust 图谱依赖、数据库与进程协议

**Files:**
- Create: `rust/contact-graph/Cargo.toml`, `rust/contact-graph/Cargo.lock`, `rust/contact-graph/src/main.rs`, `rust/contact-graph/src/protocol.rs`, `rust/contact-graph/src/store.rs`
- Test: `rust/contact-graph/tests/graph_smoke.rs`, `tests/contact-graph-protocol.test.ts`

**Interfaces:** Consumes Task 1 的 JSON envelopes。Produces a Rust executable `contact-graph` accepting one JSON Lines request at a time, with fixed `op` variants `health`, `get_contact`, `list_relations`, `save_contact`, `save_relation`, `merge_contacts`, `archive_contact`, `restore_contact`, `archive_relation`, `commit_import`, `sync_snapshots`, `get_sync_cursor`, `put_import_job`, `get_import_job`, `search_keyword`, `search_vector`, `put_vector`, `set_vector_state`. Later tasks implement business behavior behind these variants; unknown `op` is rejected at the boundary.

- [ ] **Step 1: Write a real library smoke test and protocol test.** Pin `sqlite-knowledge-graph` at the commit in Global Constraints. The library’s actual API uses numeric internal IDs; use `KnowledgeGraph::open`, `Entity::new`, `Relation::new`, `insert_entity`, `insert_relation`, `transaction`, `connection`, `insert_vector`, `search_vectors`. Test that a transaction encloses library insertion plus one application table write, then rolls both back on failure. Verify a second relation between the same endpoints remains separately queryable via `kg_relations`, not `get_neighbors`.

```rust
use sqlite_knowledge_graph::{KnowledgeGraph, Entity, Relation};
#[test]
fn library_and_app_rows_share_rollback() -> Result<(), Box<dyn std::error::Error>> {
    let kg = KnowledgeGraph::open_in_memory()?;
    kg.connection().execute_batch("CREATE TABLE app_probe (id INTEGER PRIMARY KEY);")?;
    {
        let tx = kg.transaction()?;
        let id = kg.insert_entity(&Entity::new("Person", "测试人"))?;
        tx.execute("INSERT INTO app_probe(id) VALUES(?1)", [id])?;
    }
    let count: i64 = kg.connection().query_row("SELECT count(*) FROM kg_entities", [], |r| r.get(0))?;
    assert_eq!(count, 0);
    Ok(())
}
```

- [ ] **Step 2: Verify red.** Run `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml`; expected: fails before files exist or because the probe is not wired.
- [ ] **Step 3: Create the smallest working binary and schema.** `main.rs` reads stdin line by line and writes only protocol JSON to stdout; diagnostics go to stderr. `protocol.rs` has `#[serde(tag="op", content="payload")]` or equivalent fixed dispatch. `store.rs` opens one `KnowledgeGraph` on a configured file, creates application tables on `kg.connection()` for `entity_ids(entity_id TEXT PRIMARY KEY, kg_id INTEGER UNIQUE)`, `relation_ids`, `entity_meta`, `relation_meta`, `evidence`, `source_mapping`, `operation_results`, `import_jobs`, `sync_cursor`, `vector_meta`. Use SQLite foreign keys and indexes on relation endpoints, source key, status and cursor. Avoid a second SQLite connection to this graph database so library and app rows can share `kg.transaction()`.

```toml
[package]
name = "contact-graph"
version = "0.1.0"
edition = "2021"

[dependencies]
sqlite-knowledge-graph = { git = "https://github.com/hiyenwong/sqlite-knowledge-graph", rev = "d81ac7e3e9efd553553a7a0d263907fdd571e957" }
rusqlite = "0.32"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
```

`rusqlite` version matches the pinned crate's dependency so `KnowledgeGraph::connection()` and application SQL use the same connection type. `protocol.rs` declares `Request { version, request_id, op, payload }` and `Response { version, request_id, ok, result?, error? }`; `dispatch(&Request)->Response` implements the fixed whitelist.

```rust
use std::io::BufRead;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let response = dispatch(&request);
        let mut writer = stdout.lock();
        serde_json::to_writer(&mut writer, &response)?;
        use std::io::Write;
        writer.write_all(b"\n")?;
    }
    Ok(())
}
```

For malformed frames, return a structured error without exiting; for EOF close cleanly. `dispatch` initially handles `health` (echoing optional `nonce`) and rejects unimplemented fixed operations with `UNAVAILABLE` rather than silently succeeding. Confirm with `cargo test` that the pin compiles on the target toolchain before other Rust work.
- [ ] **Step 4: Verify.** Run `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml` and `rtk npm test -- --run tests/contact-graph-protocol.test.ts`; expected: rollback, two-edge storage, malformed request, unknown operation, and health tests pass.
- [ ] **Step 5: Commit.** Run `rtk git add rust/contact-graph tests/contact-graph-protocol.test.ts` then `rtk git commit -m "feat(contacts): establish Rust graph process and transaction boundary"`.

## Task 3：图谱实体、字段证据与幂等写入

**Files:**
- Create: `rust/contact-graph/src/validation.rs`
- Modify: `rust/contact-graph/src/store.rs`, `rust/contact-graph/src/protocol.rs`
- Test: `rust/contact-graph/tests/entity_write.rs`, `tests/contact-graph-integration.test.ts`

**Interfaces:** Consumes `ContactEntitySchema` JSON from Task 1 and internal `entity_ids` mapping from Task 2. Produces `save_contact`, `get_contact`, `put_import_job`, `get_import_job`. `save_contact` payload is `{operation_id,actor,entity_id?,label,expected_version?,set_properties?,unset_properties?,set_extensions?,unset_extensions?,evidence}`; result `{entity_id,version,replayed}`. `get_contact` returns entity, relations, evidence, conflicts and version. IDs are application UUID-prefixed strings; library IDs remain internal i64.

- [ ] **Step 1: Write failing real-SQLite tests.** Create a Person with two emails and per-value evidence, read it back, edit with expected version, then resend the exact original operation ID. Assert same result, no duplicate evidence, conflicting payload/actor gets `OPERATION_CONFLICT`, stale version gets `VERSION_CONFLICT`, an unknown Person property is rejected. Try creating a named Person without name evidence, adding an email without evidence for that exact array value, and adding a credential whose `educationalLevel` leaf lacks supporting evidence; each write must fail without leaving graph rows. Include full business validation in Rust, not merely Node parsing.

```rust
#[test]
fn replay_returns_committed_result_before_version_check() {
    let first = request("op-1", "user-a", "陈晓", 0);
    let created = graph().save_contact(first.clone()).unwrap();
    let replay = graph().save_contact(first).unwrap();
    assert_eq!(replay.entity_id, created.entity_id);
    assert_eq!(replay.version, created.version);
}
```

- [ ] **Step 2: Verify red.** Run `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml entity_write`; expected: dispatch rejects `save_contact`.
- [ ] **Step 3: Implement transaction and validation.** Validate name, strict field whitelist, arrays, nested objects, dates, evidence paths, and relationship to actor. Before committing, require at least one matching file/web/manual evidence record for every selected nonempty field value and each array item. For a nested object, a full-object evidence value may support all leaves only when its quote/confirmation supports the entire object; otherwise require `value_path` evidence for each populated leaf. `field_path` and `value` must match the selected value. Omitted fields and normalized empty arrays need no invented evidence. Reject a document-level source record offered as proof for an unsupported field. `canonical_request_hash` must serialize a recursively key-sorted JSON object and hash its UTF-8 bytes; store operation ID, actor, type, hash and result JSON. Check replay row **before** version. For create, call `kg.insert_entity(&Entity::new(label,name))`, then write `entity_ids`, metadata and evidence on the same `kg.transaction()`; for edit call `kg.update_entity` and update metadata/evidence within that same transaction. Use one selected display value per scalar, keep conflicting evidence rather than overwriting it. On any validation or SQL failure roll back all writes.

```rust
let tx = kg.transaction()?;
let mut entity = Entity::new(label, name);
for (key, value) in validated_properties { entity.set_property(key, value); }
let kg_id = kg.insert_entity(&entity)?;
tx.execute("INSERT INTO entity_ids(entity_id,kg_id) VALUES(?1,?2)", (&entity_id, kg_id))?;
tx.execute("INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,?2,?3,?4,?5)", (&operation_id,&actor,"save_contact",&hash,&result_json))?;
tx.commit()?;
```

For import job persistence, store only pending candidate JSON and short evidence; reject original file bytes, page images and full OCR text in that payload. `put_import_job` and `get_import_job` use server-generated IDs and fixed status enum. Initial job creation records a unique `file_id` binding and caller operation result in the same graph transaction; replay checks the operation result before the file binding, so a lost initiation response is recoverable without reusing the upload.
- [ ] **Step 4: Verify.** Run `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml` and `rtk npm test -- --run tests/contact-graph-integration.test.ts`; expected: replay, rollback, version and restart cases pass on a file-backed temporary SQLite DB.
- [ ] **Step 5: Commit.** Run `rtk git add rust/contact-graph tests/contact-graph-integration.test.ts` then `rtk git commit -m "feat(contacts): persist validated entities and idempotent results"`.

## Task 4：关系、多段任职、合并与归档

**Files:**
- Modify: `rust/contact-graph/src/{store,validation,protocol}.rs`
- Test: `rust/contact-graph/tests/relationships.rs`, `rust/contact-graph/tests/lifecycle.rs`

**Interfaces:** Consumes Task 3 entity IDs and operation-result transaction helper. Produces `save_relation`, `list_relations`, `archive_relation`, `merge_contacts`, `archive_contact`, `restore_contact`, `commit_import` transaction primitives. Relations map stable `relation_id` to library i64 ID; `worksFor.properties.role` carries `OrganizationRole` data and `relation_meta` carries status/as-of/version/archive.

- [ ] **Step 1: Write failing tests for two `worksFor` edges to one organization, wrong endpoint types, `children` inversion, symmetric spouse lookup, source mapping redirects, archive exclusion, explicit restore and merge rollback.** Reject a relation without matching `$relation` existence evidence and a `worksFor` status without evidence or manual confirmation. Verify omitted status normalizes to `unknown`; reject `current` without a full `YYYY-MM-DD` `status_as_of`, without explicit current-status evidence, or with `endDate`. Reject `ended` inferred solely from a future end date; allow an ended status with explicit evidence and no end date. Include a failed multi-entity import commit that must leave no entities, relations, evidence or result row.

```rust
#[test]
fn promotions_remain_two_relations() {
    let mut g = graph_with_person_and_org();
    g.save_relation(works_for("r-a", "工程师", "2020", "2022")).unwrap();
    g.save_relation(works_for("r-b", "经理", "2022", "2024")).unwrap();
    assert_eq!(g.list_relations("p-a").unwrap().len(), 2);
}
```

- [ ] **Step 2: Verify red.** Run `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml relationships`; expected: no `save_relation` implementation.
- [ ] **Step 3: Implement precise graph rules.** Create library `Relation::new(source_kg_id,target_kg_id,relation_type,1.0)` for each persisted edge and attach role JSON via `set_property`; query **all** `kg_relations` rows joined with `relation_ids`, never use `get_neighbors` to list a complete employment history. Normalize `children` to `parent` with reversed IDs, spouse/colleague ordered by stable IDs. Require `$relation` evidence whose normalized type/endpoints match the stored relation, and value-specific evidence for selected role fields and `employment_status`/`status_as_of`. Default omitted employment status to `unknown`; require explicit evidence or manual confirmation plus a full as-of date for `current`, disallow `current` with `endDate`, and do not infer `ended` from an end date that is still in the future. Reject status conflicts before writing. Do not coalesce `worksFor` by endpoints/role; de-duplicate other relations by normalized `(type,source,target)` while adding evidence. For archive, set metadata `archived_at`, keep IDs/source maps and filter these rows from all reads; restore only via explicit write. Merge validates same label and versions, redirects source mapping and edges, preserves separate employment episode IDs, stores `merged_into`, and writes operation result in one transaction. `commit_import` applies selected create/merge/skip choices in a single transaction, marks task committed and stores its prefixed operation ID; retry returns original result.

```rust
let mut relation = Relation::new(source_kg_id, target_kg_id, "worksFor", 1.0)?;
relation.set_property("role", serde_json::json!({"@type":"OrganizationRole","roleName":"经理"}));
let edge_id = kg.insert_relation(&relation)?;
tx.execute("INSERT INTO relation_ids(relation_id,kg_id) VALUES(?1,?2)", (&app_edge_id,edge_id))?;
```

- [ ] **Step 4: Verify.** Run `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml`; expected: two employment episodes remain after merge/restart, archived identities are invisible, response-loss replay is idempotent, bad relation rolls back.
- [ ] **Step 5: Commit.** Run `rtk git add rust/contact-graph` then `rtk git commit -m "feat(contacts): keep employment episodes and archive graph records"`.

## Task 5：Node 与 Rust 的固定进程桥接

**Files:**
- Create: `src/contacts/graph-client.ts`
- Modify: `src/index.ts`, `src/config.ts`, `.env.example`
- Test: `tests/contact-graph-client.test.ts`, `tests/config.test.ts`, `tests/lifecycle.test.ts`

**Interfaces:** Consumes Task 2–4 JSON Lines operations. Produces `ContactGraphClient.request<T>(op: GraphOp,payload:unknown,signal?:AbortSignal):Promise<T>` and `close():Promise<void>`. `GraphOp` is the fixed Task 2 whitelist; the client serializes requests and matches `request_id`. `CONTACT_GRAPH_ENABLED=false` defaults off, `CONTACT_GRAPH_SQLITE_PATH` is a separate DB path, `CONTACT_GRAPH_BIN` points to a **server-configured** executable, never an MCP argument.

- [ ] **Step 1: Write failing bridge and config tests.** Two concurrent calls must resolve with their own request IDs; a killed child rejects inflight work; malformed JSON/oversized frame fails safely; closing waits or aborts boundedly. Default config keeps old service startable with no Rust binary. Test that user-supplied path fields are rejected.

```ts
it('keeps concurrent responses paired by request_id', async () => {
  const client = new ContactGraphClient({ command: fakeGraphBinary, dbPath: tempDb });
  const [a,b] = await Promise.all([
    client.request('health', { nonce: 'a' }),
    client.request('health', { nonce: 'b' }),
  ]);
  expect(a).toMatchObject({ nonce: 'a' });
  expect(b).toMatchObject({ nonce: 'b' });
  await client.close();
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-graph-client.test.ts tests/config.test.ts`; expected: bridge import fails.
- [ ] **Step 3: Implement one child with a serialized request queue and bounded stdout decoder.** Spawn by configured executable and fixed argv, capture stderr only as sanitized diagnostics, enforce one outstanding graph request at a time, reject unknown response IDs, use `AbortSignal` for cancellation, and close child in `createApplication.close()`. Extend `CONFIG_KEYS`, Zod config and `AppConfig` for graph options; when disabled do not spawn. Add explicit defaults to `.env.example` only; do not read or copy `.env` values.

```ts
export type GraphOp = 'health' | 'get_contact' | 'list_relations' | 'save_contact'
  | 'save_relation' | 'merge_contacts' | 'archive_contact' | 'restore_contact'
  | 'archive_relation' | 'commit_import' | 'sync_snapshots' | 'get_sync_cursor'
  | 'put_import_job' | 'get_import_job' | 'search_keyword' | 'search_vector' | 'put_vector'
  | 'set_vector_state';
export interface GraphClient { request<T>(op: GraphOp,payload: unknown,signal?: AbortSignal): Promise<T>; close(): Promise<void>; }
```

- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-graph-client.test.ts tests/config.test.ts tests/lifecycle.test.ts`, `rtk npm run typecheck`; expected: old disabled path and child lifecycle pass.
- [ ] **Step 5: Commit.** Run `rtk git add src/contacts/graph-client.ts src/index.ts src/config.ts .env.example tests/contact-graph-client.test.ts tests/config.test.ts tests/lifecycle.test.ts` then `rtk git commit -m "feat(contacts): connect Node to the Rust graph worker"`.

## Task 6：旧快照回填与持续同步

**Files:**
- Modify: `src/db/contact-snapshot-repository.ts`, `src/contacts/contact-service.ts`, `src/index.ts`, `src/config.ts`, `package.json`, `rust/contact-graph/src/store.rs`
- Create: `src/contacts/snapshot-sync.ts`, `src/cli/contact-sync.ts`
- Test: `tests/contact-snapshot-sync.test.ts`, `rust/contact-graph/tests/snapshot_sync.rs`

**Interfaces:** Produces `ContactSnapshotRepository.findAfter(snapshotId:number,limit:number)` ordered by `snapshot_id ASC`; `sync_snapshots({operation_id:'snapshot-sync:<first>-<last>',actor:'system',snapshots:[...]})` atomically writes mapped graph facts, source keys and highest processed cursor. `SnapshotSync.preview(limit:number):Promise<{source_count:number,last_snapshot_id:number}>` performs read-only dry-run; `SnapshotSync.runBatch(limit:number):Promise<number>` reads cursor from Rust before each batch. `npm run contacts:sync -- --dry-run` previews, `npm run contacts:sync -- --backup /absolute/path.sqlite` backs up the old DB and runs initial backfill. Runtime continuous sync starts only after this initial-backup marker is recorded. No second event table.

- [ ] **Step 1: Write failing tests.** Two snapshots for one query containing the same `(company,name,title)` must resolve to one entity with two observations; a changed title remains a separate observation until user confirmation. Also test duplicate replay, restart after response loss, known-source hit on archived/merged contact, and unrelated same-name record not globally blocked. Assert dry-run advances no cursor or graph row; a pre-backfill SQLite backup exists and is readable; old `get_contacts` output remains byte-for-byte equivalent before/after sync failure.

```ts
it('reads snapshots after a cursor in stable order', () => {
  expect(repository.findAfter(4, 2).map(row => row.snapshotId)).toEqual([5, 6]);
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-snapshot-sync.test.ts`; expected: `findAfter` missing.
- [ ] **Step 3: Implement `findAfter` with `WHERE snapshot_id > ? ORDER BY snapshot_id ASC LIMIT ?`.** Use two keys: observation key `(snapshot_id,company_index,contact_index)` for per-snapshot evidence replay, and identity-within-query key `(cache_key,normalized_company_name,normalized_person_name,normalized_title)` so the same exact old record across snapshots of one query resolves to one entity. A changed title, a different query scope or a new external source does not auto-merge; preserve raw URL, publication and collection timestamps, and old role name. Absence from a later search is not evidence of departure. Rust resolves `merged_into` then checks `archived_at`; for known sources it retains the mapping and does not resurrect/create. `preview` calculates batch counts without write commands. `contact-sync.ts` accepts exactly `--dry-run` or `--backup <absolute-path>`; before first live backfill, use Node's `node:sqlite` `backup()` against the main DB to create and verify that operator-selected backup; refuse live backfill if backup failed, unless the main DB is explicitly `:memory:` in tests. Persist an initialized-sync marker with the cursor so startup can distinguish “never backed up” from “backed up, no rows yet”. In one Rust transaction apply snapshot graph rows, source mappings and cursor update; on error leave cursor unchanged. Node sync drains on start in small batches only after initialization, and after successful append, but catches graph outage so old search response still succeeds.

```ts
findAfter(snapshotId: number, limit: number) {
  return this.database.prepare(`SELECT snapshot_id,cache_key,normalized_query,
    normalized_region_hint,result_json,collected_at,stored_at
    FROM contact_query_snapshots WHERE snapshot_id > ?
    ORDER BY snapshot_id ASC LIMIT ?`).all(snapshotId, limit).map(toStoredSnapshot);
}
```

- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-snapshot-sync.test.ts tests/mcp-e2e.test.ts` and `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml snapshot_sync`; expected: repeat sync is idempotent, outage does not fail old tool, archived remains hidden.
- [ ] **Step 5: Commit.** Run `rtk git add src/db/contact-snapshot-repository.ts src/contacts/contact-service.ts src/contacts/snapshot-sync.ts src/cli/contact-sync.ts src/index.ts src/config.ts package.json rust/contact-graph tests/contact-snapshot-sync.test.ts` then `rtk git commit -m "feat(contacts): replay public snapshots into the graph"`.

## Task 7：Docling 本地文件解析进程

**Files:**
- Create: `python/pyproject.toml`, `python/uv.lock`, `python/contact_worker/{__init__,main,parser}.py`, `python/tests/test_parser.py`, `python/tests/test_protocol.py`
- Create: `tests/fixtures/contact-documents/` with two synthetic smoke inputs (one text PDF, one PNG card)

**Interfaces:** Consumes Task 1 `ParsedBlockSchema`; Python request `parse` contains only a server-owned temporary path, file type, document ID and limits. Emits `block` frames `{version:1,request_id,kind:"block",block:{block_id,text,page?,source_ref?}}` and final `{kind:"done",block_count,warning_codes}`. Node terminates the worker on cancel/timeout. Does not call Ark, store raw OCR in DB, or produce entity IDs.

- [ ] **Step 1: Inspect pinned Docling Graph source for conversion, chunking and provenance before coding.** Record its commit, exact files/tests reviewed, and why the selected behavior maps to this simpler block contract in `docs/superpowers/specs/contact-data-contract.md`. Write failing Python tests for PDF page tracking, image OCR path, oversized page rejection, malformed input, and >256 KiB text splitting with stable source_ref. Fixture documents must contain invented people only.

```python
def test_pdf_blocks_keep_real_page_number(parser, sample_pdf):
    blocks = parser.parse(sample_pdf)
    assert blocks
    assert all(b.page is None or b.page >= 1 for b in blocks)
    assert any(b.page == 2 for b in blocks)
```

- [ ] **Step 2: Verify red.** Run `rtk proxy uv run --project python pytest python/tests/test_parser.py -q`; expected: import failure for `contact_worker.parser` or test fixture not yet implemented. Install `uv` in the execution environment before this task; do not add it to the production image.
- [ ] **Step 3: Implement Docling conversion and block emission.** Pin `docling>=2.105.0,<3.0.0` in `pyproject.toml`, include `pypdf` and `Pillow` for pre-render page-count/image-dimension checks, then run `rtk proxy uv lock --project python` to lock exact transitive packages. Use `DocumentConverter` on the Node-controlled local path, inspect parsed document items and provenance to derive page numbers/source refs, run OCR for scanned PDFs and cards, limit rendered page pixels and temporary bytes. Reject encrypted PDF and >50 pages before rendering; check image headers before full decoding. If a page has no reliable page number emit no `page`; never invent it. Split oversized UTF-8 text by safe boundaries retaining block/source identity; fail if necessary content cannot be represented under the protocol and processing budget. Restrict temp directory and disable debug export; worker stdout carries only JSON Lines, stderr sanitized error codes.

```python
from docling.document_converter import DocumentConverter

def convert_local(path: str):
    return DocumentConverter().convert(path).document

def block_frame(request_id: str, block: dict) -> dict:
    return {"version": 1, "request_id": request_id, "kind": "block", "block": block}
```

Do not assume a Docling Graph node provenance field is evidence for each individual contact field. Map each Docling item to a block and let Node verify short quotes against its text. The protocol test must assert that source code does not print full text to stderr on failure.
- [ ] **Step 4: Verify.** Run `rtk proxy uv run --project python pytest python/tests -q`; expected: PDF, card, invalid file, pages, pixels, split blocks, cancel and no raw output logs pass. Validate two smoke documents through the Node block schema from Task 1.
- [ ] **Step 5: Commit.** Run `rtk git add python tests/fixtures/contact-documents docs/superpowers/specs/contact-data-contract.md` then `rtk git commit -m "feat(contacts): parse local documents with Docling"`.

## Task 8：上传、配额与待处理文件生命周期

**Files:**
- Create: `src/contacts/upload-store.ts`, `src/contacts/import-jobs.ts`
- Modify: `src/mcp/http-app.ts`, `src/index.ts`, `src/config.ts`, `.env.example`
- Modify: `package.json`, `package-lock.json` (streaming multipart parser dependency)
- Test: `tests/contact-upload.test.ts`, `tests/contact-import-lifecycle.test.ts`, `tests/config.test.ts`

**Interfaces:** Produces `POST /contact-files` `{file_id,filename,sha256}` and `ImportJobs.reserve()/release()/start()/cancel()/recover()`; later `import_contacts` uses `file_id`. Only Node builds the local worker path. Existing auth middleware from `http-app.ts` must apply before any body bytes are accepted.

- [ ] **Step 1: Write failing HTTP and config tests.** With ten outstanding file slots, the 11th request receives `429 {code:"CAPACITY_FULL"}` before body is streamed; concurrent reservations cannot exceed ten. Invalid token/origin/host, >20 MB, wrong magic bytes, partial disconnect and overlarge image/PDF are rejected and leave no file. Accepted upload returns opaque file ID and SHA-256, not a client-controlled filesystem path. Assert each documented limit has its default, accepts a positive-integer override, rejects zero/negative/non-integer input, and that an override actually changes the corresponding upload/processing/batch decision rather than only appearing in config.

```ts
it('rejects the 11th upload before storing bytes', async () => {
  await Promise.all(Array.from({ length: 10 }, () => store.reserve()));
  const response = await upload(onePagePdf);
  expect(response.status).toBe(429);
  expect(await store.tempFiles()).toEqual([]);
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-upload.test.ts`; expected: `/contact-files` returns 404.
- [ ] **Step 3: Implement stream-first authenticated upload.** Extract a reusable `exactOriginMiddleware`/`authMiddleware` from `createHttpApp` so the same checks guard `/mcp` and `/contact-files`. Add `busboy` and its type package to `package.json`/lockfile; reserve slot before multipart parsing, accept one file field, cap bytes as received, use a private temp directory and generated filename, calculate SHA-256 during stream, and sniff PDF/JPEG/PNG signatures. Reject malformed PDF/encrypted PDF and decoded dimensions in Python preflight before scheduling extraction. Expose only `file_id`. Slot release must be idempotent for cancel/timeout/disconnect/cleanup callback races and must occur after a ready-for-review candidate is persisted and its raw artifacts are cleaned. Never keep upload bytes in Node database. On restart remove orphan temp files, mark interrupted processing jobs failed, retain already persisted ready-for-review candidates, and expire only uploaded-but-never-submitted files at one hour.

```ts
export interface UploadedFile {
  fileId: string; fileName: string; sha256: string; mime: 'application/pdf' | 'image/jpeg' | 'image/png';
  tempPath: string; uploadedAt: string;
}
export interface UploadStore {
  reserve(): Promise<string>; get(fileId: string): UploadedFile | null;
  release(fileId: string): Promise<void>; cleanupOrphans(): Promise<void>;
}
```

Add these keys to `src/config.ts` and `.env.example` with positive-integer validation: `CONTACT_MAX_PENDING_FILES=10`, `CONTACT_MAX_FILE_BYTES=20971520`, `CONTACT_MAX_PDF_PAGES=50`, `CONTACT_MAX_IMAGE_PIXELS=25000000`, `CONTACT_MAX_TEMP_BYTES=1073741824`, `CONTACT_IMPORT_TIMEOUT_MS=900000`, `CONTACT_IMPORT_CONCURRENCY=1`, `CONTACT_EXTRACT_MAX_BATCHES=8`, and `CONTACT_EXTRACT_MAX_MODEL_CALLS=16`. Pass the applicable validated limits to the Python parse request and Task 9's Node batch counter; continue using the existing full-request byte-budget setting. Configuration errors mention key names only. Add a bounded queue with one active parse/extract job by default; do not reuse assessment queue if it would couple unrelated workflows.
- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-upload.test.ts tests/contact-import-lifecycle.test.ts tests/config.test.ts tests/mcp-e2e.test.ts`; expected: default/overridden limits, upload and old MCP security tests pass. Run `rtk npm run typecheck`.
- [ ] **Step 5: Commit.** Run `rtk git add src/contacts/upload-store.ts src/contacts/import-jobs.ts src/mcp/http-app.ts src/index.ts src/config.ts .env.example package.json package-lock.json tests/contact-upload.test.ts tests/contact-import-lifecycle.test.ts tests/config.test.ts` then `rtk git commit -m "feat(contacts): accept bounded authenticated file uploads"`.

## Task 9：Node 文档抽取、字段引文和候选匹配

**Files:**
- Create: `src/contacts/document-extractor.ts`, `src/contacts/identity-match.ts`
- Modify: `src/upstream/ark/client.ts` or create `src/upstream/ark/json-request.ts` for shared transport; keep the existing public-contact extractor unchanged
- Test: `tests/contact-extraction.test.ts`, `tests/contact-identity-match.test.ts`, `tests/ark-adapter.test.ts`

**Interfaces:** Consumes Docling `ParsedBlock[]`, Task 1 `ImportCandidateSchema` and existing Ark chat config. Produces `DocumentExtractor.extract(blocks,signal):Promise<{candidates,warnings,processedBlockIds,unprocessedBlockIds}>`; `suggestMatches(candidate,existing): MatchSuggestion[]` produces advice only, never writes or auto-merges.

- [ ] **Step 1: Inspect the pinned Docling Graph source and tests for structured extraction, chunk budgets, response validation, grounding and cross-chunk reconciliation.** Add a compact source→local mapping to the contract doc. Write failing tests for two people on one page, cross-page employment, invalid field quote, model prompt-injection text, 8 batches/16 requests, 12,288 UTF-8 byte request, and unsupported direct-contact extraction from the old public prompt not leaking into this new flow.

```ts
it('marks a field unlocated when quote is not in its block', async () => {
  const result = await extractor.extract([{ block_id: 'b1', text: '陈晓，销售经理', page: 1 }], signal);
  expect(result.candidates[0].evidence.find(e => e.value === 'chen@example.com')?.locator_status)
    .toBe('unavailable');
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-extraction.test.ts tests/contact-identity-match.test.ts`; expected: extractor and matcher imports fail.
- [ ] **Step 3: Build the fixed Ark extraction request.** Reuse the existing chat HTTP transport or factor its request/timeout/JSON parsing into `json-request.ts`; preserve all old Ark tests. Include schema vocabulary and block IDs in prompt, mark document text untrusted, cap complete serialized request bytes including prompt, and implement at most one retry per recoverable call while counting **every** attempt. Read `CONTACT_EXTRACT_MAX_BATCHES` and `CONTACT_EXTRACT_MAX_MODEL_CALLS` from Task 8's validated config; tests override each independently and assert no call exceeds either configured cap. Never truncate required fields silently. Invalid JSON or schema yields warning/failure, not invented values. Validate each quote is a substring of its exact block and derive page from block, not model; use candidate-local IDs for cross-block references. If budget exhausts with valid partial candidates, return their processed/unprocessed scope; otherwise fail visibly. Do not retain full block text beyond job lifetime.

```ts
export function quoteLocated(block: ParsedBlock, quote: string): boolean {
  return quote.length > 0 && block.text.includes(quote);
}
export function normalizePhoneForSuggestion(value: string): string {
  return value.trim().replace(/[\s().-]/gu, '');
}
```

Match candidates by exact known-self phone, email, platform+account, name/organization/résumé evidence. Assistant, shared and unknown-owner numbers never count as self phone; country code is never inferred, matching suffixes alone is forbidden. Show possible rename with both names and source dates but never return uncalibrated probability. Names with no corroboration remain separate.
- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-extraction.test.ts tests/contact-identity-match.test.ts tests/ark-adapter.test.ts`; expected: candidate ownership, quote validity, budget, phone exclusions and old Ark behavior pass.
- [ ] **Step 5: Commit.** Run `rtk git add src/contacts/document-extractor.ts src/contacts/identity-match.ts src/upstream/ark tests/contact-extraction.test.ts tests/contact-identity-match.test.ts docs/superpowers/specs/contact-data-contract.md` then `rtk git commit -m "feat(contacts): extract evidenced candidates from document blocks"`.

## Task 10：导入预览、修正、确认与取消

**Files:**
- Create: `src/contacts/import-service.ts`
- Modify: `src/contacts/import-jobs.ts`, `src/index.ts`, `src/mcp/tool-schemas.ts`, `src/mcp/tools.ts`
- Test: `tests/contact-import.test.ts`, `tests/contact-management-e2e.test.ts`

**Interfaces:** Produces MCP `import_contacts({file_id,operation_id})`, `get_contact_import({import_id,offset,limit})`, `commit_contact_import({import_id,preview_version,operation_id,choices})`, `cancel_contact_import({import_id,operation_id})`. Choice is `{candidate_id,action:'create'|'merge'|'skip',target_id?,set_properties?,unset_properties?,set_extensions?,unset_extensions?,keep_name?:boolean}`. The caller generates and retains the initiation `operation_id`; the same actor, file ID and ID return the original `{import_id}` after a lost response or restart. A different operation ID cannot start a second job for an already consumed file. Commit `operation_id` must equal `contact-import:<import_id>`; retries reuse it exactly. Cancellation uses a caller-generated stable operation ID because it is a separate write action.

- [ ] **Step 1: Write failing integration tests for upload→queued→processing→ready_for_review→commit, one file with multiple people, candidate correction, merge target, skip, page evidence, task pagination, cancellation, preview-version conflict, and duplicate commit after lost response.** Simulate `import_contacts` persisting its job but losing the response; resend the same actor/file/operation ID before and after Rust restart, assert the same import ID and only one job, and reject the same file under another operation ID or the same ID under another actor. Assert graph has no formal entity before commit and only candidate/short evidence is persisted at preview time.

```ts
it('does not create a formal contact before explicit commit', async () => {
  const submitted = await service.importContacts({ file_id: fileId, operation_id: 'start-import-1' }, userId);
  await service.waitForReady(submitted.import_id);
  expect(await graph.request('get_contact', { entity_id: candidateId })).toBeNull();
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-import.test.ts`; expected: tool/service unavailable.
- [ ] **Step 3: Implement import state transitions and commands.** `import_contacts` binds the uploaded file ID to a server-generated import ID and the caller's operation ID/actor in one Rust transaction; check operation replay before treating the file as consumed. A matching replay returns the stored job result without starting a second worker, including after restart; a different request for the same file conflicts. Start bounded parse/extract asynchronously, persist candidates and warnings before deleting raw artifacts, then change state to ready. `get_contact_import` returns status, source scope, indexed candidates and match suggestions; it never returns full OCR. `commit_contact_import` requires one action per candidate and expected preview version; send one `commit_import` command to Rust to write all chosen entities/relations/evidence/task status/operation result transactionally. Corrected fields add manual confirmation evidence; uncertain relations cannot be silently promoted. After success schedule vector generation; vector error must not undo the contact. `cancel_contact_import` aborts queued/processing work or cancels uncommitted review and cleans temp files; committed imports return conflict rather than disappearing.

```ts
export type ImportStatus = 'queued' | 'processing' | 'ready_for_review'
  | 'committed' | 'failed' | 'cancelled';
export interface ImportChoice {
  candidate_id: string; action: 'create' | 'merge' | 'skip'; target_id?: string;
  keep_name?: boolean;
}
```

Initial `put_import_job` creation uses the caller actor and initiation operation ID; later worker-owned state transitions use a deterministic `operation_id` including import ID and next state/version under caller `system`; `commit_import` uses the user actor and its prescribed ID. Do not infer that two candidates with the same phone must merge. For explicit rename, preserve selected entity ID and put verified old name in `alternateName`; if user did not confirm which is current, keep existing `name`. Repeated commit returns original result before preview-version check.
- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-import.test.ts tests/contact-management-e2e.test.ts` and `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml`; expected: explicit confirmation, rollback/replay, clean files and retained evidence pass.
- [ ] **Step 5: Commit.** Run `rtk git add src/contacts/import-service.ts src/contacts/import-jobs.ts src/index.ts src/mcp/tool-schemas.ts src/mcp/tools.ts tests/contact-import.test.ts tests/contact-management-e2e.test.ts rust/contact-graph` then `rtk git commit -m "feat(contacts): preview and commit imported contacts"`.

## Task 11：人工档案、关系、合并与归档 MCP 工具

**Files:**
- Create: `src/contacts/library-service.ts`, `src/mcp/contact-tools.ts`
- Modify: `src/mcp/{tools,tool-schemas}.ts`, `src/index.ts`
- Test: `tests/contact-library-tools.test.ts`, `tests/mcp-tools.test.ts`

**Interfaces:** Produces MCP `get_contact`, `save_contact`, `merge_contacts`, `delete_contact`, `save_contact_relation`, `delete_contact_relation`. Reuses Rust Task 3–4 operations; all writes include `operation_id`, `expected_version` for existing objects and actor from `context.http.authInfo.clientId`. Define `SaveContactInput` as the Task 3 save payload without actor and `SaveContactResult={entity_id:string,version:number,replayed:boolean}`; `save_contact` includes explicit restore action, with no implicit unarchive.

- [ ] **Step 1: Write failing MCP tests with two valid tokens and invalid token.** Create a Person and Organization, attach two worksFor relations to same organization, read complete history, update one contact with version, reject stale edit, merge people preserving relation IDs, archive and restore explicitly. Validate wrong endpoint type, parent/children normalization, symmetric spouse lookup, actor-scoped replay conflict and no automatic colleague inference.

```ts
it('returns two episodes at the same organization', async () => {
  const result = await callTool('get_contact', { entity_id: personId });
  expect(result.structuredContent.relations.filter((r: { relation_type: string }) =>
    r.relation_type === 'worksFor')).toHaveLength(2);
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-library-tools.test.ts`; expected: unregistered tool.
- [ ] **Step 3: Implement small service wrappers and register tools.** `library-service.ts` validates request schema, calls `GraphClient`, maps error codes to structured tool errors and never accepts actor from user input. `contact-tools.ts` centralizes only the six new registrations, called from `buildMcpServer` to avoid bloating existing `tools.ts`. `get_contact` returns fields, extensions, conflicts, evidence, versions and all relations; archive filters new library and Q&A but old `get_contacts` still queries public web. Tool descriptions distinguish shared contact library from public search, mention ID/retry rules and personal data fields. Reuse graph transaction semantics; Node does not edit graph SQL directly.

```ts
export async function saveContact(input: SaveContactInput, actor: string, graph: GraphClient) {
  return graph.request<SaveContactResult>('save_contact', { ...input, actor });
}
```

- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-library-tools.test.ts tests/mcp-tools.test.ts tests/mcp-e2e.test.ts`, `rtk npm run typecheck`; expected: new tools and old public contract pass.
- [ ] **Step 5: Commit.** Run `rtk git add src/contacts/library-service.ts src/mcp/contact-tools.ts src/mcp/tools.ts src/mcp/tool-schemas.ts src/index.ts tests/contact-library-tools.test.ts` then `rtk git commit -m "feat(contacts): expose shared graph records through MCP"`.

## Task 12：独立嵌入端点与版本安全向量写入

**Files:**
- Create: `src/contacts/embedding-client.ts`, `src/contacts/vector-indexer.ts`
- Modify: `src/config.ts`, `.env.example`, `src/index.ts`, `src/mcp/contact-tools.ts`, `src/mcp/tool-schemas.ts`, `rust/contact-graph/src/store.rs`
- Test: `tests/contact-embedding.test.ts`, `tests/config.test.ts`, `rust/contact-graph/tests/vectors.rs`, `tests/contact-library-tools.test.ts`

**Interfaces:** Produces `EmbeddingClient.embed(text,signal):Promise<{model,vector:number[]}>`, `VectorIndexer.index(entity_id,content_version)` and `VectorIndexer.retryFailed(entity_id,operation_id,actor)`, plus Rust `put_vector`/`search_vector`/`set_vector_state`. MCP `retry_contact_index({entity_id,operation_id})` explicitly requeues only a failed index and returns `{entity_id,content_version,index_status:'pending',replayed}`; `get_contact` exposes `index_status`. `set_vector_state` uses `{action:'set',operation_id,actor,entity_id,content_version,state:'pending'|'failed'}` for one current version, or `{action:'recover_interrupted',operation_id,actor}` once at Node startup to mark all interrupted `pending` rows `failed`; both forms obey operation-result idempotency. `put_vector` payload includes entity ID, model, dimension, content version and vector; succeeds only if entity active and its content version still matches. Search accepts only vectors with the same model/dimension as the query.

- [ ] **Step 1: Write failing tests for config, stale vectors and retry.** One of URL/model/credential missing disables semantic mode without failing startup; malformed configured URL is rejected; a model response with empty/nonfinite vector fails; entity edit/archive before asynchronous result arrives prevents the old vector from becoming searchable. Different model or dimension cannot be mixed. Force the first embedding attempt to fail, assert `get_contact.index_status='failed'` and keyword search still works; call `retry_contact_index` with a stable operation ID, then let embedding succeed and assert the current version becomes searchable. Replaying that retry ID returns the original pending result without a second queued job; a retry for an already ready index is rejected, and Rust `set_vector_state` rejects a stale content version. Simulate restart while a retry is pending: the interrupted attempt must become `failed`, not remain permanently `pending`.

```ts
it('keeps keyword mode when embedding configuration is incomplete', () => {
  const config = loadConfig({ ...validEnv, ARK_EMBEDDING_MODEL: '' });
  expect(config.embeddingEnabled).toBe(false);
});
it('returns the same retry acceptance after a lost response', async () => {
  const input = { entity_id: personId, operation_id: 'retry-vector-1' };
  const first = await callTool('retry_contact_index', input);
  const replay = await callTool('retry_contact_index', input);
  expect(replay.structuredContent).toMatchObject({
    entity_id: first.structuredContent.entity_id,
    content_version: first.structuredContent.content_version,
    replayed: true,
  });
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-embedding.test.ts tests/config.test.ts`; expected: embedding client/config flag unavailable.
- [ ] **Step 3: Wire the independent embedding config and API.** Add three existing `.env.example` keys to `CONFIG_KEYS` and `AppConfig` as a separate optional trio; trim empty model/credential, validate HTTPS URL, do not fall back to chat credentials. `EmbeddingClient` posts to configured `/embeddings`, validates returned numbers and measured dimension from actual response. Build input from confirmed name, description, occupation, credential, skills and role facts; omit private contact values from embedding text. On edit/merge/archive invalidate prior vector version in the same Rust business transaction; queue a bounded async rebuild. `put_vector` uses `operation_id='vector:<entity_id>:<content_version>:<model>'` with actor `system`, rechecks active ID/content version under graph transaction and records model+dimension in `vector_meta`. On embedding failure, `set_vector_state` records `failed` with a distinct attempt operation ID and leaves keyword search usable. The retry tool takes the real MCP actor and caller ID, atomically changes only the current failed version to `pending` through `set_vector_state`, and enqueues it once; after response loss, replay returns the stored acceptance before state checking. Before starting the queue on Node restart, call `set_vector_state` with `action:'recover_interrupted'`, actor `system` and one boot-scoped operation ID to mark interrupted `pending` attempts `failed`; replay the same boot ID if its response is lost. A repeated failure records `failed` with a new attempt ID, allowing another explicit retry without changing the contact. Never reuse an already committed `put_vector` operation ID with a different vector; retain a generated vector until its write response is confirmed and resend the identical payload after response loss.

```ts
const body = JSON.stringify({ model: config.ARK_EMBEDDING_MODEL, input: text });
const vector = response.data?.[0]?.embedding;
if (!Array.isArray(vector) || vector.length === 0
  || !vector.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) {
  throw new Error('Invalid embedding response');
}
```

- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-embedding.test.ts tests/config.test.ts tests/contact-library-tools.test.ts`, `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml vectors`; expected: config, failed→retry→ready, idempotent replay, stale-write and model-isolation tests pass.
- [ ] **Step 5: Commit.** Run `rtk git add src/contacts/embedding-client.ts src/contacts/vector-indexer.ts src/config.ts .env.example src/index.ts src/mcp/contact-tools.ts src/mcp/tool-schemas.ts rust/contact-graph tests/contact-embedding.test.ts tests/config.test.ts tests/contact-library-tools.test.ts` then `rtk git commit -m "feat(contacts): index and retry versioned contact embeddings"`.

## Task 13：结构化、关键词与向量检索

**Files:**
- Create: `src/contacts/contact-search.ts`
- Modify: `rust/contact-graph/src/store.rs`, `src/mcp/contact-tools.ts`, `src/mcp/tool-schemas.ts`
- Test: `tests/contact-search.test.ts`, `rust/contact-graph/tests/search.rs`

**Interfaces:** Produces MCP `search_contacts({query?,name?,organization_id?,job_title?,skill?,mode:'keyword'|'semantic'|'hybrid',offset,limit})` with `{items,total,next_offset?,mode_used,warnings}`. Rust `search_keyword` applies filters and pagination; `search_vector` calls library vector search then filters archived/stale/wrong-model results. Limit: 1–50 per page, at most two graph hops when expanding related facts.

- [ ] **Step 1: Write failing tests.** Exact name, previous name in alternateName, organization and role filters, skill, paging, two people with same name, archived exclusion, two worksFor episodes in complete view, semantic failure fallback, stale vector filtering, and cross-model mismatch. A query with only embedding config missing must still return keyword hits.

```ts
it('finds a confirmed rename through the old name', async () => {
  const result = await search.search({ query: '旧姓名', mode: 'keyword', offset: 0, limit: 10 });
  expect(result.items.map(x => x.entity_id)).toContain(stablePersonId);
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-search.test.ts`; expected: search service absent.
- [ ] **Step 3: Implement deterministic retrieval first.** Rust keyword query searches allowed display fields, alternateName, roleName and structured filters with bound SQL params; returns candidate IDs with reasons. Hybrid mode gets both sets, uses reciprocal-rank fusion with stable entity ID tie-break, and never treats vector similarity as a factual relation. Semantic mode failure returns keyword results with explicit `mode_used:'keyword'` and warning; pagination applies after dedup and archived filtering. No arbitrary SQL from tool inputs. `get_contact` still reads full relation rows for history.

```ts
export function reciprocalRank(rank: number): number { return 1 / (60 + rank); }
export function fusedScore(keywordRank?: number, vectorRank?: number): number {
  return (keywordRank === undefined ? 0 : reciprocalRank(keywordRank))
    + (vectorRank === undefined ? 0 : reciprocalRank(vectorRank));
}
```

- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-search.test.ts` and `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml search`; expected: filters, fusion, fallback and archived exclusion pass.
- [ ] **Step 5: Commit.** Run `rtk git add src/contacts/contact-search.ts src/mcp/contact-tools.ts src/mcp/tool-schemas.ts rust/contact-graph tests/contact-search.test.ts` then `rtk git commit -m "feat(contacts): search shared contacts with factual filters"`.

## Task 14：带证据的联系人问答

**Files:**
- Create: `src/contacts/contact-answer.ts`
- Modify: `src/mcp/contact-tools.ts`, `src/mcp/tool-schemas.ts`
- Test: `tests/contact-answer.test.ts`

**Interfaces:** Produces MCP `ask_contacts({question,entity_id?})` returning `{status:'answered'|'clarify'|'insufficient'|'failed',answer,citations,candidates?,facts?}`. `facts` is a bounded array of retrieved, selected graph facts `{subject_id,predicate,object,evidence_id}`; when Ark generation fails after retrieval, return `status:'failed'` with these facts and their real citations instead of inventing a prose answer. A citation names actual entity/relation, evidence ID, short quote and available source/page; response must not cite a missing or unselected fact.

- [ ] **Step 1: Write failing tests for spouse, parent/children direction, two employment episodes, same-name clarification, no evidence, conflicting sources, old status-as-of, archived person, and malicious instructions inside document quote.** A direct relation question must answer from graph facts without LLM hallucination; missing relationship returns insufficient rather than a generic fabricated answer. For a complex question with two selected supported facts, make the Ark transport throw: assert `status='failed'`, no fabricated answer, and exactly those two structured facts with matching evidence IDs/quotes. If retrieval found no supported fact, assert `facts=[]` and `status='insufficient'` even when generation is unavailable.

```ts
it('answers an explicit spouse relation with a real citation', async () => {
  const answer = await ask.ask({ question: '陈晓的配偶是谁？', entity_id: personId });
  expect(answer.status).toBe('answered');
  expect(answer.citations[0].evidence_id).toBe(savedSpouseEvidenceId);
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-answer.test.ts`; expected: service unavailable.
- [ ] **Step 3: Implement a bounded factual plan.** Recognize direct relationship/name/role questions as validated query intents, resolve exact or ambiguous entity IDs, fetch selected graph facts plus up to two hops, and render direct relation answers deterministically. For complex questions, send only retrieved bounded facts and evidence IDs to the existing Ark chat transport; parse model output, then validate every asserted citation against retrieved facts and short quote. Keep the validated bounded fact list independent of the Ark response; on timeout, transport error or unusable generation, return `status:'failed'`, a brief failure message and that list in `facts` with source citations, without a model-written answer. Missing/contradictory facts yield `insufficient` or `clarify`. `spouse` is not automatically current marital status; `alumniOf` alone cannot prove graduation; `current` role reports its as-of date. Never execute model-generated SQL or instructions from evidence text.

```ts
export type ContactAnswerStatus = 'answered' | 'clarify' | 'insufficient' | 'failed';
export interface ContactCitation { entity_id: string; relation_id?: string; evidence_id: string; quote: string; page?: number; }
export interface ContactFact { subject_id: string; predicate: string; object: string; evidence_id: string; }
```

- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-answer.test.ts tests/mcp-e2e.test.ts`; expected: direct facts, disambiguation, refusal on absent fact, model-failure structured-fact fallback and citation checks pass.
- [ ] **Step 5: Commit.** Run `rtk git add src/contacts/contact-answer.ts src/mcp/contact-tools.ts src/mcp/tool-schemas.ts tests/contact-answer.test.ts` then `rtk git commit -m "feat(contacts): answer questions from cited graph facts"`.

## Task 15：顺序批量上传 CLI

**Files:**
- Create: `src/cli/contact-upload.ts`
- Modify: `package.json`, `docs/QUICKSTART.md`
- Test: `tests/contact-upload-cli.test.ts`

**Interfaces:** `npm run contacts:upload -- <file...>` 从本地路径逐个上传到配置的 `POST /contact-files`，输出 `accepted:[{path,file_id}]` 和 `unuploaded:string[]`；遇 `CAPACITY_FULL` 以非零状态退出。Token 仅从环境变量读取，不出现在输出或命令行参数中。

- [ ] **Step 1: Write failing CLI tests.** 用本地 11 个合成文件和 HTTP 测试服务，确认前 10 个被接收，第 11 个因满额停止并列出剩余路径；403/401/损坏文件不伪装成功，成功时只输出已接收 ID。

```ts
it('reports accepted and unuploaded files when capacity fills', async () => {
  const result = await runUploadCli(files, { capacity: 10 });
  expect(result.exitCode).not.toBe(0);
  expect(result.accepted).toHaveLength(10);
  expect(result.unuploaded).toHaveLength(files.length - 10);
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-upload-cli.test.ts`; expected: CLI module not found.
- [ ] **Step 3: Implement sequential upload.** Validate local extensions and stat size before reading; construct one multipart request at a time with Node `FormData`/`Blob` and `fetch`, pass Bearer header from `CONTACT_UPLOAD_TOKEN`, and stop on capacity. Preserve order, record only successful file IDs, list paths not attempted after stop. No URL fetch or automatic wait/resume. Add `contacts:upload` package script and a concrete invocation in QUICKSTART.

```ts
export interface UploadSummary {
  accepted: Array<{ path: string; file_id: string }>;
  unuploaded: string[];
  exitCode: number;
}
```

- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-upload-cli.test.ts`, `rtk npm run typecheck`, `rtk npm run build`; expected: CLI tests pass and built script starts.
- [ ] **Step 5: Commit.** Run `rtk git add src/cli/contact-upload.ts package.json package-lock.json docs/QUICKSTART.md tests/contact-upload-cli.test.ts` then `rtk git commit -m "feat(contacts): add sequential local upload CLI"`.

## Task 16：固定质量样本与真实模型评测

**Files:**
- Create: `tests/fixtures/contact-evals/annotations.json`, `scripts/evaluate-contacts.ts`
- Expand: `tests/fixtures/contact-documents/` to exactly 12 synthetic documents
- Modify: `package.json`, `docs/validation/contact-management-quality.md`
- Test: `tests/contact-evaluation.test.ts`

**Interfaces:** `npm run contacts:evaluate` 调用真实服务并输出逐样本结果、微平均精确率/召回率、Top-5 召回与问答结果；保存 Docling/OCR、聊天/嵌入端点、提示词、契约和样本版本。此命令是发布门槛，不是常规无凭据单元测试。

- [ ] **Step 1: Write failing scorer tests.** 4 份文字 PDF、4 份扫描简历 PDF、4 份 JPG/PNG 名片覆盖中英文、同名、多人物、多段任职、多联系方式、缺失信息与 OCR 错误；人工标注清晰字段、所属人/组织、页码与短引文。再标注 10 个语义检索及 10 个问答，包含澄清、证据不足、错误引用与文档夹带指令。固定计分规则必须把遗漏记 FN、错误输出记 FP、伪造关系/引用记硬失败。报告逐例标出跨页、多人物归属和证据定位错误，使原方案规定的条件比较能够由具体失败案例触发，而非主观判断。

```ts
it('fails the quality gate when a citation does not support its claim', () => {
  const result = scoreAnswer({ status: 'answered', citations: [{ evidence_id: 'missing' }] }, truth);
  expect(result.passes).toBe(false);
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-evaluation.test.ts`; expected: scorer import missing.
- [ ] **Step 3: Implement deterministic scorer and real-run script.** Exact field comparison preserves phone country code/extension and date precision; only documented whitespace/Unicode equivalences are allowed for names, organizations and titles. Set thresholds: precision ≥95%, recall ≥90%, ≥9/10 semantic targets in top five, all 10 Q&A statuses correct, zero fabricated relation/citation. Record per-case failures rather than aggregate-only pass. No real personal data in fixtures. Script must exit nonzero when any gate fails and save reproducible version identifiers. If fixed samples show cross-page assignment, multi-person ownership or evidence-location complexity preventing the gate, run a one-time comparison with pinned Docling Graph using the same samples, Ark model and 8-batch/16-call budget; write both sides' precision, recall, evidence correctness, elapsed time and call count to `docs/validation/contact-management-quality.md`, including the chosen next action. Do not add Docling Graph to the production runtime or implement an automatic backend switch.

```ts
export function precision(tp: number, fp: number): number { return tp / Math.max(1, tp + fp); }
export function recall(tp: number, fn: number): number { return tp / Math.max(1, tp + fn); }
export function extractionPass(tp: number, fp: number, fn: number): boolean {
  return precision(tp, fp) >= 0.95 && recall(tp, fn) >= 0.90;
}
```

- [ ] **Step 4: Verify.** Run `rtk npm test -- --run tests/contact-evaluation.test.ts` for scorer logic, then `rtk npm run contacts:evaluate` with real configured endpoints; expected: all gates pass and report is saved. If the specified complexity cases block a gate, check that the same-budget Docling Graph comparison and decision are recorded before any readiness claim. If credentials unavailable, mark this gate unverified in the validation document and do not assert production readiness.
- [ ] **Step 5: Commit.** Run `rtk git add tests/fixtures/contact-documents tests/fixtures/contact-evals scripts/evaluate-contacts.ts tests/contact-evaluation.test.ts package.json package-lock.json docs/validation/contact-management-quality.md` then `rtk git commit -m "test(contacts): add fixed extraction and answer quality gates"`.

## Task 17：完整回归、容器与发布验收

**Files:**
- Modify: `Dockerfile`, `.github/workflows/publish-image.yml`, `README.md`, `docs/QUICKSTART.md`, `tests/lifecycle.test.ts`, `tests/contact-management-e2e.test.ts`

**Interfaces:** Docker image includes built Node app, pinned Rust graph worker and locked Python/Docling/OCR runtime for `linux/amd64` and `linux/arm64`; `/data` and private temp path writable by non-root user. The feature flag remains default-off. Existing GHCR tag flow is preserved.

- [ ] **Step 1: Extend failing end-to-end and lifecycle tests.** Exercise two valid tokens and an invalid token through real HTTP/MCP + Rust + Python with a stubbed Ark: upload→parse→review→commit→search→ask→edit→merge→archive→restore. Simulate process crash, late vector response, ninth batch, 17th model call, temp overrun and 11th upload; assert no raw artifacts/logged body remain and old `get_contacts` still exposes only public role data.

```ts
it('leaves the legacy public-contact response unchanged', async () => {
  const old = await callTool('get_contacts', { query: '示例科技' });
  expect(JSON.stringify(old.structuredContent)).not.toMatch(/telephone|email|instantMessaging/);
});
```

- [ ] **Step 2: Verify red.** Run `rtk npm test -- --run tests/contact-management-e2e.test.ts tests/lifecycle.test.ts`; expected: full worker lifecycle or image assumptions fail until wired.
- [ ] **Step 3: Finish packaging and operator docs.** Docker multi-stage build compiles pinned Rust crate for target architecture, installs locked Python dependencies and OCR resources, copies only runtime files, runs as non-root, and configures `/data`/temp write access. Preserve `linux/amd64,linux/arm64` GHCR workflow; add pre-push smoke stage that checks actual Docling OCR, graph insert/query and cleanup. README/QUICKSTART document the new feature flag, independent embedding trio, configurable import limits, `retry_contact_index` for failed indexes, CLI commands, dry-run/backup migration, restarting interrupted jobs, and separation of old public search from shared library.

```dockerfile
# Final image must contain these runtime paths, with no writable source checkout.
COPY --from=rust-build /build/target/release/contact-graph /usr/local/bin/contact-graph
COPY --from=node-build /app/dist /app/dist
ENV CONTACT_GRAPH_BIN=/usr/local/bin/contact-graph
```

- [ ] **Step 4: Verify all gates.** Run `rtk npm test -- --run`, `rtk npm run typecheck`, `rtk npm run build`, `rtk cargo test --manifest-path rust/contact-graph/Cargo.toml`, `rtk proxy uv run --project python pytest python/tests -q`, and `rtk npm run contacts:evaluate`. Build and smoke both `linux/amd64` and `linux/arm64` images with Docling OCR, graph insert/query and non-root temp cleanup. Run one real Ark extraction plus one real embedding call; if unavailable, report the gate as unverified and do not claim production readiness.
- [ ] **Step 5: Commit.** Run `rtk git add Dockerfile .github/workflows/publish-image.yml README.md docs/QUICKSTART.md tests/lifecycle.test.ts tests/contact-management-e2e.test.ts` then `rtk git commit -m "build(contacts): package and verify the full contact runtime"`.

## Self-review and task handoff

Coverage map: Task 1 implements the ontology, extension, evidence and import contracts; Tasks 2–4 implement the required Rust library, stable IDs, transaction and relationship semantics; Tasks 5–6 integrate a serial process and old snapshot replay; Tasks 7–10 implement Docling parsing, authenticated upload, bounded Ark extraction and explicit import confirmation; Task 11 exposes shared editing/merge/restore tools; Tasks 12–14 implement independently configured vectors, search and cited answers; Task 15 adds the local CLI, Task 16 enforces fixed quality thresholds, Task 17 closes deployment, cleanup, cross-process and real-model release gates. The old `get_contacts` regression appears in Tasks 6, 8, 11 and 17.

Before executing any task: read the Spec and this task’s interfaces; keep unrelated existing workspace modifications intact. At each task end, review its diff and test result before committing. A failing real-model or dual-platform gate blocks a readiness claim, even if deterministic unit tests pass.
