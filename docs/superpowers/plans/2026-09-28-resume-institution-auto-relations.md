# 简历机构与项目客户关系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 单主体简历自动导入时，明确的雇主／学校建立正式关系；项目经历形成 `Person → Project → 客户 Organization` 的可追溯路径，使用户能按客户名称找到参与过其项目的人，同时不把客户误认成雇主。

**Architecture:** 沿用 Docling → LLM 候选 → 证据校验 → `commit_import` → SQLite 图谱。保留一个主体 `Person`，新增 Schema.org `Project` 节点；明确的项目参与用现有 `memberOf`（附 `OrganizationRole`），项目客户用本项目显式扩展关系 `clientOrganization`，雇主仍只用 `worksFor`。自动提交仅选择有定位文件证据的边；弱建议落入现有 `unverified` claim。只扩充当前契约、图谱校验和关键词查询，不增加数据库表、模型端点或审核界面。

**Tech Stack:** TypeScript、Zod、Vitest、Rust、SQLite、现有 Docling 和 Ark LLM。

**Spec:** [联系人数据契约](../specs/contact-data-contract.md)；本计划覆盖当前自动导入“一律零正式关系”的局部策略，并按用户已同意的项目客户查询目标扩充本体；执行时同步修订该契约及用户文档。

**基线：** 以 `codex/resume-contact-claims` 工作树中现有 `auto_create`、跨批关系建议和 `contact_claims` 实现为基础。该工作树目前仍有前一任务的未提交改动；实施前先保留并核对这些改动，不从缺少它们的 `main` 直接套用本计划。

## Global Constraints

