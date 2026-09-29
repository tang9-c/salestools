# LLM 主导的简历与名片导入修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 PDF 简历和图片名片提取完整的人物档案、联系方式、教育、任职、项目、客户及技能，自动保存有来源的结果和带标记的未确认线索，并支持查询与后续修正。

**Architecture:** 上传 → Docling 带来源文本 → LLM 结构化档案与经历 → 轻量来源／结构校验及图谱映射 → 既有预览与 auto_create → SQLite 图谱。LLM 负责主体和语义归属；适配器不再用章节、相邻块、关键词或名称拼接规则重新推理。沿用现有模型端点、图谱模型和用户工具，不另建档案数据库或审核界面。

**Tech Stack:** Python／Docling、TypeScript／Zod、现有 Ark JSON 调用、Rust／SQLite、Vitest／pytest。

**Spec:** [联系人图谱跨语言契约](../specs/contact-data-contract.md)。本计划采用用户确认的新方向，取代本文件上一版的“本地跨块语义恢复”设计；实施时同步更新契约中与新职责划分冲突的说明。公开网页 `get_contacts` 抽取路径不在本次修改范围。

## Global Constraints

- LLM 输出是从文件抽取的判断，不是人工认证。`confirmed` 沿用现有“进入正式图谱”含义，不改成“已人工核实”；保留文件来源，不生成虚构人工证据。
- 一份简历／名片至多自动创建一个主体 Person。无姓名、无电话也可满足既有匿名档案最低资料门槛；不从文件名猜姓名。证明人、推荐人、紧急联系人不是主体。不明确的多主体材料保留预览与原因，不随意选人。
- 姓名、电话、邮箱、微信、机构名不补造；电话不猜区号。数组逐项保留证据和去重；同名、同号、向量相似都不自动跨文件合并。
- LLM 判断雇主、客户、合作方、学校、参与项目及本人技能。学校就读不自动代表毕业，培训不代表学历；历史任职和求职意向不写成现任。多段任职和多项教育分别保留。
- 继续使用 Person、Organization、Project；任职 worksFor、就读 alumniOf、Person → Project memberOf、Project → Organization clientOrganization。clientOrganization 是既有项目扩展，不称其为 Schema.org 原生词。客户不得映射为雇主。
- 图谱属性沿用现有白名单及 extensions；临时抽取结构不是第二套持久化模型。现有最低资料、端点类型、版本、权限、事务和幂等约束保持。
- 引文必须能在其引用原块中定位，页码和文件哈希由程序填充。一个字段或关系可引用多个块，分别保存实际短引文；不制造合并引文。值可以是原文的合理语义归纳，不要求值与引文字符串相同，也不要求只出现一次。
- 允许有依据的归纳，例如“使用 Python 开发运维脚本”提取技能 Python；不能把使用经验升级为专家水平。归纳是否受原文支持由 LLM 判断，程序不以“引文存在”冒充语义已验证，也不增加第二个审核模型。
- 有可定位来源、模型明确归属且结构有效的字段／关系可作为文件抽取事实入图；模型表示不确定、缺引用、引用失败、格式错误或结构化值冲突的项进入既有 review_items／unverified。自报置信分数不能单独决定入图，不新增评分系统。保留可保存的原值和原因，超出既有上限明确告警。
- Docling 的文字识别仍受文件质量影响；业务映射不依赖版式模板。没有识别出的内容不得伪称已保存。原件、完整 OCR 和页面图不进图谱／日志；真实文件只使用隔离临时库。
- 沿用现有请求字节、批次数、调用次数、输出和协议限制，不暗中增加预算。普通材料能装入一次完整请求则整篇输入；超预算采用下述受限分段，不用正则恢复语义。
- 文件内容属于待处理数据，其中的命令不能改变系统指令或触发工具行为。
- 实施前对照 Docling Graph 固定提交 `bbcd0e4846fadfcadac2800784783e59cd2722a9` 的 direct/prompts.py、document_chunker.py、many_to_one.py、provenance/binder.py；同类能力尽可能参考其代码实现，记录本地函数映射和取舍，不整体移植框架。本轮修订没有宣称已重新验证上游代码。

