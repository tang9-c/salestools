# Zoho Contact Graph Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zoho查询后按稳定来源键增量入图谱，不重复建人或覆盖其他来源。
**Architecture:** 一个Rust事务操作写现有表，一个Node同步入口连接已有查询与图谱；不伪装网页快照。
**Tech Stack:** Node.js/TypeScript、现有Rust图谱与SQLite。
**Spec:** ../specs/2026-10-13-zoho-contact-graph-sync-design.md

## Global Constraints

- CONTACT_GRAPH_ENABLED为唯一开关；不新增表、队列、配置、MCP工具或LLM调用。
- 不请求或持久化联系方式；Owner仅是CRM来源信息；employment_status=unknown。
- 保留旧证据/其他来源/归档与人工合并；同名不自动合并。
- 主库无关未提交文件不动；不合并、不发布、不读取真实.env或凭证。
- 禁止本地构建，包括cargo test引起的编译；Rust和全套/容器验收用远程现有只读CI。
- 需要远程编译的红测试先提交并报告，由控制器取得CI失败证据，再进入实现；不能用mock替代Rust验收。

### Task 1: 来源证据契约与重复线索兼容迁移

**Files:** src/contracts/contact-graph.ts、Rust store/relations/claims等来源校验与读取处；相关TS来源穷尽分支；tests/contact-contracts.test.ts；rust/contact-graph/tests/claim_review.rs及迁移测试。
**Interfaces:** ContactEvidence新增source_type=zoho，source_connection_id、source_module=Accounts|Contacts、source_record_id定位必填；source_url不伪造。ContactClaim的import_id允许null，仅来源为zoho的系统线索可无导入任务；原文件导入仍必须存在关联。旧库迁移保持记录/索引/外键。
- [ ] 先增加实际契约及旧库迁移/CRM线索读审测试，覆盖旧文件线索仍可读、空导入CRM线索及不合法来源拒绝。用parse_and_dispatch测试既有实际Store，不测试源码字符串。
- [ ] 本地跑npx vitest run tests/contact-contracts.test.ts；Rust测试提交后等待控制器远程红阶段。
- [ ] 最小实现契约、来源验证、同表迁移与读取/审核空关联；不得另建持久业务表或伪造导入任务。
- [ ] 定向解释器测试、npm run typecheck、git diff --check；报告Rust绿色需要远程CI，不称本地编译通过；提交任务。

### Task 2: Rust Zoho事务增量同步

**Files:** Create rust/contact-graph/src/zoho_sync.rs、rust/contact-graph/tests/zoho_sync.rs；Modify lib.rs、protocol.rs及必要的现有共享持久化helper。
**Interfaces:** sync_zoho_contacts输入{operation_id,actor,collected_at,companies:[ZohoCompany]}，返回{created,updated,unchanged,archived,entity_ids:string[]}。Owner/name/title/modified_at均使用现有白名单；不接受联系方式。
- [ ] 先写真实Store测试：重复计数/证据/版本不增、变化/空值/人工冲突、旧时间/回退、Owner元数据、多公司同人、双向重复线索及拒绝不重开、合并映射/归档、关键词与索引状态、事务拒绝非法字段回滚。测试联系人以固定record_id而非名称定位。
- [ ] 提交仅测试变更，报告给控制器，由远程Rust测试观测红阶段后再实现。
- [ ] 实现稳定来源键、source_json比较和单批事务；复用已有实体/关系/证据/线索持久化逻辑，不复制通用字段系统。旧字段证据不删除；人工/其他来源展示值不覆盖；同名仅线索。
- [ ] 变化标记实质内容索引版本；Owner更新不改变Person内容版本。相同输入不追加证据，缺失联系人不删除，已归档不恢复。
- [ ] 提交并报告；控制器远程Rust绿色及全库回归作为本任务验收，不进行本地构建。

### Task 3: 查询接入、大小分批、显示与端到端验收

**Files:** Create src/contacts/zoho-graph-sync.ts及tests/zoho-graph-sync.test.ts；Modify graph-client.ts、index.ts、zoho-contact-renderer.ts或现有warnings展示，相关工具测试、README、docs/PRD.md、skills/salestools-contact-management/SKILL.md。
**Interfaces:** Node sync(result:ZohoContactsOutput)返回内部计数和索引ID；GraphClient新增sync_zoho_contacts允许项。index的zohoContacts.get在service.get后按开关调用，继续返回原ZohoContactsOutput，图谱结果以warnings/Markdown告知，不改CRM status/complete。
- [ ] TDD验证开关关闭/待确认/空失败不写、partial只同步已有；多批累积计数、256KiB按字节而非人数截断、任一批超时/失败查询结果保留且警告准确。不得把graph字段混入SDK请求。
- [ ] 写最小同步入口，复用图谱请求超时及限制；不重新设计全查询时间预算。图谱写事务失败时不索引，成功实质内容entity_ids调用现有向量索引器，不依赖有上传提交发生才索引。
- [ ] 增加真实Rust Node集成测试：合成CRM响应→查询→同步→get_contact/search_contacts，重复查询无增长；只在远程CI运行native路径，不用旧本机binary充当源码匹配验证。
- [ ] 同步README/PRD/skill说明自动入图谱边界、连接ID稳定、同步状态和任职不确定性；不修改旧网页同步行为。
- [ ] 本地定向Vitest、typecheck、diff；控制器远程完整CI/native/App/容器；保存脱敏验收记录，只用合成CRM数据，不推main或发布。
