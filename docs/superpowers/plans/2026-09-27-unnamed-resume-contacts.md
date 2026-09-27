# 无姓名简历联系人最小改动实施计划

> **For agentic workers:** 实施时按任务逐项完成、验证；本计划不要求引入新子系统。

**目标：** 没有真实姓名和手机号的简历，经人工审核后仍可成为可检索的匿名 `Person` 档案，并能按已确认的公司或学校关系找到。

**架构：** 沿用现有上传、Docling 解析、候选预览、`commit_contact_import`、SQLite 图谱和 `search_contacts`。`Person.properties.name` 在匿名档案中缺失；稳定 `entity_id` 是身份键，“未具名候选 · ID 后缀”只在展示层生成。机构仍是 `Organization`，任职仍用 `worksFor`，就读或校友关系用 `alumniOf`。不建第二套简历库。

**技术栈：** TypeScript/Zod、Rust/sqlite-knowledge-graph、Vitest、Cargo tests。

**规格依据：** [联系人图谱跨语言契约](../specs/contact-data-contract.md)；其中“正式 `name` 非空”是本计划要修改的现行限制。

## 全局边界

- 只有 `Person` 可无 `name`；`Organization.name` 仍必填。无姓名不是空字符串、`null` 或占位姓名。
- 匿名人物至少有一项经过来源证据验证的非姓名业务属性，或一条经人工审核、具有原文定位证据的 `worksFor`／`alumniOf` 关系；否则拒绝创建空档案。
- `name` 一旦补录，必须有真实姓名的人工确认或文件来源证据；原 `entity_id` 不变。不用文件名、公司名、学校名或模型推测填充姓名。
- 公司或学校关系必须有明确归属；仅在简历中出现机构名不生成关系。跨文件的相似经历不触发自动合并。
- 原件和完整 OCR 文本仍不进入图谱；保留现有短引文、文件哈希与审核记录。手机号、邮箱、微信仍是可选值。
- 匿名档案可以被普通联系人搜索返回；搜索结果的 `name` 为缺失／`null`，另提供派生的 `display_name`。不得把内部图谱键或展示名当作真实姓名索引、向量内容或问答事实。

## Task 1：放宽人物姓名契约，保留入库约束

**文件：** `src/contracts/contact-graph.ts`、`src/contracts/contact-import.ts`、`rust/contact-graph/src/validation.rs`、`rust/contact-graph/src/store.rs`、`rust/contact-graph/src/import_commit.rs`、`rust/contact-graph/src/lifecycle.rs`、`tests/contact-contracts.test.ts`、`rust/contact-graph/tests/entity_write.rs`、`rust/contact-graph/tests/import_commit.rs`、`docs/superpowers/specs/contact-data-contract.md`。

- [ ] 先写失败测试：无姓名 `Person` + 有证据的技能可以创建并读回；无姓名、无字段、无关系被拒；无姓名 `Organization` 被拒；补录有证据的姓名后 ID 不变；没有姓名证据的补录被拒。匿名导入候选的 `can_commit` 允许在满足最低资料条件时为 `true`。
- [ ] 运行 `rtk npm test -- --run tests/contact-contracts.test.ts` 与 `rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml --test entity_write --test import_commit`，确认新断言先失败。
- [ ] 仅对 `Person` 将 `name` 改为可选；Rust 图谱库要求的内部 `Entity.name` 使用稳定 `entity_id`，但业务 `properties` 不写该值。编辑、合并、归档与读取路径均不得把内部名称回填到业务 `name`。从有名变无名的主动清除不在本次范围。
- [ ] 在 Rust 入库事务中执行“匿名人物须有已验证内容”的检查，不仅依赖 Node 的预览标志；导入 `create` 与普通 `save_contact` 使用相同规则。保留逐字段证据校验、幂等和版本检查。
- [ ] 更新跨语言契约文档和共享样例；复跑上述测试，断言通过。

## Task 2：让无名简历可审核提交，并正确保留机构关系

