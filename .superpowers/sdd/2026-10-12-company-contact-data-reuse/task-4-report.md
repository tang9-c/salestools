# Task 4 实施报告

## 实施

- 新增 `CompanyContextService`：批量摘要、详情、企业概览和后续资料。复用既有主体 resolver、画像、人工关联和报告仓储；只有 confirmed 结果读取跨库报告或参与统计。
- 组织和职业关系读取最多 20 页，每次请求透传同一个 `AbortSignal`；直接调用默认 30 秒总期限。取消在图谱 await 前后及同步 SQLite 查询前后检查并传播。
- 概览对已确认组织去重，按正式职业边计算人物和客户项目；分页不完整时只返回 loaded_count，精确 count 为 null。
- 后续资料合并图谱、画像和已完成报告摘要，去重排序后限 20 条。当前图谱协议若返回缺少 entity_id 的关系记录，本层省略该记录并标记 partial/truncated，避免编造归属。

## 红绿和实际结果

- 红：`node node_modules/vitest/vitest.mjs run tests/company-context-service.test.ts`，因 service 文件尚不存在，测试套件按预期失败。
- 绿：`node node_modules/vitest/vitest.mjs run tests/company-context-service.test.ts tests/company-context-repositories.test.ts`，2 文件、11 测试通过。
- `npm run typecheck` 通过；`git diff --check` 通过。未执行本地构建、native 编译或 full suite。

## 自审

- 测试使用真实内存 SQLite 仓储，仅图谱客户端为 mock；覆盖候选不泄漏、详情报告分页、自动匹配、撤销、人物去重、客户项目方向、部分计数、图谱故障报告可用、三来源后续资料、缺少图谱实体 ID 和第一页取消。
- 候选及读取失败的详情报告目录总数为 null，避免把未读取当作零。图谱 `Page.total=null` 不参与完成判断，以 complete/next_offset 判断续页。
- 仍需 Task 2 在原生图谱协议为关系和关系证据近期记录提供真实 `entity_id`；当前缺失时本层给出明确部分状态。远程 native/full-suite 验证由 CI 进行。

## 提交

- `feat(companies): aggregate existing company context`（本报告随同一提交保存；SHA 见 Git 历史）。

## 审查修正 round 1

- `overview` 分别记录报告源与图谱组织源是否成功。正常零报告仍是成功来源；报告源失败但图谱计数可用时返回 `partial`，两个来源均不可用时才返回 `unavailable`。没有增加画像查询。
- `relatedUpdates` 使用 `next_offset` 补读图谱近期记录页；无真实 `entity_id` 的项继续省略并标记部分结果。所有图谱近期请求共用最多 20 页预算，每个组织批最多收 20 条有效项，最后跨来源去重、排序、输出最多 20 条。预算用尽且仍有未读页时标记 `truncated` 和 `GRAPH_UPDATES_PAGE_LIMIT`；图谱有成功页时 `scope` 才包含 graph。
- 跨来源时间排序改为 `Date.parse` 得到的 epoch 降序；同一时刻按 kind、id 稳定排序。不同 RFC 3339 时区偏移的测试验证实际时间顺序。
- 红测：新增状态、续页和时区测试后，定向 service 套件 13 例中 3 例失败，分别复现 `unavailable` 误判、后页遗漏、时间顺序错误；零报告测试同时通过。
- 绿测：`node node_modules/vitest/vitest.mjs run tests/company-context-service.test.ts tests/company-context-repositories.test.ts`，2 文件 16/16 通过；`npm run typecheck` 通过。仍未执行本地构建、native 编译或 full suite。
- 剩余边界：实际 native 关系近期记录的 `entity_id` 依赖 Task 2 修正；本层持续拒绝编造该字段。原生协议与完整套件需远程 CI 对同一 SHA 验证。

## 审查修正 round 2

- 近期图谱的共享 20 次请求预算改为在请求发起前扣减，失败的请求也计入。预算耗尽时停止后续组织批，返回 `GRAPH_UPDATES_PAGE_LIMIT`、`truncated=true` 和部分状态。
- 红测：用真实内存 SQLite 写入 1001 个已确认组织，组成 21 个组织批；模拟每批图谱近期请求立即失败。修正前实际发送 21 次，违反 20 次上限。
- 绿测：`node node_modules/vitest/vitest.mjs run tests/company-context-service.test.ts tests/company-context-repositories.test.ts`，2 文件 17/17 通过；`npm run typecheck` 与 `git diff --check` 通过。未执行本地构建、native 编译或 full suite。