## 核心接口与职责

| 组件／文件 | 保留或修改的职责 |
| --- | --- |
| python/contact_worker/parser.py、src/contracts/contact-graph.ts | 完整文本、顺序和原块来源；可选章节标签仅作模型提示 |
| src/contacts/document-extractor.ts | 输入预算、模型请求、逐项校验、临时经历结构映射；保留 DocumentExtractionResult 对外接口 |
| src/contacts/import-service.ts | 接受已映射候选和关系，自动保存；不通过原文关键词重新决定语义 |
| rust/contact-graph/src/validation.rs、import_commit.rs | 类型、证据结构、端点、权限、版本、事务及幂等；移除本导入路径的语义正则和完整值包含门槛 |
| tests/contact-extraction.test.ts、tests/contact-management-e2e.test.ts、tests/contact-recall-acceptance.test.ts | 分别验证模型输入与映射、真实入库、产品闭环 |
| docs/superpowers/specs/contact-data-contract.md、docs/QUICKSTART.md、skills/salestools-contact-management/SKILL.md | 同步自动抽取、待核实、查询和修正语义 |

LLM 返回“一份档案及其经历”，不要求它生成全局实体 ID 或在扁平节点之间配边。最小内部结构如下；在 document-extractor.ts 内定义 Zod schema，沿用现有属性 schema、字段路径和长度限制，不导出新的公共 API：

```ts
type QuoteRef = { block_id: string; quote: string };
type Fact = {
  field_path: string; value: unknown;
  evidence: QuoteRef[]; uncertain: boolean;
};
type LinkAssessment = { evidence: QuoteRef[]; uncertain: boolean };
type DocumentProfile = {
  subject_status: 'single' | 'ambiguous' | 'absent';
  person: Fact[];
  education: Array<{ local_id: string; organization: Fact[]; attendance: LinkAssessment }>;
  employment: Array<{
    local_id: string; organization: Fact[]; employment: LinkAssessment; role: Fact[];
  }>;
  projects: Array<{
    local_id: string; project: Fact[]; participation: LinkAssessment; role: Fact[];
    clients: Array<{ organization: Fact[]; client: LinkAssessment }>;
  }>;
  // 不能明确属于教育／任职／项目的组织线索，包括名片公司。
  organization_clues: Array<{ organization: Fact[]; association: LinkAssessment }>;
};
```

local_id 仅为本文件内经历引用，由首批模型给出并由程序校验唯一性；后续输入携带既有引用，模型明确返回同一引用才合并该经历，重复或冲突引用降为待核实。它不是数据库实体 ID；跨批主体只有 subject_status 为 single 且身份字段无冲突时沿用，模型指出多主体则停止自动选择。所有数组为空表示未提取，不补默认事实。uncertain 缺省按 true 处理；单个错误字段降为待核实，不让整份档案校验失败。未知路径不能进入正式属性，可按既有 review_items 保存。person 使用 properties／extensions 路径，机构和项目仅 properties，role 沿用 properties.role 路径。证据和不确定性按字段、按关系分别判断；可靠的项目名称不等于参与关系已可靠。

映射为既有 ImportCandidate[]：person → 一个主体；每条 education／employment → 机构及对应关系；每条 project → Project、参与建议和各客户建议。候选 ID 由程序分配。组织在同一文件仅对规范化完整名称一致且属性无冲突的项去重；项目按经历保留，不按同名自动合并；一机构多段任职保持多边。organization_clues 映射为既有 affiliation 的待核实建议，不伪装成 worksFor。

## Task 1：让 LLM 获得完整上下文

**Files:** Modify python/contact_worker/parser.py、src/contracts/contact-graph.ts、src/contacts/document-extractor.ts；Test python/tests/test_parser.py、tests/contact-contracts.test.ts、tests/contact-extraction.test.ts。

**Interfaces:** ParsedBlock 保留 block_id/text/page?/source_ref?，仅增加可选 layout_label；DocumentExtractorOptions 和 processedBlockIds/unprocessedBlockIds 保持兼容。

