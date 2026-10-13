# Task 1 报告

状态 NEEDS_CONTEXT，红阶段已提交测试，等待控制器提供远程 Rust CI 红证据后进入实现。

## 红阶段

- `tests/contact-contracts.test.ts` 实际运行 `npx vitest run tests/contact-contracts.test.ts`，36 项中 35 通过、1 失败。失败为合法 Zoho 证据被 `ContactEvidenceSchema.safeParse` 拒绝，断言 false → true。
- `rust/contact-graph/tests/entity_write.rs` 使用现有 `Store` 和 `parse_and_dispatch` 覆盖 Zoho Person、Organization、worksFor 证据及无伪造 URL 回读；缺失定位、错误模块、未知来源、额外私密字段拒绝。
- `rust/contact-graph/tests/claim_review.rs` 覆盖空导入 Zoho duplicate 双端读取、拒绝审核、人工合并；文件/未知/不完整来源及非 duplicate 空关联拒绝；使用旧表 DDL 构建真实数据库并经 `Store::open` 重开两次，确认旧线索、索引、外键、原文件导入约束保留以及迁移后 CRM 线索写入。
- 测试只调用实际已存在方法，无新增生产代码。Rust 测试尚未本地执行或编译，遵守 AGENTS.md 的禁止本地构建要求，等待远程证据。

## 边界及顾虑

- 基线没有 ContactClaim TS schema 或类型。控制器要求不新增无消费者的通用 schema；绿色阶段检查现有实际输出/消费者，仅必要时补契约。
- 空 import_id 只允许白名单定位完整的 Zoho possible_duplicate 关系线索。
- 迁移测试包含额外旧索引，要求迁移保留现存显式索引，不能仅重建默认索引。
- 未访问真实 CRM、环境文件、密钥；未 push、merge、publish；未执行本地 build/cargo test/dev/docker。

## 绿色阶段

待控制器远程红证据及继续指示。
