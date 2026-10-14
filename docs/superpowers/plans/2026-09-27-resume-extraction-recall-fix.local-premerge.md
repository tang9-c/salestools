# 简历联系人提取召回修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PDF 简历中可核实的信息尽量进入联系人图谱；证据不足但有用的线索也写入同一个图数据库，关联到人物并标记为待核实，不因一个坏字段丢掉整个人物。

**Architecture:** 沿用 Docling → LLM 候选 → `import_jobs.data_json` 预览 → 人工确认 → SQLite 图谱的现有链路。抽取器逐字段区分“可定位证据支持”和“待核实”，前者放入现有 `properties`／`extensions` 并可提交，后者放入候选的 `review_items`。提交时在同一 SQLite 事务中，把后者写入图数据库内新增的 `contact_claims` 表，以 `subject_id` 关联正式 `Person`／`Organization`，记录 `status='unverified'`、原因、来源和原值；它们不冒充已确认的实体属性或正式边。`get_contact` 可显示这些线索；`search_contacts` 通过显式参数检索它们，并在结果中标记匹配状态。确认后再提升为正式字段或关系。

**Tech Stack:** TypeScript、Zod、Vitest、Rust、SQLite/sqlite-knowledge-graph、现有 Docling 解析器与 Ark LLM。

**Spec:** [联系人数据契约](../specs/contact-data-contract.md)；本计划针对真实简历测试暴露的逐字段拦截、结构化关系遗漏和同一人物跨批分裂。

## Global Constraints

- 保留现有 `Person`、`Organization`、Schema.org 字段名和关系类型，不新增“求职意向”之类的正式图谱属性。
- 不把待核实线索写进正式 `Person.properties`、`Organization.properties` 或 `kg_relations`；同一图数据库的 `contact_claims` 是关联到实体的候选断言，不改变 Schema.org 节点和关系类型。身份匹配、向量索引和联系人问答只消费已确认事实。
- `get_contact_import(import_id)` 在提交后仍可读取该导入的全部线索；已关联到正式实体的待核实项同时出现在 `get_contact` 的 `unverified_claims`。`search_contacts(include_unverified=true, mode='keyword')` 才搜索这类项，并以 `match_status='unverified'` 标明；默认搜索语义不变。
- 审核人须显式确认线索，正式字段／关系才会写入图谱；拒绝后候选断言不再出现在待核实列表。不能把“点击提交”解释成自动确认所有低置信字段。
- 文件哈希、页码和最长 500 字符的短引文可留在预览；原 PDF、完整 OCR 文本、模型请求正文和真实个人资料不得进入测试仓库或日志。
- 仅对同一文件内部做保守归并；同名、同学校或同公司本身不足以跨文件自动合并。原有匿名人物最低资料要求、多人归属保护、事务幂等与版本检查继续有效。

## 已确认的问题与取舍

真实 5 页简历解析完成，但抽取结果出现同一人物分批、技能引文不足导致整人 `can_commit=false`、求职意向被写成 `jobTitle`、项目术语被误标组织，以及工作／教育标题未形成关系建议。当前 `document-extractor.ts` 对整批模型输出、整位候选和每条关系存在多个“全有或全无”的关口；Rust `ensure_value_evidence` 又会拒绝把无定位证据的值当成正式事实。这道正式写入约束应保留。

比较三种做法：直接放宽图谱证据校验最省代码，但搜索和问答会把猜测当事实；把待核实内容建成新的图节点／真实关系，会改变现有本体与所有图消费者；本计划在**同一个图数据库**增加一张有实体外键的候选断言表，复用现有正式节点和边。代价是一张表及有限的读取／审核接口，但不会把弱证据冒充正式事实。未确认的公司／学校可用显式的待核实关键词搜索找到，结果必须标记；确认后才能进入默认搜索与问答。

## 文件职责