- [ ] **Step 1：写输入和预算失败测试。** 同一段教育／任职分成不同原块但完整请求能容纳时，拦截模型请求断言所有块一起发送，顺序和 ID 保留。旧块无标签仍可用；Docling 自身无图占位不进入模型，真实 OCR 不被过滤。超预算测试核对完整序列化请求（含提示词、上下文）未越界，不遗漏未处理 ID。

  ```ts
  expect(ParsedBlockSchema.parse({block_id:'b1', text:'教育背景'}).text).toBe('教育背景');
  // 在现有 fetch 桩中解析实际请求后断言，而非只测试独立拼接函数。
  expect(sentBlockIds).toEqual(inputBlocks.map(block => block.block_id));
  expect(Buffer.byteLength(requestBody, 'utf8')).toBeLessThanOrEqual(requestMaxBytes);
  ```

- [ ] **Step 2：跑红灯。** `rtk proxy python/.venv/bin/python -m pytest python/tests/test_parser.py -q`；`rtk npm test -- --run tests/contact-contracts.test.ts tests/contact-extraction.test.ts`。确认新增失败源于输入行为。
- [ ] **Step 3：最小实现。** 保留 Docling 给出的文字顺序和来源，透传可选标签；不构建 bbox 树或本地章节识别器。优先序列化全文件，实际请求放不下才按顺序装入多个原块；超长块按既有 UTF-8 安全拆分并保留父块映射。不得用只保留姓名、公司等关键词的方式缩减正文。
- [ ] **Step 4：实现受限跨段上下文。** 保留现有 requestMaxBytes 默认 12,288、maxBatches 默认 8、maxModelCalls 默认 16。后续批次携带受预算约束的已抽主体及尚未完整经历（来自模型结果）和对应少量原块引文，输入统一标识“已抽取上下文／新块”；只有原文引文能成为证据，模型摘要不能作为原文。程序仅按显式经历引用／ID 对齐结果和检查标量冲突，不重新猜语义。新块预算优先，无法容纳的上下文不暗中拼接，相关关系留待核实并告警。上下文只允许引用本任务已成功处理的原块；一个批次失败保留此前结果，失败或预算未覆盖部分列入未处理范围，不无限重试或额外添加 LLM 审核调用。
- [ ] **Step 5：跑绿灯并提交。** 重跑本任务测试、typecheck，保留 256 KiB 协议帧和不猜页码的回归。只提交本任务文件。

## Task 2：LLM 抽取档案与经历，适配器只做映射

**Files:** Modify src/contacts/document-extractor.ts；Test tests/contact-extraction.test.ts。

**Interfaces:** 采用上面的 DocumentProfile 内部输出，转换为原有 candidates/warnings/processedBlockIds/unprocessedBlockIds。现有预览、上传、搜索调用方无需切换接口。

- [ ] **Step 1：写失败测试。** 模型桩返回结构化档案，覆盖无标题教育、跨块雇主、匿名主体、多电话／邮箱／微信、多任职、多学历、项目＋客户及语义归纳技能。断言映射关系的端点和数量正确、归纳值不因 quote 不包含完整值而降级、同一主体重复技能正常去重。不能用“模型只给实体、程序靠标题补边”的测试作为新行为。
- [ ] **Step 2：写逐项降级测试。** 模型明确 uncertain、同一单值冲突、无效日期／号码格式、错误 block_id、伪引文、无证据、陌生字段分别进入待核实，其他有效字段仍保存。主体 ambiguous 时不强行建一个人；只有其他人资料不满足主体门槛。引用存在并不测试为语义已正确：雇主／客户／证明人等模型理解错误由 Task 4 真实样本验证。
- [ ] **Step 3：跑红灯。** `rtk npm test -- --run tests/contact-extraction.test.ts`。
- [ ] **Step 4：替换模型输出和提示词。** 在既有 JSON 请求中明确 DocumentProfile 形状。要求模型结合全文判断本人／证明人、雇主／客户／合作方、教育状态、任职时态、项目参与及技能；允许忠实归纳，未知留空，歧义标记。名片公司若模型可明确判断是本人任职单位，输出 employment；仅关联线索输出 organization_clues。项目使用嵌套经历表达客户归属，不要求“姓名、项目名、客户词同时出现在一个句子”。不改变公开网页 ContactExtractor 的限制。
- [ ] **Step 5：实现轻量校验与映射。** 按字段验证白名单、类型、长度、枚举和日期等确定性约束，核对每个 quote 是所指原块的子串，页码从解析块取，文件哈希从服务端取。字段不与 quote 做完整值相等／包含比较，不搜索全文件拼值，不新增模糊匹配。结构合法且有定位引文、模型无不确定标记、无显式值冲突时生成文件证据候选；其余调用既有 reviewField／review_items 路径。模型给了无效引文时不把它伪标为 located。

  ```ts
  // 目标控制流程；使用现有候选／review item 构造器，不新增持久化状态。
  const located = fact.evidence.length > 0 && fact.evidence.every(ref =>
    sourceBlocks.get(ref.block_id)?.text.includes(ref.quote) && ref.quote.trim());
  const eligible = validField && located && !fact.uncertain && !hasScalarConflict;
  // eligible -> 文件抽取属性或关系；否则 -> 带原因的既有待核实项。
  // eligible 不表示程序已验证语义正确或经过人工审核。
  ```

