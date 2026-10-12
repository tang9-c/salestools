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
