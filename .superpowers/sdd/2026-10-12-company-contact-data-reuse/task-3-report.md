# Task 3 实施回执

## 范围

实现企业关联身份摘要、统一社会信用代码校验、只读自动判定与人工关联写入检查。加入过期画像的批量展示查询、已完成报告的批量摘要和分页目录，以及对应索引。共享 fixture 仅包含组织、画像与合成代码常量。

## 红绿记录

- 红：`node node_modules/vitest/vitest.mjs run tests/company-link.test.ts tests/company-context-repositories.test.ts`，2 个仓储用例因方法缺失失败，关联测试因模块缺失失败。
- 绿：同命令加 `tests/company-link-repository.test.ts`，3 文件、13 用例通过。
- `npm run typecheck` 通过。
- `git diff --check` 通过。
- 未执行本地构建、dev、native、full-suite 或容器命令。

## 自审

- 写入先校验输入并检查 operation 回放；命中回放不读图谱。SQLite 提交后直接返回保存的回执，不再查询变动中的组织。
- 当前状态由 resolver 独立计算。撤销、归档、身份摘要变化、证据不完整及身份字段冲突会阻止跨库确认。代码自动确认要求有效校验位、白名单 propertyID、对应当前标识符的证据及当前法定名/曾用名证据；品牌或别名单独命中不会确认。
- 人工确认要求目标画像存在，并拒绝当前组织或冲突证据中的异码；报告摘要 SQL 只选目录字段，不选正文或快照。批量参数使用 `json_each(?)` 绑定。
- 图谱请求字段核对了 Task 2 协议，使用 `entity_ids`、`credit_codes`、`normalized_names`。测试只用了 mock GraphClient，未调用 native。

## 顾虑

- 图谱协议实现仍由 Task 2 同步完善；本任务未做真实 native 端到端验证。真实宿主验收及远程 CI gate 由后续整体流程完成。

## Fix round 1（Task 3 审查）

- 红：先补符合 native `total: null` 的写入回执测试，以及当前法定名矛盾、曾用名、别名单独相同、多有效代码、单条冲突证据排除的表驱动用例。运行本任务两文件，12 用例中 4 失败：法定名矛盾被错误确认、冲突证据遮蔽其他证据、`total: null` 被误拒。
- 修复：写入只校验完整单页、唯一匹配的 `entity_id` 和无后续游标；自动确认在存在当前法定名时只认该法定名及对应证据，缺失法定名时才用展示名；冲突证据按 `evidence_id` 单条排除，不一概拦下全部证据。
- 绿：`node node_modules/vitest/vitest.mjs run tests/company-link.test.ts tests/company-context-repositories.test.ts tests/company-link-repository.test.ts`，3 文件 19 用例通过；`npm run typecheck` 通过。报告摘要和分页目录均增加精确字段白名单断言。
- 自审：回放仍先于图谱读取；保存后的回执路径未变。单条冲突证据被排除后，如无其他当前值证据，最多进入 candidate，不自动挂报告。未执行本地构建/native/full-suite。真实 native 端到端仍依赖远程 CI。

## Integration fix round 2（跨语言规范化）

- 红：新增 native 形状 `credit_code`、`uscc`、ASCII 大小写及空白 propertyID、未知别名、有效异码人工确认、名称大小写和原值证据回归。`tests/company-link.test.ts` 17 用例中 8 失败，正对应审查的两处跨语言偏差。
- 修复：propertyID 经 NFKC、去空白及 ASCII 小写后，仅接受 Rust 的 `统一社会信用代码`、`credit_code`、`uscc`；名称及身份摘要同 `normalizeQccLegalName` 处理 ASCII 大小写。信用代码校验及原始证据值全等检查未改。
- 绿：`node node_modules/vitest/vitest.mjs run tests/company-link.test.ts tests/company-context-repositories.test.ts tests/company-link-repository.test.ts`，3 文件 26/26 通过；`npm run typecheck`、`git diff --check` 通过。
- 仍待：native/全套验证留给远程 CI。本轮未触发或取消任何 CI，未执行本地构建/native/full-suite。