| 文件 | 本次职责 |
|---|---|
| `src/contracts/contact-import.ts` | 定义带原因码和短来源的 `review_items`，保持候选预览有类型约束 |
| `src/contacts/document-extractor.ts` | 单候选容错、逐值证据分层、简历标题关系、同文件人物归并 |
| `src/contacts/import-service.ts` | 预览返回确认值与待核实值；提交时不把后者自动提升 |
| `rust/contact-graph/src/store.rs`、`rust/contact-graph/src/import_commit.rs` | 建表并在提交事务中保存待核实断言，正式写入仍只读取已核实属性和被选择的关系 |
| `rust/contact-graph/src/search.rs`、`src/contacts/contact-search.ts`、`src/mcp/contact-search-tools.ts` | 可选检索待核实断言并明确标记匹配来源 |
| `tests/contact-extraction.test.ts`、`tests/contact-import.test.ts`、`rust/contact-graph/tests/import_commit.rs`、`rust/contact-graph/tests/search.rs` | 对抽取召回、提交边界、存储和检索做断言 |

### Task 1: 为待核实信息增加受限预览契约

**Files:** Modify `src/contracts/contact-import.ts`, `rust/contact-graph/src/import_commit.rs`; Test `tests/contact-contracts.test.ts`, `rust/contact-graph/tests/import_commit.rs`.

**Interfaces:** `ImportCandidate.review_items: ReviewItem[]`；`ReviewItem` 为字段或关系两种形状，均含 `reason`，可含 `page` 与短 `quote`。原因码限定为 `missing_evidence | quote_mismatch | ambiguous_context | invalid_shape | ambiguous_owner`。字段项含 `field_path`、`value`；关系项含候选端点、现有关系类型及属性。每候选最多 100 项，单项 JSON 最多 2 KB，引文最多 500 字符；超限产生明确预览警告，不回退到整批失败。

- [ ] **Step 1: 写失败测试。** 构造 `Person` 候选：`properties.name` 有已定位证据，`review_items` 含缺证据的 `skills=Java`；断言 Zod 接受，Rust 默认提交后图谱无 `skills`，但同一 `import_id` 的 `get_import_job` 仍含该项。另一笔独立导入用 `set_properties` 加手工证据显式确认技能后，断言该技能才落图。另断言超长引文、未知原因码被拒。
- [ ] **Step 2: 跑定向测试确认失败。** `rtk npm test -- --run tests/contact-contracts.test.ts`；`rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml --test import_commit`。
- [ ] **Step 3: 实现最小契约。** 在 `ImportCandidateSchema` 增加默认空数组；Rust `candidate()` 的允许键列表加入 `review_items`，但不将其并入 `candidate_properties` 或 `candidate_evidence`。保持 `ensure_value_evidence` 原样。
- [ ] **Step 4: 重跑上述测试并提交。** 确认候选预览可持久化，提交后正式档案仍只含已证实值。

### Task 2: 逐字段保留 LLM 输出，局部失败不拖累人物

**Files:** Modify `src/contacts/document-extractor.ts`; Test `tests/contact-extraction.test.ts`.

**Interfaces:** 抽取输出仍是 `DocumentExtractionResult`。`candidate.properties`／`extensions` 只含类型有效且引文可定位、值受引文支持的值；未满足条件的原建议进入 `review_items`，携带原因码和可用的短来源。`can_commit` 仅由已证实的最低资料条件决定，不因 `review_items` 非空而变 `false`。