**文件：** `src/contacts/document-extractor.ts`、`src/contacts/import-service.ts`、`rust/contact-graph/src/import_commit.rs`、`tests/contact-extraction.test.ts`、`tests/contact-management-e2e.test.ts`、`rust/contact-graph/tests/import_commit.rs`。

- [ ] 先写失败测试：无姓名无手机号但有技能、学校或职位的简历仍出现候选；有足够已定位证据时可选 `create`；只有无定位字段或空候选不可创建；多人文件中归属不明的机构不关联任何匿名人物。
- [ ] 为明确陈述“该候选曾在甲公司任职／就读乙校”的块保留 `worksFor`／`alumniOf` 建议；不再以姓名存在作为生成或保留关系的前提。关系必须引用同批候选、短引文能定位、人工审核选择后才提交。`worksFor` 仍是一段任职一条关系。
- [ ] 匿名档案若仅靠关系满足最低内容，Rust 在同一提交事务内检查至少一条已选择、可落库且有定位证据的关系。任何端点、证据或版本错误使整笔提交回滚。
- [ ] 运行 `rtk npm test -- --run tests/contact-extraction.test.ts tests/contact-management-e2e.test.ts` 和上述 Cargo 导入测试，确认通过。

## Task 3：按公司和学校找到匿名人物

**文件：** `rust/contact-graph/src/search.rs`、`src/contacts/contact-search.ts`、`src/mcp/contact-search-tools.ts`、`rust/contact-graph/tests/search.rs`、`tests/contact-search.test.ts`。

- [ ] 先写失败测试：关键词“甲公司”经 `worksFor` 返回匿名人物；关键词“乙校”经 `alumniOf` 返回匿名人物；`organization_id` 对这两类关系均可过滤；仅在人物简历中出现机构文字但无已确认关系时不得命中。结果带稳定 ID、`name: null` 和 `display_name`，不返回内部图谱名称。
- [ ] 在现有 `search_keyword` 的关系子查询中加入 `alumniOf`，保留 `worksFor` 的职位过滤语义：指定 `job_title` 时只匹配任职，不把校友关系误判为职位。让机构名称关键词复用现有组织节点匹配；不新增搜索端点。
- [ ] Node 搜索服务为缺姓名结果生成 `display_name`，有名结果使用真实姓名。MCP schema 维持原搜索参数；向量文本仍只取有证据的业务描述字段。
- [ ] 运行 `rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml --test search` 和 `rtk npm test -- --run tests/contact-search.test.ts`，确认通过。

## Task 4：堵住姓名假设并完成端到端验证

**文件：** `src/contacts/contact-answer.ts`、`src/contacts/identity-match.ts`、`src/index.ts`、`tests/contact-answer.test.ts`、`tests/contact-management-e2e.test.ts`、`docs/QUICKSTART.md`。

- [ ] 先写失败测试：对匿名档案按 ID 问姓名，答“姓名尚未确认”，不生成姓名事实；按机构检索到匿名档案后 `get_contact` 可读其证据和关系；普通已命名人物问答不回归；无姓名或手机号不触发自动身份合并。
- [ ] 审查所有直接读取 `Person.properties.name` 的消费者；只在需要展示时使用派生名称。姓名问答和关系问答遇匿名端点时安全返回“姓名未确认”或仅基于可引用的机构事实回答，不把展示名交给大模型当作姓名。`resolvePeople` 仍只按真实姓名解析，不把匿名档案纳入同名候选。
- [ ] 更新快速开始：演示“上传无名简历 → 审核候选与机构关系 → 创建匿名人物 → 按公司／学校检索 → 日后补名”。说明原件不持久化、不同简历不自动合并。
- [ ] 运行 `rtk npm test -- --run`、`rtk npm run typecheck`、`rtk npm run build`、`rtk cargo test --locked --manifest-path rust/contact-graph/Cargo.toml`。验收以真实 SQLite 图谱端到端结果为准，不用只模拟搜索响应的测试代替。

## 不在本次范围

不做独立简历库、匿名档案自动去重、跨文件身份推断、姓名占位写入、批量迁移旧数据、公开网页 `get_contacts` 的行为改造，也不新增关系类型。现有已命名联系人及组织数据无需迁移。