- 每份简历／名片最多自动创建一个主体 `Person`；证明人、推荐人、紧急联系人不得成为主体，也不得把其机构归给主体。既有匿名档案最低资料要求不放宽。
- 节点为 `Person`、`Organization`、`Project`。Schema.org 的 [`Project`](https://schema.org/Project) 是 `Organization` 子类；`Person → Project` 在有项目参与证据时使用 [`memberOf`](https://schema.org/memberOf)，但不得因此推断此人受雇于项目客户。`Project → Organization` 的 `clientOrganization` 是**本项目命名空间内的扩展关系**，不是 Schema.org 原生属性；Schema.org [`customer`](https://schema.org/customer) 只描述订单／发票下单或付款方，不能泛化为简历项目客户。
- 项目只存有原文定位的 `name`／`description`（至少一项），成员角色／起止时间放在该人的 `memberOf.role`，客户只放在 `clientOrganization` 边；不在 `Person.properties` 拼接客户或编造项目名。项目缺少可定位条目时保留预览线索，不造空项目。不同文件的同名项目不自动合并。
- Project 不是联系人或普通公司：不参加手机号／姓名身份匹配、公开网页联系人同步及现有 Person 向量索引；`search_contacts` 直接返回的仍是 Person／Organization，Project 仅作为关系路径和 `get_contact(Project)` 可读实体。
- 多段任职逐段保存，保留各段有证据的岗位与日期；不推断在职状态、毕业状态或缺失时间。同一组织的不同任职段不得按端点去重。
- “明确”必须同时满足：唯一主体、已创建且名称有定位证据的目标组织、关系端点有效、可定位的关系原文、没有否定／客户／项目／合作方语境；`worksFor` 的每个非 `@type` 角色字段另有对应文件证据。仅靠同页出现、名片并列排版、LLM 的 `uncertain:false` 或学校／公司名称都不够。
- 明确任职／就读陈述可直接选边；结构化“工作经历／教育经历”仅在标题与紧邻机构行同页、归属唯一、目标名称有定位证据且无排除语境时选边。其他建议及弱线索保持 `unverified`，不进入默认问答；`include_unverified:true` 仍可显式检索。
- 项目参与、项目客户分别需要自己的来源证据：`memberOf` 证明主体参与哪个项目，`clientOrganization` 证明哪个组织是该项目客户。两条边各自可正式或待核实；任一跳待核实时，按客户找人的结果必须标为 `unverified`。只出现客户名、没有可归属的项目条目时不建立 Person 到客户的捷径边。
- 自动导入不合并已有联系人。旧手工 `choices`／`relation_choices` 请求保持兼容；自动模式仍拒绝调用方同时提供这些选择。操作 ID、预览版本和事务幂等规则不变。
- 真实 PDF 仅用于临时库冒烟；测试仓库、日志和计划中不保存姓名、电话、原文、模型完整响应或临时数据库。

## 文件职责

| 文件 | 改动 |
| --- | --- |
| `src/contacts/document-extractor.ts` | 提示词明确区分机构语境；验证关系引文属于目标机构，阻断跨公司动词误配 |
| `src/contacts/institution-relation.ts` | 供提取和自动选择共享的目标局部语境判断；只处理 `worksFor`／`alumniOf` |
| `src/contacts/import-service.ts` | 在 `auto_create` 内从已提交候选中挑选明确关系，其他建议保持未选 |
| `rust/contact-graph/src/import_commit.rs` | 自动选边以文件证据落图，手工选边维持原有人工证据；未选建议照旧写 claim |
| `src/contracts/contact-graph.ts`、`src/contracts/contact-import.ts`、`rust/contact-graph/src/validation.rs` | 增加 `Project` 的最小字段与合法端点；`memberOf` 仅指向 Project 时可有角色；增加 `clientOrganization` |
| `src/mcp/contact-tools.ts` | 允许现有保存／读取工具处理 Project，关系工具沿用同一入口 |
| `rust/contact-graph/src/store.rs`、`rust/contact-graph/src/relations.rs` | 在现有实体／关系表中存 Project 和两类边，继续验证实体版本、证据和归档状态 |
| `rust/contact-graph/src/search.rs`、`src/contacts/contact-search.ts` | 关键词搜索沿 Person → Project → 客户路径返回人物；正式事实与待核实路径分开标记 |
| `tests/contact-contracts.test.ts`、`tests/contact-search.test.ts`、`rust/contact-graph/tests/search.rs` | 覆盖新契约、端点及客户路径检索 |
| `tests/contact-extraction.test.ts`、`tests/contact-management-e2e.test.ts`、`rust/contact-graph/tests/import_commit.rs` | 固定合成案例覆盖分类、自动边、待核实退路、来源与幂等 |
| `docs/superpowers/specs/contact-data-contract.md`、`docs/QUICKSTART.md`、`skills/salestools-contact-management/SKILL.md` | 更新自动关系、项目客户路径、证据来源及查询说明 |

### Task 1: 让提取结果区分雇主／学校与客户／合作方

**Files:** Modify `src/contacts/document-extractor.ts`; create `src/contacts/institution-relation.ts`; test `tests/contact-extraction.test.ts`.

**Interfaces:** 继续输出 `ImportCandidate.relation_suggestions`。正式关系候选仍是 `{source_candidate_id,target_candidate_id,relation_type,properties,evidence,uncertain,review_reason?}`；不在组织节点上持久化“客户／雇主”新属性。仅有证据不足但端点有效的建议可留在现有 `review_items`／`relation_suggestions`，绝不升级为肯定关系。

- [ ] **Step 1: 写失败测试。** 用模型响应桩和合成块分别断言：`甲公司任职实施顾问；乙公司为项目客户` 只建议 `Person → 甲公司 worksFor`；“项目客户乙公司”及“合作方丙公司”即便模型误报 `worksFor` 也不得成为可自动选择的关系。`陈某在甲公司任职，项目客户乙公司` 的整句引文不能凭“任职”二字把乙公司判作雇主。`曾就读星辰大学` 建议 `alumniOf`；否定句、纯机构名、仅姓名＋公司＋职位并列仍不产生肯定关系。分别断言端点、`uncertain`、引文和目标名称。
- [ ] **Step 2: 运行 `rtk npm test -- --run tests/contact-extraction.test.ts`，确认新增断言先失败。**
- [ ] **Step 3: 最小修改提示词和本地核验。** 在 `RELATION_PROMPT` 中要求先判定机构语境：任职单位才输出 `worksFor`，就读学校才输出 `alumniOf`；项目客户／合作方不得映射为 `worksFor`。增强 `directInstitutionStatement` 或其共用小函数：关系动词须指向目标机构所在的局部短语，目标附近出现“客户／项目／合作方／外包服务对象”等排除词时不视为雇主；保留现有否定、多人归属和结构化标题校验。不要单靠 LLM 布尔值放行。

  目标局部语境的最小规则：先按句号、分号、逗号和换行切分引文，找到包含目标机构名的片段；该片段出现明确任职／就读动词且不含否定或客户等排除词，才把它视为直接陈述。结构化标题走现有相邻块校验，不用词距阈值推测跨句归属。
- [ ] **Step 4: 重跑该文件测试和 `rtk npm run typecheck`。** 核对跨批 `structured_heading`、匿名人物、双任职段以及原有名片测试不回退。

### Task 2: 自动选择明确关系，并准确记录文件来源

**Files:** Modify `src/contacts/import-service.ts`, `rust/contact-graph/src/import_commit.rs`; reuse Task 1's predicate if extracted; test `tests/contact-management-e2e.test.ts`, `rust/contact-graph/tests/import_commit.rs`.

**Interfaces:** `auto_create` 对外输入不变。服务端内部向 `commit_import` 传计算出的 `relation_choices` 以及仅内部使用的 `auto_selected_relations: true`；Rust `CommitInput.auto_selected_relations` 默认 `false`，旧手工调用不变。自动选择的每一项必须与预览建议的端点、类型和 `properties` 原值精确一致。

```ts
function isAutoSelectableInstitutionRelation(
  relation: ImportCandidate['relation_suggestions'][number],
  owner: ImportCandidate,
  candidates: ImportCandidate[],
  choices: Array<{ candidate_id: string; action: 'create' | 'skip' }>,
): boolean;
```

此函数只读取预览和本次节点选择；Task 1 的机构语境判断负责直接引文，`structured_heading` 分支复核现有结构证据。它不调用 LLM、不写图谱，也不返回置信度分数。

- [ ] **Step 1: 写失败端到端测试。** 在尚未包含项目条目的基线案例中，单主体简历含明确雇主、明确学校、项目客户、合作方和一条含糊外包经历；`auto_create:true` 后只出现 `worksFor`、`alumniOf` 两条正式边，客户／合作方没有 `worksFor`，含糊关系若已有有效建议则在 `unverified_claims` 中，且其目标组织可由显式待核实搜索找到。此阶段客户／合作方只作为有证据的组织候选保存，不凭空造 Person 关系；Task 4 再建立可归属的项目路径。默认 `search_contacts` 和 `ask_contacts` 只看到正式关系。对明确但不同日期的两段同公司任职，断言保留两条 `worksFor` 及各自角色字段。
- [ ] **Step 2: 写 Rust 失败测试。** 自动选择的关系只含原有 `source_type=file`、`locator_status=located`、短引文及文件哈希证据，没有伪造的 `source_type=manual`；手工 `relation_choices` 仍保留人工证据。自动选择的建议必须有已定位 `$relation` 引文；`worksFor.role` 的岗位／日期须各有已定位文件证据；无效自动建议不得成为正式边。重放同一 `operation_id` 不重复节点、边或 claim。
- [ ] **Step 3: 运行 `rtk npm test -- --run tests/contact-management-e2e.test.ts` 和 `rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml --test import_commit`，确认新增断言先失败。**
- [ ] **Step 4: 在 `auto_create` 组装节点选择后挑关系。** 仅检查唯一主体到本次 `create` 的组织、类型为 `worksFor|alumniOf` 的建议。直接引文要求 `uncertain=false`、无 `review_reason`、已定位 `$relation` 证据且目标局部语境通过 Task 1 判断；结构化建议只允许 `review_reason=structured_heading`，重新核对同页标题与紧邻机构行、目标名称、唯一主体和排除词。缺任一条件就不选，原建议按既有 `persist_claims` 进入 `unverified`；没有有效关系时仍正常创建人物和组织。内部 `relation_choices` 不包含 `metadata` 推断值。

  ```ts
  // 仅为计划中的选择接口；实际类型使用现有 ImportCandidate。
  const relationChoices = owner.relation_suggestions
    .filter(relation => isAutoSelectableInstitutionRelation(relation, owner, candidates, choices))
    .map(({ source_candidate_id, target_candidate_id, relation_type, properties }) =>
      ({ source_candidate_id, target_candidate_id, relation_type, properties }));
  // 未进入 relationChoices 的有效建议继续由 commit_import 保存为 unverified claim。
  ```
- [ ] **Step 5: Rust 保留事务校验，并区分证据来源。** `auto_selected_relations=true` 时，对每条被选建议验证文件关系证据和所有选中角色字段的文件证据；用这些证据写边，不追加现有“人工确认”证明。默认 `false` 保持手工选择行为。若服务端没有选择某建议，现有 `persist_claims` 必须继续写为 `unverified`；任何后端异常依旧整笔回滚，不产生半成品图谱。

  ```rust
  // CommitInput 的向后兼容字段；仅服务端 auto_create 路径设置为 true。
  #[serde(default)]
  auto_selected_relations: bool,
  // commit_relations 中，只有 !auto_selected_relations 才追加现有 manual 证据；
  // 自动分支必须至少保留一条 located 的 file $relation 证据。
  ```
- [ ] **Step 6: 重跑定向测试、`rtk npm run typecheck` 和 `rtk npm run build`。** 特别核对 `auto_create` 与外部 `relation_choices` 同传仍报 `AUTO_CREATE_CONFLICT`，预览版本冲突仍原子拒绝，重复提交仍是幂等回放。

### Task 3: 扩充 Project 节点和两种有类型的关系

**Files:** Modify `src/contracts/contact-graph.ts`, `src/contracts/contact-import.ts`, `src/mcp/contact-tools.ts`, `rust/contact-graph/src/validation.rs`, `rust/contact-graph/src/store.rs`, `rust/contact-graph/src/relations.rs`, `rust/contact-graph/src/import_commit.rs`, `rust/contact-graph/src/claims.rs`; test `tests/contact-contracts.test.ts`, `rust/contact-graph/tests/import_commit.rs` and existing Rust relation tests.

**Interfaces:** `Project` 是第三种实体标签，`Project.properties` 仅允许有原文证据的 `name?: string`、`description?: string`，至少一项非空。`memberOf` 允许 `Person → Project` 携带 `{role:{'@type':'OrganizationRole',roleName?,startDate?,endDate?}}`；既有 `Person → Organization memberOf` 仍是空属性。新增 `Project → Organization clientOrganization`，属性为空。`clientOrganization` 是域内扩展词，禁止 `Person → Organization clientOrganization` 和 `Project → Person`。项目 ID 使用独立前缀且不从名称推导。

- [ ] **Step 1: 写失败契约／图谱测试。** 有短文件证据的 `Project{name:'PLM 升级'}`、`Person → Project memberOf{roleName:'顾问'}`、`Project → Organization clientOrganization` 可以保存、回读和分页；`Person → 客户 worksFor` 只有真实任职证据才成立。反向端点、未建端点、Project 作为 `worksFor` 目标、无证据属性、未知项目字段和空项目均被拒。旧 `memberOf` 到普通组织仍可读写。
- [ ] **Step 2: 运行 `rtk npm test -- --run tests/contact-contracts.test.ts` 与 `rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml --test import_commit`，确认新增断言先失败。**
- [ ] **Step 3: 在现有表和写入路径扩展类型。** 扩充 Zod、MCP 保存输入与 Rust 的实体标签、证据路径、`normalize_properties`、`normalize_endpoints` 和 `relation_properties`；Project 不接受 Person 的 `extensions`。`memberOf` 的 `role` 仅对 Project 目标生效，岗位／日期复用现有 `OrganizationRole` 日期和逐字段证据校验。`clientOrganization` 只允许 Project 源、Organization 目标。`commit_import` 的候选标签、未选关系 claim 目标类型，以及 `review_contact_claim` 对这两种边的确认／拒绝，都使用同一端点规则；不建新表。手工确认仍产生真实人工证据。
- [ ] **Step 4: 重跑定向测试。** 断言同名 Project 在不同导入中保留不同 ID；一份文件可有多个 Project 但仍仅一个主体 Person；过期版本、重复提交、归档端点和未知关系类型依旧被拒或幂等回放。

### Task 4: 从项目段落提取人物、项目、客户的独立事实

**Files:** Modify `src/contacts/document-extractor.ts`, `src/contacts/import-service.ts`, `rust/contact-graph/src/import_commit.rs`; test `tests/contact-extraction.test.ts`, `tests/contact-management-e2e.test.ts`, `rust/contact-graph/tests/import_commit.rs`.

**Interfaces:** LLM 输出沿用 `candidates`／`relation_suggestions`：一个主体 Person、零至多个 Project、零至多个 Organization。项目关系建议分别为 `Person → Project memberOf` 和 `Project → 客户 Organization clientOrganization`；每条建议独立有 `$relation` 文件引文，`memberOf.role` 的岗位／日期另有逐字段文件引文。`auto_create` 对外参数不变。

- [ ] **Step 1: 写失败抽取测试。** 合成简历有“工作经历：甲公司；项目经历：PLM 升级，项目角色顾问，客户乙公司”时，预览分别出现一个 Person、一个 Project、甲／乙两个 Organization；只有甲公司成为 `worksFor` 目标，Project 才是 `memberOf` 目标，乙公司只成为 `clientOrganization` 目标。两段项目、同一客户要得到两个不同 Project；“客户乙公司”脱离项目段落、多个项目争同一客户、证明人的项目、否定句及只有产品词“ERP”时，不自动建立错误边。Person 姓名若存在、Project 名称若存在，都须可定位；无名 Person 与只有描述的 Project 沿用各自最低资料要求，不能用文件名或客户名伪造名称。
- [ ] **Step 2: 写失败提交测试。** `auto_create:true` 自动创建有证据且归属唯一的 Project 和客户组织；两条明确关系各自以文件证据成为正式边。若只有项目参与清楚、客户归属含糊，前者正式、后者以 `unverified` claim 挂在 Project；反之亦然。项目候选缺少名称但有可定位描述时可入库；没有可定位项目内容时留在预览，不创建空 Project。未选择的项目关系仍可用现有审核接口后来确认或拒绝。
- [ ] **Step 3: 运行 `rtk npm test -- --run tests/contact-extraction.test.ts tests/contact-management-e2e.test.ts`，确认新增断言先失败。**
- [ ] **Step 4: 扩充提示词和证据绑定。** 仅从明确项目条目提取 `Project.name/description`；将角色和时间放到 `memberOf.role`，把“客户／甲方／服务对象”定位为该项目的 `clientOrganization`，不直接连 Person。跨 Docling 批次仅在同页、同一项目条目锚点唯一时重映射端点；不能唯一归属就保留有端点的待核实建议或预览警告，不猜测跨项目归属。沿用现有 500 字引文、页码和字段证据限制。
- [ ] **Step 5: 扩充 `auto_create` 和 Rust 自动证据分支。** 节点选择先保证唯一主体，再创建与该主体项目建议相连且有自身证据的 Project，以及有证据的组织。自动正式选边的两跳各自检查端点已创建、项目段落归属唯一、关系引文可定位和角色字段证据齐全；未通过的一跳不阻止另一跳或节点提交，按现有 `contact_claims` 保存待核实建议。复用 Task 2 的 `auto_selected_relations`，自动边不得写 `source_type=manual`。同一 `operation_id` 重放不增殖项目或边。
- [ ] **Step 6: 重跑抽取、端到端及 Rust 导入测试。** 分别核对 `get_contact(Person)` 的项目参与、`get_contact(Project)` 的客户关系、两端短证据和 `unverified_claims`；不得只断言候选预览。

### Task 5: 按项目客户查找人物

**Files:** Modify `rust/contact-graph/src/search.rs`, `src/contacts/contact-search.ts`, `src/mcp/contact-search-tools.ts`; test `rust/contact-graph/tests/search.rs`, `tests/contact-search.test.ts`, `tests/contact-management-e2e.test.ts`.

**Interfaces:** 不增加新搜索工具。`search_contacts({query:'乙公司',mode:'keyword'})` 可沿正式 `Person -memberOf-> Project -clientOrganization-> Organization` 路径命中人物，结果增加 `matched_project_id` 和 `reasons:['project_client_match']`；旧字段保持兼容。`include_unverified:true` 可沿含有效待核实关系 claim 的同一两跳路径命中，返回 `match_status:'unverified'` 和 `claim_ids`（一跳或两跳的所有 claim ID）；旧直接线索的 `claim_id` 保持兼容。`organization_id` 仍专指现有任职／就读过滤，不暗改为客户过滤。

- [ ] **Step 1: 写失败搜索测试。** 正式两跳按客户名返回人物和匹配的 Project；仅有客户组织节点、没有项目路径时不返回；项目名相同但无客户边时不串到其他人物。任一跳为 `unverified` 时默认搜索不当事实命中，显式 `include_unverified:true` 才返回并列出正确 claim ID；两跳均待核实返回两个 ID。被拒绝 claim、归档／合并人物或组织、失效项目不命中；一个人有多个同客户项目仍只占一条人物结果，分页总数正确。
- [ ] **Step 2: 运行 `rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml --test search` 与 `rtk npm test -- --run tests/contact-search.test.ts`，确认新增断言先失败。**
- [ ] **Step 3: 扩充现有关键词 SQL。** 只以项目关系表和 `contact_claims` 的端点 ID 连接两跳，逐段检查实体／关系仍可见；正式路径优先，待核实路径须显式开关且不参与语义向量与 `ask_contacts`。返回 Person ID、匹配 Project ID、状态及相关 claim ID，不用客户名相似度推断跨项目归属。
- [ ] **Step 4: 重跑搜索及端到端测试。** 确认按雇主／学校的旧搜索、`organization_id`、`job_title`、关键词分页和默认问答语义不回退。

### Task 6: 文档与真实文件闭环验收

**Files:** Modify `docs/superpowers/specs/contact-data-contract.md`, `docs/QUICKSTART.md`, `skills/salestools-contact-management/SKILL.md`; test the complete pipeline with a temporary graph database.

- [ ] **Step 1: 修订本体与用户说明。** 写明 Project 是 Schema.org 类型、`memberOf` 表示有证据的项目参与、`clientOrganization` 是本项目扩展词及其端点规则；明确项目客户不是雇主。把“一律零正式边／所有关系都要逐条人工确认”改为“文件证据明确时自动建立雇主、学校和项目路径；弱线索标记为 `unverified`”。说明 `confirmed` 图谱事实不等于人工认证，按客户查人需走项目路径；复核后仍可用现有编辑／审核工具修正。
- [ ] **Step 2: 用无真实个人资料的固定样例完成全链路断言。** 上传／解析桩 → 预览 → `auto_create` → `get_contact(Person/Project)` → 默认及 `include_unverified:true` 客户关键词搜索；核对唯一 Person、多个 Project、雇主与客户不混淆、正式／弱边、来源类型和重放。`ask_contacts` 仍只回答既有直接正式关系，不把项目客户编成任职事实。
- [ ] **Step 3: 在临时数据库用用户给出的真实 PDF 运行一次当前 `.env` 模型。** 人工按原件核对每条自动正式雇主、学校、项目参与及客户边，核对按客户名称能找回对应主体且返回的项目正确；记录脱敏的节点／边／claim 数及证据不足原因。若原文不满足某条边的门槛，保留标记线索而不强连。原件、完整模型输出和临时数据库不提交仓库。
- [ ] **Step 4: 完成验证。** 运行 `rtk npm test -- --run tests/contact-contracts.test.ts tests/contact-extraction.test.ts tests/contact-management-e2e.test.ts tests/contact-search.test.ts tests/contact-recall-acceptance.test.ts`、`rtk npm run typecheck`、`rtk npm run build`、`rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml`、`rtk git diff --check`。仅在真实文件没有雇主／客户误连、项目路径图谱回读与查询一致时报告端到端通过。

## 不在本次范围

不建 Person 到客户的捷径边、订单／发票／服务模型、置信度数值、自动跨文件项目或人物合并、人工审核页面、新向量流程，也不把项目客户纳入 `ask_contacts` 的任职回答。合作方仅保留组织候选和证据；若以后确有“按合作方找项目／人”的需求，再另定独立关系。

## 执行记录（2026-09-28）

任务 1–5 和任务 6 的文档、合成全链路及验证已实施于 `codex/resume-contact-claims` 工作树。全套 TypeScript 测试为 54 个文件、1160 项通过；Rust 测试 102 项通过；类型检查、构建、Rust 格式检查和差异空白检查通过。合成样例已实际覆盖预览、自动提交、人物与项目图谱回读、按客户关键词检索、待核实两跳和幂等重放。

用户提供的真实 PDF 已在临时库用当前模型多次冒烟，临时库均已清理。模型改写或漏报项目名时，Docling 原文“项目经历”栏目的准确标题仍可恢复为有定位证据的 Project 候选；人物与这些项目的栏目归属只作为 `unverified` 参与线索写入，没有冒充正式关系。模型给出的不可定位项目提议若存在，仍留在预览供核对，自动模式只创建可定位节点。最近一次预览有一个 Person、三个可提交 Project；临时库提交创建了一个 Person、六个 Organization、三个 Project，图谱回读确认三个 Project 节点及待核实参与线索。此 PDF 没有明确的项目客户归属词，故没有 `clientOrganization`，也没有该文件的客户关键词命中；**不宣称这份文件的项目客户端到端通过**，更不凭标题中的公司名推断客户或雇主。合成全链路已验证有明确客户证据时的正式及待核实客户查询。