- [ ] **Step 1: 写失败测试。** 一位人物有可定位姓名、手机号和一项技能，另有两项技能缺引文；断言预览保留全部建议，正式 `properties.skills` 只含可定位项，另两项在 `review_items`，`can_commit=true`。同批第二位候选形状错误时，第一位仍出现；一个非法字段不丢同候选的姓名和电话。
- [ ] **Step 2: 跑 `rtk npm test -- --run tests/contact-extraction.test.ts`，确认上述断言先失败。**
- [ ] **Step 3: 将整批与整候选校验改为局部处理。** 先校验响应外壳，再逐候选校验；对有效候选按数组元素／标量逐值验证字段形状、`block_id`、短引文和值匹配。成功值及证据写正式候选，其余写 `review_items`；仍保留总输出字节、候选数、调用预算和来源长度上限。对于完全无可核实信息的候选，保留待核实预览但 `can_commit=false`。
- [ ] **Step 4: 修正语义归属。** “求职意向／期望岗位”中的职位只留待核实线索，不写 `Person.jobTitle`；项目名称、ERP／PO／MOM 等术语不建 `Organization`，除非原文明确是机构；技能须有原文中可定位的技能或经历表述。上述分类均增加中英文固定样例。
- [ ] **Step 5: 重跑定向测试并提交。** 断言不能通过把未经证实值直接写入 `properties` 来满足召回。

### Task 3: 保留结构化工作／教育关系建议

**Files:** Modify `src/contacts/document-extractor.ts`, `src/contracts/contact-import.ts`; Test `tests/contact-extraction.test.ts`, `tests/contact-management-e2e.test.ts`.

**Interfaces:** `CandidateRelation.uncertain` 仍是现有布尔值；可选 `review_reason='structured_heading' | 'missing_direct_statement' | 'ambiguous_owner'`。显式“任职／毕业”等陈述可为 `uncertain=false`；简历的“工作经历／教育经历”标题加相邻机构行生成 `uncertain=true` 的建议，保留页码与各自短引文，人工选择后才落图。无法确定人物归属的多人文档只保留 `review_items`，不生成可直接选择的关系。

- [ ] **Step 1: 写失败测试。** 构造多块简历：人物页眉、`工作经历` 标题、公司与任职时间行、`项目经历` 标题和客户名、`教育经历` 标题与学校行。断言前两类生成 `worksFor`／`alumniOf` 建议，客户名不成为雇主；职位和日期只有原文明确时进入 `OrganizationRole`。两位人物共享一页且归属不清时，不生成可提交关系，但候选线索不丢。
- [ ] **Step 2: 跑定向抽取与端到端测试确认失败。** `rtk npm test -- --run tests/contact-extraction.test.ts tests/contact-management-e2e.test.ts`。
- [ ] **Step 3: 扩展提示词和本地关系校验。** 提示词要求识别简历栏目而非只识别动词；本地规则只接受同页、相邻且在正确栏目内的机构行，跨越新人物或项目栏目立即终止上下文。缺少直接句子的关系标为 `uncertain=true`，不能伪装成直接引文；原有显式否定、无效端点、匿名多人保护继续生效。
- [ ] **Step 4: 保持审核门槛。** 确认 `commit_contact_import` 只把 `relation_choices` 中人工选择的建议写为正式边；未选择、但端点可关联到已提交人物的建议交给 Task 5 保存为待核实断言。匿名人物现有“直接陈述”门槛保持；无法确定人物归属的关系仍只留在导入预览。正式确认后，现有默认搜索可以按公司／学校命中该人物。
- [ ] **Step 5: 重跑测试并提交。** 断言预览的 `uncertain` 及原因码可见，图谱没有未选择的边；对只有结构化标题、没有足以引用的直接陈述的关系，联系人问答不得伪造直接引文。

### Task 4: 同一份简历内保守合并人物片段

**Files:** Modify `src/contacts/document-extractor.ts`; Test `tests/contact-extraction.test.ts`, `tests/contact-management-e2e.test.ts`.

**Interfaces:** 后处理仅在同文件、同一明确手机号／邮箱或无冲突的单人简历锚点成立时合并 `Person` 片段；合并后重映射该文件内的关系候选 ID，保留各字段来源和所有 `review_items`。冲突标量只保留已确认值，其他值进入待核实项；不据同名、同公司或同校跨文件合并。

