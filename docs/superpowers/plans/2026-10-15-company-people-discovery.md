# 企业公开人物发现增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强现有 discover_contacts，使其发现企业公开职业人物，不再限定负责人、部门或七产品，并安全保留空职位及待核实关联。

**Architecture:** 沿用搜索 → Ark → Node SQLite 快照 → 现有图谱同步；移除角色硬门槛，增加必要的短证据与归属状态，先完整保存有效观察再分页。TS 与 Rust 同步适配，不增加平台、表或外部数据源。

**Tech Stack:** 现有 Node.js 24、TypeScript、Zod、SQLite、Ark/豆包搜索、Rust contact-graph、Vitest。

**Spec:** [企业公开人物发现增强设计](../specs/2026-10-15-company-people-discovery-design.md)。执行者先完整读取设计及 AGENTS.md。

## Global Constraints

- 只增强现有工具；不另建平台、MCP 工具、表、人物评分、部门分类、七产品联动、持续监测或爬虫。
- Zoho 查询与全量返回、Owner、隐私和同步语义不变；网页不返回电话、邮箱、微信或私人生活资料。
- `employment_evidence` 不等于当前在职；`unverified` 不生成正式任职边；不凭同名同公司自动合并。
- 使用已有配置约束，本功能最多豆包 8 次、Ark 8 次、总计 16 次，重试计数，墙钟 120 秒；不增加用户配置。
- 保留 30 天缓存与原查询/地域缓存键；移除十条人物和三组公司截断，用现有快照 ID 固定网页分页，不新建表或游标体系。
- 待核实任职线索使用现有审核入口的 properties/metadata 包裹形状；验收仅限人物侧回读，不新增机构侧反查或图谱 UI。
- 保留图谱 256 KiB 帧和既有游标语义；单快照超限明确失败，不扩展续传协议。
- 不允许本地构建，包括 Rust 编译测试、npm build/dev 和 Docker。构建/native gate 必须在远程 CI；真实调用另获企业与费用授权。

## 文件职责

| 文件 | 必要改动 |
| --- | --- |
| `src/contracts/contact.ts` | 空职位、可选新版证据、归属状态、coverage，去十条/三组限制；兼容旧存储 |
| `src/mcp/tool-schemas.ts`、`src/mcp/tools.ts` | 网页快照 ID 与分页输入/输出、可读文本、空职位及证据展示，Zoho 分支不变 |
| `src/upstream/search/contact-search-plan.ts` | 四种人物材料查询，可接受已有确认身份的名称作为内部参数 |
| `src/upstream/ark/contact-extractor.ts` | 新 prompt、薄结构解析、材料分批、逐批失败与覆盖统计 |
| 新 `src/upstream/ark/contact-materials.ts` | 仅做连续段落切分、UTF-8 请求装箱和页间轮换，不抽人物或评分 |
| `src/contacts/contact-service.ts` | 编排、CallBudget、120 秒信号、原文验证及降级，不再按角色/职级过滤 |
| `src/contacts/contact-cache.ts`、`src/db/contact-snapshot-repository.ts` | 绑定快照及历史上界读取、新旧快照投影、观察去重、无十条/三组截断、旧格式刷新判断 |
| `src/upstream/search/doubao-client.ts`、`src/index.ts` | 可选请求 signal 传递、本地 ProfileRepository 查找、预算参数与日志接线 |
| `src/contacts/snapshot-sync.ts`、`rust/contact-graph/src/snapshot_sync.rs` | 传递新证据，空职位，按归属决定任职/线索，保留幂等与帧错误 |
| `rust/contact-graph/src/claims.rs` | 仅扩展带网页快照定位的待核实任职线索，不移除原来源限制 |
| `docs/PRD.md`、联系人 skill 引用 | 更新现有能力声明、分页与线索解释，不写尚未通过的验收 |

不重构上传、Docling、七产品评分、Zoho SDK 或图谱布局。

## Task 1：先定义观察契约与兼容投影

**Files:** Modify `src/contracts/contact.ts`, `src/contacts/contact-cache.ts`, `src/db/contact-snapshot-repository.ts`, `src/contacts/contact-service.ts`, `src/mcp/tools.ts`；Test `tests/contacts.test.ts`, `tests/mcp-tools.test.ts`，Create `tests/contact-discovery-contracts.test.ts`。

