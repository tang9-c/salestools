# 联系人字段归属修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 防止个人教育、任职信息污染 Organization，包括其待核实项；可选信息失败不阻断有效联系人创建。

**Architecture:** 沿用 Person、Organization、Project 和现有关系、证据、待核实记录。仅为 alumniOf 增加可选教育属性，在现有抽取映射内纠正上下文明确的错字段，无法确认的经历信息保留为联系人待核实线索，不自动变成正式事实。

**Tech Stack:** TypeScript/Zod、Rust contact-graph、SQLite、现有 Ark 抽取。

**Spec:** 本计划固化本次对话确认的“实体保存自身信息、关系保存特定经历、可选字段失败不阻断联系人”最小修正方案。

**执行状态（2026-10-09）：** 实现、文档、本地允许的验证及远程 Rust／真实存储／完整 CI／生产容器验收已通过。实现 tested SHA 为 `659730b7af416624f6f0ab8c6d3b5a1fdb806291`；详见 [验证记录](../../validation/2026-10-09-contact-field-ownership-fix.md)。真实简历导入与历史数据修正未执行，仍需另行授权。

## 全局约束与范围

- 不新增节点类型、表、服务、模型调用、配置、队列或状态；不调整 Docling、沙箱和部署架构。
- 不本地构建；解释器测试和 `npm run typecheck` 可本地运行，Rust 编译、真实存储集成及镜像测试走现有远程 CI。
- 不修改远端已有联系人，不自动迁移或确认旧错误记录；修复后的真实导入、历史记录修正分别取得用户授权。
- 保留现有 MCP 工具参数、旧空 alumniOf 属性及旧导入预览可读性；未知字段不获得正式写入权限。
- 这轮不新增职责／贡献字段、不推断毕业状态。它们不影响此次归属修复，延期；现有 description 支持保持不变。
- 技能为空、技能或经历字段校验失败不应降低有效主体的 can_commit。主体歧义、用户取消和必需基础流程失败继续遵守原规则；共享超时解耦另行处理。
- 保留仓库无关改动；不擅自提交、推送或发布。

## 一、锁定归属与接口

| 对象 | 自身字段 | 禁止混入 |
|---|---|---|
| Person | 姓名、个人联系方式、出生日期、技能、语言、个人证书 | 特定学校的专业和就读时间、历史任职当作当前职位 |
| Organization | 名称、别名、机构描述、联系方式、地址、legalName、identifier | 某人的专业、学历、日期、职位、个人技能 |
| alumniOf | 本人的该次教育经历 | 学校自身属性、自动推断毕业 |
| worksFor | 现有 role.roleName/startDate/endDate、任职状态 | 公司自身属性 |
| Project/memberOf | 项目自身信息／现有个人参与角色和时间 | 将个人角色写为项目属性 |

教育正式关系属性采用直接字段，避免为教育伪造 OrganizationRole：

```ts
// alumniOf.properties；所有字段 optional；{} 仍合法
{ major?: string; educationLevel?: string; startDate?: string; endDate?: string }
// 抽取 education 条目，旧响应省略 details 时按 [] 处理
{ local_id: string; organization: Fact[]; attendance: Link; details?: Fact[] }
// details 的证据路径
properties.major
properties.educationLevel
properties.startDate
properties.endDate
```

日期沿用 PartialDateSchema，文字字段沿用现有 text 限制。仅规范点号年月等明确日期格式，如 `2026.03 → 2026-03`；不补月份和日期。educationLevel 表示原文披露的教育层次，不等于取得学位。

待核实处理复用现有结构：