- [ ] **Step 1: 写失败测试。** 两批同一人物的姓名、电话、经历片段合并成一位；多人物文件、同名不同电话、电话属于公司总机的候选保持分开；合并后关系端点和证据 `subject_id` 仍指向最终候选。
- [ ] **Step 2: 跑 `rtk npm test -- --run tests/contact-extraction.test.ts` 确认失败。**
- [ ] **Step 3: 增加单文件归并后处理。** 先用强标识归并；无强标识时仅对明确单人简历且完全无第二人物线索的片段归并。数组去重但证据逐条保留，冲突字段进入 `review_items`，不擅自选择一个值。匿名人物继续遵循原有谨慎归属规则。
- [ ] **Step 4: 重跑抽取及端到端测试并提交。** 断言一次导入只创建一位目标人物，多段 `worksFor` 仍为独立关系。

### Task 5: 将待核实线索关联到图谱实体并提供标记查询

**Files:** Modify `rust/contact-graph/src/store.rs`, `rust/contact-graph/src/import_commit.rs`, `rust/contact-graph/src/search.rs`, `rust/contact-graph/src/protocol.rs`, `src/contacts/contact-search.ts`, `src/mcp/contact-search-tools.ts`, `src/mcp/contact-tools.ts`; Test `rust/contact-graph/tests/import_commit.rs`, `rust/contact-graph/tests/search.rs`, `tests/contact-search.test.ts`, `tests/contact-management-e2e.test.ts`.

**Interfaces:** `contact_claims(claim_id, subject_id, kind, field_path, relation_type, target_id, value_json, source_json, status, reason, import_id, candidate_id, created_at, updated_at)`，其中 `subject_id` 引用 `entity_ids`，`target_id` 可空且只在机构实体已创建时引用它，`kind` 为 `field|relation`，`status` 为 `unverified|confirmed|rejected`。`get_contact` 增加独立分页的 `unverified_claims`；`search_contacts` 增加 `include_unverified?: boolean`，仅允许关键词模式，命中时返回 `match_status='unverified'` 与对应 `claim_id`。新增 `review_contact_claim({claim_id:string, action:'confirm'|'reject', operation_id:string, expected_entity_version:number, target_id?:string, corrected_value?:unknown, confirmation_note?:string})`：`confirm` 必须附 1–500 字符的审核说明，按断言类型复用正式字段／关系校验并将说明写为手工证据；机构关系没有 `target_id` 时须提供已创建的组织 ID。`reject` 只更改断言状态。两种操作均与状态变更、审计和幂等结果在一笔图数据库事务中完成。

