# 联系人字段归属修复验证记录

## 版本与范围

- 分支：`fix/contact-field-ownership`。
- Worktree：`/Users/tang-codeing/code/salestools/.worktrees/contact-field-ownership`。
- 基线 SHA：`e1986c3c0367e3025f9ea417d91fe4d52fd2dfb4`；实现提交／CI tested SHA：`659730b7af416624f6f0ab8c6d3b5a1fdb806291`。
- `git diff -- src rust tests | shasum -a 256`：`b2fb889cb8a6cbc427d8e9906c1fefb83a2af803acdaeef5c4f35c7edb2dc1c9`。此指纹仅包含实现／测试，不包含本记录及文档。
- 计划：[字段归属修复](../superpowers/plans/2026-10-09-contact-field-ownership-fix.md)。
- 仅合成资料，无真实简历、生产凭证或远端联系人写入；主目录无关改动未修改。

## 已实施

1. alumniOf 可保存 major、educationLevel、startDate、endDate，旧空对象兼容；TypeScript／Rust 逐字段证据及日期校验同步。
2. 抽取上下文明确的学校教育字段、雇主任职字段及项目参与角色纠正到相应关系；无效字段以指向机构／项目的关系待核实项保留。
3. 无法定位经历的 `$experience` 留作 Person 的审核线索，不允许直接确认成实体属性。非法 education.details 单独降级，保留合法学校和就读关联，避免阻断匿名有效主体。
4. 自动选择教育关系前核对每项文件证据；缺失／值不符时不选择该关系，不因此阻断有效 Person／学校创建。Rust 防御旧候选的机构个人字段 claim，跳过并返回警告。
5. 关系持久化写入全部已验证教育属性；不同非空教育详情独立保存，逐字段证据随关系保存。人工校正关系的审核流程同步。
6. PRD、字段契约及联系人 skill 同步。没有增加节点、表、配置、模型调用或职责字段。

## 本地验证（通过）

```sh
node node_modules/vitest/vitest.mjs run tests/contact-contracts.test.ts tests/contact-extraction.test.ts tests/contact-import.test.ts tests/contact-import-choice-limit.test.ts tests/contact-answer.test.ts
npm run typecheck
rustfmt --edition 2021 --check rust/contact-graph/src/relations.rs rust/contact-graph/src/import_commit.rs rust/contact-graph/src/claims.rs rust/contact-graph/tests/relationships.rs rust/contact-graph/tests/import_commit.rs rust/contact-graph/tests/claim_review.rs
git diff --check
python3 /Users/tang-codeing/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/salestools-contact-management
```

- 5 个 Vitest 文件，162 项通过。
- 类型检查、Rust 格式／语法解析、diff 检查通过；Rustfmt 不证明编译或运行正确。
- Skill 静态验证通过。独立只读场景测试：旧 skill 缺少专业落点、空技能及 `$experience` 边界；更新后能正确说明关系归属、不得直接确认未分配经历、空技能不应拒绝有效主体以及本科不证明毕业。不安装或发布个人 skill。
- 新增归属、匿名主体可选 details、教育预览缺失／不匹配证据、项目角色用例均观察过修复前失败、修复后通过。
- 只读代码审查曾发现教育属性未实际持久化、可选 details 丢弃整个教育条目、教育自动选择缺证据预筛选；三项均修复并复核。测试改为精确检查关系 properties，不用全文字符串包含证明字段入库。

## 远程验收

一次本地误选了依赖 native 的 `tests/contact-claim-review.test.ts`：5 项以 `GRAPH_PROCESS_ERROR` 失败，因为新 worktree 没有匹配源码的 Rust 二进制。未执行任何本地构建，也没有运行旧二进制替代验证。这不是已证明的业务回归，但不能把相关测试标为通过。

新增 Rust 关系／提交／审核测试及 `tests/contact-import-persistence.test.ts` 的 Node→Rust→SQLite→重启回读测试已在远程 CI 通过。覆盖同校不同教育详情、逐字段证据值不符时原子拒绝、机构非法待核实项跳过、目标被跳过仍保留候选来源且无伪造 ID、提交重放及人工校正教育关系。

用户授权合并 main 后，已提交并推送修复分支，运行现有 `.github/workflows/contact-upload-validation.yml`，未新增 workflow 或发布镜像。

- [CI run 37911888542](https://github.com/tang9-c/salestools/actions/runs/37911888542)，tested SHA 如上。
- `native-and-browser` 成功：类型检查、匹配源码的 Rust 编译／测试、服务端及上传页面构建、Python 29 项测试（另有 3 个子测试）、Vitest 67 个文件／1,310 项测试通过。
- 原先本地无法运行的 `contact-claim-review.test.ts` 5 项及 `contact-import-persistence.test.ts` 2 项在 CI 均通过。
- `production-container` 成功：生产镜像构建、Compose 隔离约束、普通容器 PDF／资源限制／后代进程清理 gate 均通过；整个 workflow 结论为 success。
- 后续仅更新本验证记录与计划执行状态，不修改已通过 CI 的实现／测试。用户授权合并到本地 main；不推送 main、不发布镜像、不改动生产数据。

## 历史数据与后续边界

原有错误学校 claim 未迁移、未拒绝、未确认。真实简历复测、合并联系人及修正历史记录仍需另外授权。共享超时／技能补充取消解耦和职责／贡献字段不在本次实现范围。