- [ ] **Step 6：删除重复语义推理。** 新文件路径不再调用 semanticReason、structuredInstitution、crossBatchInstitutionClaims、crossBatchProjectClaims、recoverLocatedProjectTitles，以及基于项目标题／相邻块／客户关键词的语义恢复。无其他调用者的辅助函数直接删除；共享函数只从本路径移除，避免影响其他入口。不保留旧规则作为“LLM 不确定时强行确认”的兜底；不确定就标记保存。
- [ ] **Step 7：跑绿灯并提交。** `rtk npm test -- --run tests/contact-extraction.test.ts`、`rtk npm run typecheck`。检查旧公开输出契约仍兼容，只提交本任务文件。

## Task 3：让自动提交与图谱校验接受新职责划分

**Files:** Modify src/contacts/import-service.ts、rust/contact-graph/src/validation.rs、rust/contact-graph/src/import_commit.rs；Test tests/contact-management-e2e.test.ts 和上述 Rust 模块测试；必要的共享样例更新 tests/fixtures/contact-contracts/。

**Interfaces:** 继续 commit_import／auto_create、ImportCandidate、evidence、review_items 和既有 claim；不新增数据库表、公共接口或人工确认前置步骤。

- [ ] **Step 1：写真实提交失败测试。** 模型抽取的跨块关系、归纳字段和匿名主体通过真实 Rust 图谱写入；get_contact 回读字段、来源及边。正式学校／雇主默认可检索；项目两跳正式时按客户找人。Project 有名或有描述均按既有最低门槛保存；不同任职不合并。
- [ ] **Step 2：写弱结果与安全边界测试。** 客户或参与某一跳 uncertain 时仅显式 include_unverified:true 命中并返回 claim_ids；缺参与建议不能静默丢掉项目经历，应保留主体上的项目描述／客户来源线索。organization_clues 生成待核实 affiliation，按名片公司显式查人。类型错误、不存在端点、跨主体证据绑定、版本冲突仍拒绝；引用失败不能因模型自信而正式入图。
- [ ] **Step 3：跑红灯。** `rtk npm test -- --run tests/contact-management-e2e.test.ts`；`rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml`。
- [ ] **Step 4：简化自动选边与事务校验。** isAutoSelectableInstitutionRelation／isAutoSelectableProjectRelation 只检查候选已选、合法类型与角色属性、可定位文件证据、模型不确定性是否已降级；删除直接陈述／标题／客户关键词和 quote 包含机构名或项目锚点的语义门槛。同步 hasLocatedName、projectAnchor、角色字段检查及 Rust 对应检查：保留名称／描述等最低资料要求，移除完整值必须出现在单条引文的要求，不另建多片段拼值算法。
- [ ] **Step 5：保持证据边界。** 原文引文定位由持有解析正文的 Node 文件抽取路径负责，Rust 不持有全文，不宣称重新验证原文。Rust 保留证据路径、值绑定、来源类型、服务端来源元数据、关系端点和事务约束；调用方不能通过公开输入自封“已核实”。人工和网页证据的既有约束不放宽。每跳独立降级，可靠项目可建节点，弱参与关系存 claim；不满足节点门槛的经历至少留在主体 review_items，保存失败或超限必须告警。
- [ ] **Step 6：跑绿灯并提交。** 重跑 Node／Rust 测试及 typecheck、cargo fmt --check。同一 operation_id 重放不增殖节点和边，匿名主体用 save_contact 补姓名后 ID 和关系不变。只提交本任务文件与样例。