**Interfaces:**
- 本任务先只扩展持久化/返回契约，抽取模型契约在 Task 2 原子替换，避免中间步骤删除旧角色字段使调用者无法编译。
- `PublicContactSchema` 的新增字段见设计；只有新记录要求状态和引用，旧记录可缺省，不给旧记录静默填“已核实”。
- 快照增加可选 coverage；不做 SQL 表迁移。`projectContactHistory` 返回全部有效当前与历史观察，不切页；分页与绑定主快照属于 Task 3。所有原文公司名按设计第 5.2 节分组，未经确认不因同品牌或去后缀合组。

- [ ] 新建契约测试，从现有模块导入 `PublicContactSchema`、`ContactSnapshotPayloadSchema`，先测空职位和超过十条。

```ts
import { expect, it } from 'vitest';
import { PublicContactSchema, ContactSnapshotPayloadSchema } from '../src/contracts/contact.js';

const observedAt = '2026-10-15T00:00:00.000Z';
it('keeps a located person without inventing a title', () => {
  const person = { name: '林知远', title: null, source_url: 'https://example.test/team',
    published_at: null, affiliation_status: 'unverified',
    evidence_quote: '示例公司的林知远参加了活动。' };
  expect(PublicContactSchema.parse(person)).toEqual(person);
});
it('stores more than ten observations without truncation', () => {
  const contacts = Array.from({ length: 12 }, (_, i) => ({ name: `示例人员${i}`,
    title: '工程师', source_url: `https://example.test/${i}`, published_at: null }));
  expect(ContactSnapshotPayloadSchema.parse({ companies: [{ company_name: '示例公司', contacts }],
    warnings: [], collected_at: observedAt }).companies[0]!.contacts).toHaveLength(12);
});
```

- [ ] 运行 `npx vitest run tests/contact-discovery-contracts.test.ts`，确认因旧 Schema 拒绝空职位/十二条而失败。
- [ ] 更新持久化 Schema 和 TS 类型；保留 DirectContactPattern 等边界。同步接通 ContactServiceOutput 的空职位和可选新字段、tools 映射及空值显示，使所有调用者可编译，但先不改变旧抽取流程。新记录短证据必须可安全保存，电话/邮箱不得通过 quote 混入。
- [ ] 修改 `contact-cache.ts` 的观察键，包含来源、引用、归属，删除历史 `.slice(0,10)`；兼容旧记录缺少新字段，历史状态仍为 historical_evidence。增加 12 条历史观察、多来源同名不丢失、null 与真实职位不混同、旧快照读取测试。
- [ ] 同时删除快照/输出 Schema 的公司数组 `.max(3)`、ContactService 的第三组后 continue，以及历史投影的第三组后 break。测试四组原文公司名各有有效观察的保存/投影，及最新快照不足三组但历史存在第四组的情况；均不得截断。所有 company_name 保留原文规范化分组；Profile 仅作上下文与校验，不归到法定名称或改变稳定观察身份，分组不是人物合并。
- [ ] 运行两份定向测试和 `npm run typecheck`，更新受新类型影响的旧测试桩。预期通过；不得以删除隐私或历史行为测试来消除类型错误。
- [ ] 在执行获准后按本任务文件提交一个独立契约变更，不自动推送。

## Task 2：四组搜索与有界材料抽取

**Files:** Modify `src/upstream/search/contact-search-plan.ts`, `src/upstream/search/doubao-client.ts`, `src/upstream/ark/contact-extractor.ts`, `src/contacts/contact-service.ts`, `src/index.ts`；Create `src/upstream/ark/contact-materials.ts`, `tests/contact-materials.test.ts`；Test `tests/contacts.test.ts`, `tests/doubao-search.test.ts`。

**Interfaces:**
- `ContactExtractionCandidate` 在本任务移除 `roleCategory/sourceType`，增加 `affiliationStatus`、`evidenceQuote`、`sourceChunkId`，`title: string|null`；companyName/name/sourceUrl 保留，同步修改依赖与测试桩，不保留运行时角色门槛。
- 保留 `buildContactSearchPlan(query, regionHint?)`，第三个可选内部参数是 `IdentityProfile`，只由本地唯一法定名称缓存查找提供，不新增 MCP 参数或 QCC 调用。
- `ContactSearchDependency.searchWeb(query, signal?: AbortSignal)`；`ContactExtractorDependency.extract(items, options?: {signal?: AbortSignal; budget?: CallBudget})`，保留旧注入桩可调用。budget 由 ContactService 统一创建；生产 extract 内按实际 HTTP 尝试消耗 Ark 配额，外层不再整批 retry，以免重复收费。
- `DoubaoSearchClient.searchWeb(query, signal?)` 把请求级信号和已有应用关闭信号组合传至 request/fetch；不改变现有 `search()` 使用方式。
- `splitContactMaterials(items, maxTextBytes)` 返回带 `{id,url,title,originalPublisher,publishedAt,text,start,end}` 的片段数组；`packContactMaterials(chunks,requestMaxBytes,measureBytes)` 返回 `{batches,unpackable}`，measureBytes 是调用方实际序列化请求的测量函数，unpackable 包含片段 ID 与原因。两函数只服务联系人，不依赖七产品研究。

- [ ] 在已有 `tests/contacts.test.ts` 的 `service/webResult/candidate` 辅助函数旁加入普通员工和归属待核实样例；修改 candidate 默认值为新版字段。

```ts
it('keeps a non-manager with located employment evidence', async () => {
  const quote = '测试制造有限公司的行政专员赵六分享了工作经验。';
  const page = webResult({ summary: quote, content: null });
  const chunks = splitContactMaterials([{ ...page, queryIndex: 0 }], 3000);
  const result = await service({ searches: [[page], [], [], []], extracted: [candidate({
    name: '赵六', title: '行政专员', affiliationStatus: 'employment_evidence',
    evidenceQuote: quote, sourceChunkId: chunks[0]!.id, sourceUrl: page.url,
  })] }).get({ query: '测试制造有限公司' });
  expect(result.companies[0]!.contacts[0]).toMatchObject({ name: '赵六', title: '行政专员' });
});
```

片段 ID 固定为 `q<queryIndex>-p<pageIndex>-c<chunkIndex>`；pageIndex 是该查询结果按 position、URL 稳定排序后的零基页序号，而非上游可能重复的 position。测试从新 helper 导入 splitContactMaterials，不依赖手写 ID。ContactExtractor 内的真实抽取和片段引用校验复用同一份内部材料计划；ContactService 不重新生成片段编号，只对返回观察做字段、来源、主体与隐私校验。

- [ ] 先运行测试确认旧版角色门槛拒绝，再移除 roleMatches/hasLeadershipLevel 及来源类别准入。发布方作为依据，不是“官方微信”即自动可靠；不泛化来源白名单。
- [ ] 实现四组搜索，首轮每组十条、最多两并发；原文企业名称与已确认法定名称分开，不用原查询词给每条人物自动归属。
- [ ] 实现新 LLM prompt：抽取全部职业人物，title 可以 null，来源必须在输入，明确外部人员排除。代码验证片段、引用和原文字段；无效条目逐条拒绝，整批坏 JSON 才算批次失败。移除抽取结果 `.max(100)` 的人数门槛；模型输出因长度中断视为批次未完成，不宣称已处理完整。Ark 输出仍有薄 JSON Schema，不以正则抽姓名/职位。
- [ ] 实现材料切分：以段落为边界，长段切分，保留前片段最多 120 个 Unicode 字符作为重叠上下文；空正文用摘要。正文片段目标 3000 UTF-8 字节，元数据导致最终请求超限时继续缩小片段，不丢内容；无法容纳最小片段时明确 INPUT_TOO_LARGE。保留 title、发布方和 URL，不把查询词当原文。
- [ ] 对重复 URL 合并完全重复段落，非重复文本保留；不按产品/职位关键词筛段。按页轮换打包。相同引用跨重叠片段只生成同一观察，不能按姓名去重。
- [ ] 添加首段无姓名、末尾有姓名、跨片段归属、不同人字段散落同页不能拼接、Unicode、多个查询同页、长 URL 无法装箱、超过请求字节和 prompt 注入测试。
- [ ] 统一调用预算和 120 秒 AbortSignal；每个真实搜索/模型重试均计数，失败批次不重放成功批次。保留成功观察，覆盖不足记录未处理页面和片段数量；没有任何成功抽取批次时不缓存成新鲜空结果。
- [ ] 定向运行 `npx vitest run tests/contacts.test.ts tests/contact-materials.test.ts tests/doubao-search.test.ts` 和 `npm run typecheck`。用 fake timers/可控 fetch 验证超时后停止派发及计数，不等待真实 120 秒。
- [ ] 在执行获准后提交本任务，不自动推送。

## Task 3：缓存升级、网页分页和可读输出

**Files:** Modify `src/contacts/contact-service.ts`, `src/contacts/contact-cache.ts`, `src/db/contact-snapshot-repository.ts`, `src/mcp/tool-schemas.ts`, `src/mcp/tools.ts`, `src/index.ts`；Test `tests/contacts.test.ts`, `tests/mcp-tools.test.ts`, `tests/zoho-contact-contracts.test.ts`, `tests/zoho-contacts.test.ts`。

**Interfaces:**
- MCP 输入新增 `web_offset?:number`、`web_limit?:number`，默认 0/50，以及 `web_snapshot_id?:number`（正安全整数）；有 offset>0 时必须携带 ID。`ContactService.get` 对应可选 `webOffset/webLimit/webSnapshotId`；缓存键不含这些参数。
- 服务输出新增 `webPage:{snapshotId,offset,limit,total,nextOffset}` 及 `webCoverage:coverage|null`，tools 转成 `web_page`（snapshot_id 使用 snake_case）、`web_coverage`。GetContactsOutputSchema 的这两个字段保持可选以供内部未分页投影及纯 Zoho 分支使用；实际网页成功响应必须携带，不能丢掉 coverage。companies 仍承载分页后的当前/历史观察，不新造第二套人物列表。
- `ContactSnapshotRepository.findThroughSnapshot(cacheKey,snapshotId)` 返回同一缓存键下 snapshot_id<=绑定 ID 的既有快照，未找到绑定行返回 null。`projectContactHistory(inputSnapshots,anchorSnapshotId?)` 在有 anchor 时以该行作为主快照、之前的行作为历史，不重新挑最新行；省略 anchor 保留内部旧用法。
- 无 ID 的第 0 页选缓存或刷新并返回实际主快照 ID，绑定页不刷新。带 ID 先校验查询/地域缓存键，再投影全部观察并按设计固定排序分页；绑定资料超过 30 天仍可读，带历史资料警告，不能刷新原采集时间或延长新鲜缓存期限。旧缓存回退也返回实际 ID 并可固定续页，不静默换新快照、不新增读取过期机制。

- [ ] 更新 MCP 桩以覆盖以下实际输入输出，新增失败测试后再实现。

```json
{
  "input": {"query":"示例公司","source":"web","web_snapshot_id":7,"web_offset":50,"web_limit":50},
  "expected_web_page": {"snapshot_id":7,"offset":50,"limit":50,"total":63,"next_offset":null},
  "expected_returned_observations":13,
  "expected_additional_search_calls":0,
  "expected_additional_model_calls":0
}
```

- [ ] 单测 63 条观察完整保存、两页取回完全相同集合、跨四组公司分页不丢记录、空结果、负 offset、过大 limit、越界页和无缓存直接翻页。`total` 为观察数，文本不称独立人数。
- [ ] 增加快照绑定测试：第 0 页返回 ID 7 后插入同缓存键 ID 8，携带 7 的后续页仍保持原 total、分组及集合；旧缓存回退后他人新版刷新也不改变绑定结果。仓库读取和投影都不得纳入大于绑定 ID 的历史行。
- [ ] 缺少续页 ID、ID 不存在或查询/地域不匹配时明确报网页分页错误，提示从第 0 页重新发起；以上路径不调用上游。正 ID 的第 0 页重读同样不调用上游。测试超过 30 天的 ID 仍可分页读取、total 和 next_offset 正确、历史资料警告保留，且不更新采集时间或自动发起刷新。
- [ ] 缓存测试：旧格式即使未满 30 天也尝试新版刷新；失败回退旧格式并警告；新版命中不调用上游；singleflight 保留；页参数不污染缓存键；null 职位不导致排序报错。
- [ ] 更新 `contactsOutput`、`renderWebContacts`，姓名、职位未知、归属待核实、来源/日期、短依据及分页清晰可读；网页默认分支也给可读文本和 structuredContent，不仅 source=all 有 Markdown。
- [ ] `source=all` 保留网页与 Zoho 独立区域，网页失败不擦除 Zoho。纯 Zoho 拒绝显式传入的网页分页参数（含 web_snapshot_id），不能因给 web_offset/web_limit 填默认值误拒正常 Zoho 调用；all 的网页分页不截断 Zoho 结果。Zoho 的 title 可空和 Owner 沿用其独立 Schema。
- [ ] 新增引用/URL/日志的联系方式泄漏回归；输入模型返回额外 phone/email 字段仍拒绝，不记录原始输出。
- [ ] 运行 `npx vitest run tests/mcp-tools.test.ts tests/zoho-contact-contracts.test.ts tests/zoho-contacts.test.ts tests/contacts.test.ts` 和 `npm run typecheck`，再按执行授权提交。

## Task 4：Rust 空职位与网页待核实线索

**Files:** Modify `src/contacts/snapshot-sync.ts`, `rust/contact-graph/src/snapshot_sync.rs`, `rust/contact-graph/src/claims.rs`；Test `tests/contact-snapshot-sync.test.ts`, `rust/contact-graph/tests/snapshot_sync.rs`, `rust/contact-graph/tests/claim_review.rs`, `rust/contact-graph/tests/zoho_sync.rs`。

**Interfaces:**
- `sync_snapshots` op、游标和 operation_id 不变；Contact 的 title 改为 `Option<String>`，归属/引用字段可选以接收旧帧。
- 对新帧只按 `affiliation_status` 决定是否创建 worksFor；空 title 时不写 jobTitle/roleName。新线索写现有 contact_claims，`import_id=NULL`、`kind=relation`、`relation_type=worksFor`、`status=unverified`，来源含 `source_type=web/snapshot_id/source_url/quote/collected_at`，candidate_id 用稳定观察标识。
- 所有新版观察（包括明确任职）使用查询、原文公司名、来源 URL、姓名及引用的稳定观察键；仅同来源观察映射可复用既有人物。旧格式保留原分支，不用旧姓名键自动认领新版人物；遵循设计第 6 节归档、人工合并目标解析及已处理线索行为。不同页面的同名同公司同职位不自动合并。

- [ ] Rust `snapshot_sync.rs` 测试中复用现有 `snapshot/initialize/sync/count`；新增空职位与无正式任职边测试。

```rust
#[test]
fn unverified_web_observation_is_saved_without_employment_edge() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    initialize(&store);
    let mut observed = snapshot(1, "", "query-a");
    observed["companies"][0]["contacts"][0]["title"] = Value::Null;
    observed["companies"][0]["contacts"][0]["affiliation_status"] = json!("unverified");
    observed["companies"][0]["contacts"][0]["evidence_quote"] = json!("甲公司张明参加了活动。");
    let result = sync(&store, 1, 1, vec![observed]);
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(count(&store, "relation_ids"), 0);
    assert_eq!(count(&store, "contact_claims"), 1);
}
```

- [ ] 先在远程 CI 证明旧实现拒绝该帧或写错关系，再修改 Contact 解析和 validate/apply_snapshot；不能在本地跑 cargo。
- [ ] 用与现有 migration 相同方式更新触发器，不建表：只有完整网页快照来源的 worksFor 待核实线索可绕过 import_id 非空；伪造来源、缺少定位、其他 relation_type、超 2048 字节仍拒绝。保留 Zoho 重复线索的既有准入与 file/text 外键保护。
- [ ] 增加实际 Rust SQLite 测试：明确任职无职位从人物侧可读回；来源 quote 可读回；待核实线索通过 get_contact(person_id) 可查；重放/相同观察刷新不增节点或线索；已处理不重开；同名不同源不合并；归档不恢复；失败事务不推进 cursor。本轮不改 store.rs 的机构入向线索查询，不增加图谱 UI 反查任务。
- [ ] 线索 value_json 使用现有审核包裹形状：`{"properties":{"role":{"@type":"OrganizationRole"}},"metadata":{"employment_status":"unknown"}}`，有原文职位才在 properties.role 加 roleName；reason 记录归属未确认原因。不得将 role 放顶层或捏造当前在职状态。首次人工确认仍要求 confirmation_note，重复处理沿用已有状态和 operation_id 幂等约束，不由同步自动确认。
- [ ] 对已有记录执行“写待核实线索 → get_contact(person_id) → review_contact_claim(action=confirm, confirmation_note=...)，不传 corrected_value → 再 get_contact(person_id)”；断言确认成功、空职位不被补造、正式 worksFor 的 metadata.employment_status=unknown。另测 action=reject 不产生正式边及重复同步不重开，避免靠测试传修正 JSON 掩盖持久化形状错误。
- [ ] 对过长来源先降低安全短引用，仍超限则保持 Node 快照完整，图谱明确报错，不能截坏 URL 或以成功空帧推进游标。测试单快照超过 256 KiB 的既有显式失败路径，不扩展传输协议。
- [ ] TS 解释器测试运行 `npx vitest run tests/contact-snapshot-sync.test.ts`。远程 CI 执行 `cargo test --locked --manifest-path rust/contact-graph/Cargo.toml --test snapshot_sync --test claim_review --test zoho_sync`，并核对该次 tested SHA；需要匹配 Rust 二进制的全套测试只在 CI 运行。
- [ ] 按执行授权提交本任务；不能以 mock GraphClient 通过代替真实 Rust gate。

## Task 5：文档、回归和真实效果验证

**Files:** Modify `docs/PRD.md`, `skills/salestools-contact-management/SKILL.md`；Create `skills/salestools-contact-management/references/web-discovery.md`；Test 以上 TS/Rust 文件及现有 MCP/图谱回归。

**Interfaces:** skill 说明 query/source 保持、网页分页携带首次返回的 web_snapshot_id、不再只找负责人、历史与当前状态的区别；人物侧可回读线索及已确认关系，UI 复用既有联系人图谱，不新增 MCP App 或机构侧线索反查。

- [ ] 更新 PRD 的工具表、网页发现与缓存小节，移除十人、三组公司、五类负责人、无职位必排除的旧约束，补快照绑定和人物侧验收范围。只修正本轮相关文本；Zoho 正文中历史取舍与当前行为冲突需按已实现代码说明，不扩展权限或业务。
- [ ] skill 主入口保持精简，网页细节放一个引用文件。明确先确认公司歧义、依 coverage/warnings 解释结果、翻页带原 ID 且不重新发现、无效绑定需从第 0 页重新开始、超过 30 天只能称历史资料，以及正式/待核实/旧规则区别；不把“完整处理本次材料”说成“全体员工”。
- [ ] 本地运行定向解释器测试、`npm run typecheck`、`git diff --check`；运行前核对所有命令不触发构建。现有远程 CI 验证完整 TS、Rust、MCP App bundle 和容器，禁止新增本机编译捷径。
- [ ] 执行真实查询前请求一个目标企业及真实调用授权，同时准备该企业至少一篇已知含非高管人物的公开文章。未获授权不执行；文章无法取得则记录，不绕过访问限制。
- [ ] 记录旧/新输出、来源 URL/日期、普通员工及无职位观察、错误归属、未处理材料、调用次数/耗时、入快照与图谱回读；凭原文人工核对，不用“返回更多”代替质量通过。原始文章只用于授权测试现场，不进入普通日志或公开仓库。
- [ ] 真实验收必须覆盖“发现 → 保存快照 → 携带同一快照 ID 分页读回 → 已启用图谱的人物侧回读”，且记录环境版本、SHA。图谱关闭时只验证前半链路并明确未验图谱，不能称完整通过；不要求新增机构侧待核实线索查询。
- [ ] 单快照超帧、公众号正文不可读、图片名单、搜索未覆盖均列为已知限制；如真实样本触发超帧导致验收不完整，先报告并单独讨论最小修正，不静默发布。
- [ ] 完成后提供 diff、各 gate 与真实结果。用户未授权提交/合并/发布时只交付工作区变更，不自动操作。

## 当前交付状态

2026-10-15 已按执行授权在独立 worktree 的 codex/company-people-discovery 分支开发。Task 1–5 的实现与文档已补齐，分任务审查及独立 skill 行为测试通过；本地十份定向测试共 230 项通过，类型与 Rust 语法格式检查通过。测试使用合成资料及 Node 内存 SQLite，不代表真实上游或 Rust 运行验收。

Task 4 Rust 实现与 Store 用例已写，静态审查已通过；TS 同步回归 9/9，Rust 未编译、Store 用例未执行，远程 RED/GREEN 和完整 gate 未验。真实企业、真实上游及真实图谱闭环仍待授权与验收。本轮集成仅限用户授权的本地 main 提交合并，不推送、不发布；不得称已部署或全部 gate 通过，最终提交状态以 Git 记录为准。