- 归属某个教育条目但字段无效：在 Person 上保存 **kind=relation、relation_type=alumniOf** 的待核实建议，properties 带该条目的教育字段，target 指向其学校；包含有效值及待核实值，不把无效值写入正式关系。继续保留候选 ID、原文证据；不同经历不同内容不能合并为一条。
- 归属任职／参与条目但字段无效：相同处理，复用现有 role 属性。
- 无法定位具体经历：在 Person 上保存 **kind=field、field_path=$experience**，value 为 `{kind, local_id?, organization_name?, original_field_path, value}`；这是待核实线索，不是正式字段，不允许直接确认成 Person 属性。采用现有 2048 字节和 100 条上限，超限沿用警告。
- 无法确认哪位联系人：保留该导入候选的审核线索，不自动绑定任意联系人。
- 未识别的机构字段：不挂入 Organization 待核实属性；保留 Person 的上下文审核线索（仅主体明确时）或候选 warning。不根据字段名猜值或制造新实体。

## Task 1：教育关系契约与真实存储

**Files:**
- Modify: `src/contracts/contact-graph.ts`
- Modify: `rust/contact-graph/src/relations.rs`
- Modify: `rust/contact-graph/src/import_commit.rs`
- Modify: `rust/contact-graph/src/claims.rs`（仅现有确认流程确实需要时）
- Test: `tests/contact-contracts.test.ts`, `rust/contact-graph/tests/relationships.rs`, `rust/contact-graph/tests/import_commit.rs`, `rust/contact-graph/tests/claim_review.rs`

**Interfaces:** 现有 ContactRelationSchema、Rust 关系验证及提交；输出兼容 `{}` 的 alumniOf.properties 与相应 relation evidence。

- [ ] 先新增契约断言：`alumniOf.properties={major:'软件工程',educationLevel:'本科',startDate:'2022',endDate:'2026'}` 合法，空属性合法，逆序日期／未知属性非法，Organization.major 非法。
- [ ] 将 alumniOf 从空属性关系分支独立出来；使用现有文字和日期验证，不改其他关系语义。证据路径增加上述四项，但正式实体字段白名单不增加专业和学历。
- [ ] Rust 同步验证并支持导入提交的教育字段证据匹配；仿照现有 role 字段，逐项核对路径、值、source/target 和引用，不只验证 `$relation` 后放行所有教育属性。
- [ ] 新增真实存储测试：提交后回读上述四字段；校正并确认教育待核实关系可持久化；`$experience` 不可直接确认成实体属性；引用值不符则拒绝，不部分写入。
- [ ] 本地执行 `node node_modules/vitest/vitest.mjs run tests/contact-contracts.test.ts`；Rust 测试走远程 CI，必须用本次源码生成的二进制，不使用旧本地程序代替。

## Task 2：抽取上下文与错误归属降级

**Files:**
- Modify: `src/contacts/document-extractor.ts`
- Test: `tests/contact-extraction.test.ts`

**Interfaces:** DocumentProfile.education 新增可省略 details；DocumentExtractionResult 和 ImportCandidate 不新增类型。以每个 local_id 为处理边界，在机构合并前处理归属。

- [ ] 新增最小夹具：原文 `本人 井冈山大学 软件工程 本科 2022~2026`；模型 education.organization 错放 `properties.major='软件工程'`，details 给其余教育信息。断言学校只留自身信息，专业和日期进入该次 alumniOf 的属性和关系证据。
- [ ] Education Schema 使用 `details: z.array(z.unknown()).default([])`，更新主提示：机构数组仅机构字段，教育个人信息进入 details；role 仅任职／项目参与。更新续批映射保留 details，不另起补充 LLM 请求。
- [ ] 在现有映射增加上下文明确的固定归属规则：education.organization 内 major/educationLevel/startDate/endDate 转该条目 details；employment.organization 内 roleName/startDate/endDate 转该条目 role。错放到 person 或无明确条目时，不猜学校或公司，转 `$experience` 待核实。
- [ ] 仍按现有原文引用、主体、值形状、日期冲突校验处理重定向后的 Fact；重定向只修复容器，不把 uncertain 或错误引用改成可靠证据。
- [ ] 无效教育／任职字段改为上下文完整的 relation review item，而非 Organization field review。可疑值不得出现在正式 properties；有效姓名和联系方式仍 can_commit=true。
- [ ] 新增断言：同校两段经历不同专业／日期不被机构去重吞掉；同公司两段任职分别保留；同项目不同参与角色不污染项目；错引用专业进入 Person 的关系待核实且学校 review_items 不含 major；缺技能、日期无效、details 缺失仍保留联系人；来源歧义不得自动分配。
- [ ] 执行 `node node_modules/vitest/vitest.mjs run tests/contact-extraction.test.ts`，先确认新增用例失败，再最小实现并全文件回归。