## Task 4：按用户场景验证，更新说明

**Files:** Modify tests/contact-recall-acceptance.test.ts、docs/superpowers/specs/contact-data-contract.md、docs/QUICKSTART.md、skills/salestools-contact-management/SKILL.md；Create tests/fixtures/contact-documents/layout-single-column.pdf、layout-two-column.pdf；Reuse synthetic-card.png。

- [ ] **Step 1：固定回归。** 两份相同虚构资料不同版式 PDF，经真实 Docling、模型桩、真实 SQLite 提交回读，验证映射与保存。保留以下矩阵；测试桩不能证明 LLM 语义理解正确。

| 场景 | 必须验证的用户结果 |
| --- | --- |
| 多联系方式、技能重复／归纳、跨块值 | 不丢有效项，可回读来源；无新增字符串唯一性门槛 |
| 匿名简历 | 可建档，按学校／公司找到，补姓名保持 ID |
| 多学校、多段任职 | 经历各自保存，在读不冒充毕业、求职意向不冒充现任 |
| 两个项目及不同客户 | 不串客户，人物可回读项目，正式／弱两跳分别查询 |
| 名片公司、证明人单位 | 明确任职入图，不明关联带标记可查，证明人不混入主体 |
| 无标题／跨页／不同栏数 | 共同抽取结构及图谱映射可用，不增加模板专用规则 |
| 核对与修正 | get_contact 按 claim_ids 翻页 → review_contact_claim 确认／拒绝 → 查询状态变化；错误值经 save_contact 修改回读 |
| 预算耗尽／部分模型失败／OCR 无正文 | 返回已处理和未处理范围，保留已有结果，不将未读取说成已保存 |
| 重放和重复文件 | 同 operation_id 幂等；新操作沿用重复提示，不自动合并 |

- [ ] **Step 2：真实 LLM 跨版式验收。** 在隔离临时库用当前 .env 模型跑上述两份虚构 PDF 和名片，禁止用固定候选替代模型。先写人工预期清单，再逐项核对提取、归属、保存、检索：可辨且归属明确的必需项均可查；预设歧义项带标记保存；错误主体归属和客户误当雇主为零。未达到预期先检查 Docling 正文、模型上下文、提示词及临时结构，不用新增正则或强制转正式掩盖失败。
- [ ] **Step 3：真实简历测试。** 用 /Users/tang-codeing/Downloads/J运维简历.pdf 跑真实模型和隔离图谱；核对唯一 Person、可辨联系方式、学校、实习单位、技能、项目，以及学校／公司查询。无原文的字段不要求补造；确实无法判断的项说明原因并验证弱查询。记录脱敏计数、漏提取和误关联，不把预览成功当入库成功；清理临时资料。
- [ ] **Step 4：更新产品说明与跨语言契约。** 记录临时结构及映射、来源定位与语义理解的区别、模型抽取事实与人工核实的区别。删除旧契约中相邻标题、同页唯一职位、完整值包含等本地语义门槛。skill 导入结果报告已保存、待核实和未处理范围；综合查找带标记展示弱结果，默认正式 API 语义不变。说明通过现有工具后续修正，无逐项人工审核前置；重放不是重新提取，不承诺尚未实现的断点续跑。
- [ ] **Step 5：全量验证。** 先 `rtk cargo build --locked --manifest-path rust/contact-graph/Cargo.toml`；再 `rtk proxy python/.venv/bin/python -m pytest python/tests/test_parser.py -q`、`rtk npm test -- --run`、`rtk npm run typecheck`、`rtk npm run build`、`rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml`、`rtk proxy cargo fmt --check --manifest-path rust/contact-graph/Cargo.toml`、`rtk proxy git diff --check`。来源／结构负例须通过，不能因删语义正则而删除这些保障。
- [ ] **Step 6：提交验收与文档。** 仅提交本任务文件和虚构样例；不提交 .env、真实个人资料、完整模型响应或临时数据库。

