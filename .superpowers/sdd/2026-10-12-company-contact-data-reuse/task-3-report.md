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