## Task 3：提交、审核、回读与防绕过

**Files:**
- Modify: `src/contacts/import-service.ts`（仅预览／选择确实需调整时）
- Modify: `rust/contact-graph/src/import_commit.rs`
- Test: `tests/contact-import.test.ts`, `tests/contact-import-persistence.test.ts`, `rust/contact-graph/tests/import_commit.rs`

**Interfaces:** 现有 relation_choices、review_items、get_contact；仍使用现有 relation claim，不增加独立经历表。

- [ ] 使用合成候选提交测试：Person 有姓名／电话、学校名称合法、专业引文失败，联系人和学校提交成功；Person 回读到指向学校的教育待核实，学校没有个人教育待核实字段。
- [ ] 覆盖 target 被跳过：教育待核实仍保存学校候选名称／来源，不产生伪造 graph ID；后续不得仅凭学校名称自动确认关系。
- [ ] 在 Rust 导入持久化边界防御旧／手工候选携带的 Organization 个人字段 review item：不存成机构 claim，跳过并返回脱敏 warning；不因此回滚有效联系人。正式 Organization 未知字段仍按原规则拒绝。避免只依赖新版 LLM 提示。
- [ ] 验证重复请求幂等、旧空教育关系回读、旧导入预览回读、旧非法 claim 可拒绝但不会因新契约让整个档案读失败；不同 local_id 的经历待核实在内容不同时不被去重。原子提交和现有版本校验不变。
- [ ] 本地跑不触发 native 构建的 TS 用例；真实 Rust 持久化、确认及回读必须由现有远程 `contact-upload-validation.yml` 验证。若 workflow 无对应用例，只扩展该测试步骤，不新建平台。

## Task 4：文档与验收

**Files:**
- Modify: `docs/PRD.md`, `skills/salestools-contact-management/SKILL.md`
- Create: `docs/validation/2026-10-09-contact-field-ownership-fix.md`（执行时生成，记录实际结果）

- [ ] 在 PRD 和 skill 写明节点／关系归属、教育层次不证明毕业、可选信息失败不阻断创建、`$experience` 不得直接当正式属性展示。
- [ ] 执行 `npm run typecheck` 和 `git diff --check`，本地相关解释器用例通过；远程 Rust／完整集成通过后才宣布完成。记录 tested SHA、CI run、成功／失败项。
- [ ] 如用户另行授权真实导入，用已授权简历建立预览，检查学校 major 为空、教育关系或关系待核实含专业、技能失败仍可提交；远端写入仍需明确授权，不自动合并或修改旧记录。
- [ ] 核对所有更改仅包含上述必要文件，无额外配置、表迁移、节点类型和模型请求。CI 构建与后续发布时 TS 与 Rust 必须来自相同 SHA。

## 完成标准与历史数据边界

1. 学校／企业的正式及新增待核实属性不再包含联系人个人经历字段。
2. 教育字段有明确存储位置；证据不足时有明确学校／经历上下文，而不是转移为无归属的个人字段。
3. 同一学校／公司共享节点，但不同经历的关系及审核信息不丢失。
4. 技能为空、无效专业或日期不阻断有效联系人创建；主体、引用安全规则未放宽。
5. 旧实体、空关系和旧预览可读，真实 Rust 写入／回读／审核验证通过。
6. 已有“软件工程”学校 claim 不自动搬迁。用户授权后以原文重新提取，人工确认对应教育经历，再拒绝错误 claim、写入正确关系；单独记录结果，不作批量数据迁移。