## 不在本次范围

不更换 Docling、不增加视觉模型／二次语义审查模型、不提高默认调用预算、不训练模型、不建立排版模板或本地语义引擎、不扩建 UI 或数据库、不自动跨文件合并。本次不保证 OCR 无法辨认的材料仍能完整抽取；对已抽但不确定的信息标记保存，对未处理范围如实报告。

## 修订后的验收原则

产品审核七项缺口全部保留：跨块与重复值（Task 1–3）、项目客户闭环（Task 2–4）、匿名档案（Task 2–4）、名片关联（Task 2–4）、教育任职语义（Task 2/4）、修正和部分处理反馈（Task 3/4）、真实模型跨版式（Task 4）。变化在实现职责：语义问题由 LLM 理解及真实样本验证，程序负责来源、结构、映射与可靠保存。

实施进度与审查结论记录在本计划专属的 `.superpowers/sdd/2026-09-28-docling-resume-structure-relations-fix/progress.md`；复选框未逐项回填，不能据此判断代码或真实验收状态。

## Task 5：根据真实模型验收修复漏提与误关联

**触发证据：** Task 4 的脱敏报告记录：同样的虚构单／双栏简历出现联系方式合并、Link 形状错误、证明人单位误作客户、弱组织名称不可检索；真实用户简历多轮结果不稳定，曾有 25/75 块未处理。固定模型桩与全量单元测试通过不足以关闭本任务。

**Files:** Modify `src/contacts/document-extractor.ts`、`tests/contact-extraction.test.ts`；仅在查询／claim 表达确需修复时触及 `src/contacts/import-service.ts`、对应 E2E；沿用 `tests/run-real-contact-acceptance.ts` 与预期清单。

- [ ] **Step 1：固定失败输入。** 只在隔离临时库读取虚构样本真实模型的脱敏结构诊断，确认 Link 的错误键形状和合并联系方式的格式；不保存完整响应。把可确定的格式问题写成模型桩失败测试：多值 Fact、Link 可恢复与不可恢复形式、弱组织名称、证明人机构排除、同一资料不同块顺序。
- [ ] **Step 2：跑红灯。** `rtk npm test -- --run tests/contact-extraction.test.ts tests/contact-management-e2e.test.ts`，记录新增用例失败原因。
- [ ] **Step 3：最小修复。** 在现有提示词加入短小、完整的 Fact／Link／嵌套项目示例，要求电话、邮箱、技能逐项输出、字段不确定性与关系不确定性分开、证明人及其单位不归主体／客户；保持输入预算。程序只做确定性的格式容错（例如能逐项验证的分隔联系方式），不能靠版式、客户关键词或正则推断雇主／参与。对结构不完整的 Link 保留真实来源和待核实状态，不强制升为正式。可定位、字面明确的机构名称即使关系不确定也应可作为检索锚点；不能确定归属时保留可按名称搜索的弱 claim，不能虚构正式机构关系。无效模型响应可在现有 maxModelCalls 内受限重试一次，不得使已成功批次丢失或静默越预算。
- [ ] **Step 4：跑绿灯和真实验收。** 跑相关测试与 typecheck；用 Task 4 runner 的虚构单栏／双栏／名片及用户真实 PDF 在隔离库重测，每份都核对预期技能、多联系方式、学校／雇主、项目参与及客户两跳、证明人排除、弱名称可查、已处理范围。真实 PDF 至少连续两次分别达成可辨必需项；不拼接两次结果。不满足则继续按实测原因修复，不降低验收阈值或转为人工必选。
- [ ] **Step 5：复验与记录。** 通过后重跑 Task 4 的全量检查，脱敏记录每份样本的提取、保存、正式／弱检索结果和剩余限制；提交产品修复及测试，不提交用户资料或模型原文。