- [ ] **Step 1: 写失败测试。** 同一导入包含一个已核实姓名、一个缺证据技能和一条只有“工作经历”栏目支持的公司建议；确认创建人物后，正式 `properties` 与 `kg_relations` 不含后两者，但 `contact_claims` 有两条 `unverified`，各有原因、短来源与 `subject_id`。提交响应丢失后重试不重复写断言；事务失败时人物、来源映射和断言一起回滚。
- [ ] **Step 2: 跑 Rust 导入与 Node 端到端测试确认失败。** `rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml --test import_commit`；`rtk npm test -- --run tests/contact-management-e2e.test.ts`。
- [ ] **Step 3: 建表并在现有 `commit_import` 事务中写入。** `claim_id` 由导入 ID、候选 ID、字段路径／关系端点及规范化值形成稳定键；主键防止重放增殖。仅为已 `create`／`merge` 的实体写断言；若人物被 `skip` 或仍不满足现有匿名档案最低内容要求，线索继续保存在 `get_contact_import`，不凭弱线索制造空人物。原文仅保留受限短引文与页码，不存完整 OCR。
- [ ] **Step 4: 写查询失败测试。** 默认 `search_contacts` 不返回只靠待核实学校／公司命中的人物；`include_unverified=true, mode='keyword'` 可找到该人并标 `match_status='unverified'`，已确认命中优先；`get_contact` 可分页读取断言。`mode='semantic'|'hybrid'` 与 `include_unverified=true` 的组合明确拒绝，不悄悄漏检。归档或合并重定向后，断言不得以旧 ID 暴露；电话号码候选不触发身份匹配。
- [ ] **Step 5: 实现受限查询。** 在 Rust 关键词搜索中对 `status='unverified'` 且主体未归档／未合并的断言做有界匹配；Node 和 MCP 传递 `include_unverified` 与匹配标记。`get_contact` 独立分页返回断言，不混进 `evidence` 或已确认的 `relations`。不将待核实文本写入向量。
- [ ] **Step 6: 写审核失败测试。** `review_contact_claim(confirm)` 无审核说明、无机构目标、非法字段形状或错误关系端点时拒绝正式写入但保留 `unverified`。有效确认用审核说明生成手工证据，不伪造文件引文，使字段或关系写入正式图谱且断言变为 `confirmed`；`reject` 后待核实搜索不再命中。过期版本、重复 `operation_id`、错误端点与归档主体按现有事务规则处理；问答不得引用 `unverified` 断言。
- [ ] **Step 7: 实现审核操作并重跑定向测试。** 复用现有字段／关系验证函数，保持 `ensure_value_evidence`；从断言确认的 `worksFor` 仍每段任职一条独立关系。确认或拒绝与审计、操作结果同事务提交，然后运行 Rust/Node 定向测试并提交。

### Task 6: 用匿名化样例和真实简历完成验收

**Files:** Test `tests/contact-extraction.test.ts`, `tests/contact-import.test.ts`, `tests/contact-search.test.ts`, `rust/contact-graph/tests/import_commit.rs`, `rust/contact-graph/tests/search.rs`; Modify `docs/QUICKSTART.md`.

- [ ] **Step 1: 建立无真实个人信息的固定样例。** 内容覆盖姓名／电话、可核实技能、缺证据技能、求职意向、工作标题、项目客户、学校标题和两段任职；不得复制真实 PDF 的姓名、电话或原文段落。
- [ ] **Step 2: 断言完整链路。** 上传 → 解析 → 预览包含确认值与待核实值 → 提交确认值并把其余线索关联到人物 → 默认查询只返回确认事实，显式待核实关键词查询返回带状态的候选 → 审核确认或拒绝 → 再查图谱与问答。提交后 `get_contact_import` 仍可找回原始待核实预览。模型失败、无有效候选和多人歧义仍给可理解警告，不制造正式图谱事实。
- [ ] **Step 3: 跑全量验证。** `rtk npm test -- --run`、`rtk npm run typecheck`、`rtk npm run build`、`rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml`。
- [ ] **Step 4: 用用户提供的真实 PDF 做独立冒烟。** 在临时数据库中运行当前 `.env` 的真实模型，人工核对抽取前后差异：单人物归属、可提交的有证据字段、工作／学校建议、未证实技能及求职意向标记、项目术语误判和最终可搜索结果。报告使用字段数量及脱敏描述；不将原件、模型正文、临时数据库或个人信息提交到仓库。测试结束清理临时文件。

## 验收标准与边界

固定样例必须证明“一个坏字段不阻断其他好字段”“低置信线索关联到已创建的图谱人物且没有被静默丢弃”“默认查询与问答不把低置信线索当事实”“显式待核实查询能返回标记结果”。真实简历冒烟的目标是人工可一次审核出单个人物及其工作／学校关系，并能看到剩余待核实信息；模型输出有波动，不能以固定候选数量作为唯一断言。若真实文件的结构性关系仍无法判定，预览及候选断言须保留原因和短来源，不能伪造肯定关系。

本次不建设图谱置信度评分模型、新的模型端点、自动跨文件身份合并或可视化审核页面。待核实查询只做显式关键词匹配，不参加语义向量和普通问答；若将来要求默认搜索自动混排未核实事实，需要单独评估排序与答复语义。
