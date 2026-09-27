# submit_assessment 前两阶段升级实施计划

> **状态：已暂停（2026-09-19，用户明确要求）。** 当前优先完成报告有效性与内容质量优化；本文不再作为当前执行计划，未经后续确认不启动执行机制升级。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提交前发现主体问题，使任务有明确时限、真实进度，并优先覆盖材料的首次模型调用，准确报告处理与引用情况。

**Architecture:** 保留 SQLite、单进程 FIFO 队列和确定性机会规则。提交时固化主体快照；Worker 为每个任务建立独立取消上下文；Ark 使用两轮有界调度。进度与安全失败信息存入原任务表。

**Tech Stack:** 现有 TypeScript、Node.js、MCP SDK、node:sqlite、Zod、Vitest；不新增运行时依赖。

**Spec:** 本文是本轮升级的实施设计。依据本次用户确认的前两阶段范围，以及 `docs/superpowers/specs/2026-08-28-target-customer-assessment-mcp-v0.1-design.md` 的单进程、SQLite和来源降级约束；涉及旧接口时以本文明确的新增兼容字段为准。

## 范围与约束

- 阶段一：提交前检查、上游请求期限、任务执行期限、真实进度。
- 阶段二：首次调用优先、引用覆盖审计、错误分类和可操作失败说明。
- 不实现第三阶段缓存质量策略、规则版本缓存、自动刷新、任务断点续跑、通知服务或取消工具。
- 保留 `processing/completed/failed`；来源 `partial/failed` 不自动等同于整个任务失败。
- 保留30天画像与报告缓存、按信用代码复用进行中任务、`force_refresh` 不复制进行中任务。
- 保留任一有效 Token 可读取已知 UUID 报告的行为，不增加用户限流、配额、权限隔离。
- 不变更七产品机会规则、综合机会聚合、行业标签逻辑，不提高默认调用预算。
- 不保存上游原始响应或网页正文；新增的主体快照仅保存已核验 `IdentityProfile`。
- 历史任务和历史报告保持可读；未统计的历史覆盖字段返回未知，不补造数字。
- 上游取消表示停止本应用等待和继续调度，不能承诺供应商停止计费或远端计算。
- 全程使用脱敏日志，不输出 Token、Authorization、请求正文、完整上游响应。

## 目标接口与数据

提交参数与现有成功响应字段保持原样。未满足前置条件使用 MCP 工具错误，返回固定错误码和可执行建议，不创建任务。建议错误码：

- `PROFILE_REQUIRED`：先调用 `get_company_profile` 获取有效画像。
- `SUBJECT_MISMATCH`：名称与信用代码或待复用任务的主体不一致，请核对。

名称仅做 NFKC 和首尾空白规范化后比较，不做简称、集团或子公司模糊匹配；信用代码仍由既有 Schema 校验。

`get_assessment_status` 新增可空 `progress`，其内部采用以下形状；`get_assessment_report` 和提交成功响应的顶层字段不扩展：

```ts
type AssessmentProgress = {
  stage: 'queued' | 'collecting' | 'extracting' | 'rendering';
  started_at: string | null;
  updated_at: string;
  planned_batches: number | null;
  settled_batches: number; // 已获得最终成功/失败/跳过结果的批次，不是 HTTP 尝试数
  successful_batches: number;
  failed_batches: number;
  skipped_batches: number;
  error_code: string | null; // 固定安全码，不存上游异常文本
};
```

`status` 为最终状态，`stage` 为最后执行阶段。未开始任务 `started_at=null`；历史记录 `progress=null`。`message` 按实际阶段呈现，失败时说明阶段与固定错误原因。进度时间仅在状态变化或请求结束时更新，不使用心跳伪装进展。

任务表新增两个可空 TEXT 列：`identity_snapshot_json`、`progress_json`。通过现有 `PRAGMA table_info` 迁移方式添加；旧报告 JSON 无需重写。所有进度和终态写入均要求 `WHERE status='processing'`，终态不可被迟到响应覆盖。

默认期限（初始运维值，真实验收后可调整，不是 SLA）：

```ini
UPSTREAM_REQUEST_TIMEOUT_MS=120000
ASSESSMENT_TIMEOUT_MS=1800000
```

前者统一控制 QCC、豆包搜索、Ark 的单次请求，包括连接/响应体读取；后者从 Worker 实际启动计时，不包含排队时间。保持现有 `estimated_minutes=5-40` 兼容字段，工具描述明确它是历史经验区间、不包含排队，也不是任务截止时间。

## 文件分工

| 文件 | 变更职责 |
|---|---|
| `src/orchestration/assessment-service.ts` | 新任务前置检查、复用路径主体匹配、状态展示 |
| `src/db/assessment-repository.ts`、`src/db/schema.ts`、`src/db/database.ts` | 快照和进度持久化、兼容迁移、条件更新 |
| 新增 `src/contracts/assessment-progress.ts`，及 `src/contracts/index.ts`、`src/mcp/tools.ts` | 进度 Schema、响应映射、固定前置错误 |
| 新增 `src/orchestration/assessment-context.ts` | 任务独立取消、总期限、计时器清理 |
| `src/index.ts`、`src/config.ts`、`.env.example` | 期限配置、任务依赖工厂与资源所有权 |
| `src/upstream/qcc/client.ts`、`src/upstream/qcc/assessment-research.ts` | 连接和工具调用期限、取消与错误分类 |
| `src/upstream/search/doubao-client.ts`、`src/upstream/ark/client.ts` | fetch/响应体期限、取消、HTTP 分类 |
| 新增 `src/orchestration/ark-batch-executor.ts` | Ark 首轮/重试轮调度、进度回调和批次结果 |
| `src/orchestration/assessment-runner.ts`、`src/orchestration/retry.ts` | 编排、超时收尾、单次尝试复用、停止规则 |
| `src/contracts/result-audit.ts`、`src/report/build-report-model.ts`、`src/report/render-markdown.ts`、`src/logging/logger.ts` | 覆盖语义、错误阶段与报告说明 |

## 阶段一

### Task 1：提交前验证与主体快照

**Files:** 修改提交服务、任务仓库、数据库迁移、MCP 映射、`src/index.ts`；测试 `tests/assessment-service.test.ts`、`tests/db.test.ts`、`tests/mcp-tools.test.ts`。

**接口约定：** `AssessmentServiceOptions` 注入现有画像仓库和 `profileCacheTtlDays`。`createOrReuseAssessment` 增加同步的 `beforeCreate: () => IdentityProfile` 参数；先检查并验证可复用任务的名称/信用代码，只有新建分支才执行该回调并保存快照。回调不得进行网络调用，不允许在 SQLite 事务内 await。

- [ ] 新增失败测试：有效代码但没有画像、画像过期或名称不匹配时，MCP 明确错误；数据库任务数和队列调用数均保持零。
- [ ] 新增测试：已有进行中任务/有效缓存匹配时复用，即使画像缓存已过期；同代码但名称不匹配不允许复用。`force_refresh=true` 仍复用进行中任务。
- [ ] 新增测试：合法新任务存储主体快照；排队跨过画像有效期后仍使用该快照；Worker 验证快照主体必须匹配任务，错误快照不能继续采集。
- [ ] 运行 `rtk npm test -- --run tests/assessment-service.test.ts tests/db.test.ts tests/mcp-tools.test.ts`，确认失败来自新行为未实现。
- [ ] 实现可空列迁移、输入规范化、前置检查和事务内快照写入；旧任务没有快照时保留现有画像检查兜底。
- [ ] 在 MCP handler 中仅捕获已知前置错误，输出 `isError:true` 和固定错误码/建议；其他异常沿用既有错误处理，不把错误包装成成功 Schema。
- [ ] 重跑定向测试、类型检查。提交：`feat: validate assessment identity before enqueue`。

### Task 2：持久化最小进度

**Files:** 新增进度契约；修改任务表迁移/仓库、Runner、状态工具映射与 Schema；测试 `tests/db.test.ts`、`tests/contracts.test.ts`、`tests/assessment-runner.test.ts`、`tests/mcp-tools.test.ts`。

**接口约定：** `updateProgress(id: string, progress: AssessmentProgress): boolean` 返回是否更新到 processing 任务；终态返回 false、不回退任务。`AssessmentRecord.progress` 可空。

- [ ] 测试新任务为 queued；实际开始采集才记录 started_at；Ark 规划完成才填写 planned_batches；报告生成前进入 rendering。
- [ ] 测试已结束批次数与最终批次结果一致，重试中的批次不重复增加 settled_batches；旧报告状态接口返回 progress=null。
- [ ] 测试 terminal 后写进度不生效；更新进度失败必须安全结束任务或暴露固定持久化错误，不能继续发起收费请求却丢失任务状态。
- [ ] 先跑失败测试，再实现 `progress_json` 迁移与进度映射；本阶段在现有两批一组执行器中接入进度，Task 5 替换调度器时保留契约。
- [ ] 完成/失败写入同时保留最终进度，失败码和阶段可读；不增加队列位置、百分比或心跳表。
- [ ] 跑上述测试及 `rtk npm run typecheck`。提交：`feat: expose persisted assessment progress`。

### Task 3：每个上游调用可超时、可取消

**Files:** 修改三个上游 client、QCC collector 接口、`src/index.ts`、配置；测试 `tests/qcc-adapter.test.ts`、`tests/doubao-search.test.ts`、`tests/ark-adapter.test.ts`、`tests/config.test.ts`。

**接口约定：** client options 提供 `signal?: AbortSignal`、`requestTimeoutMs?: number`；QCC connection 的 `callTool` 接收本次调用取消/期限参数。请求组合应用关闭信号、任务信号、单次超时信号。

- [ ] 使用假的计时器和可控 HTTP 服务验证：连接挂起、已响应 headers 但 body 挂起均在期限内结束；成功请求后移除监听并清理计时器。
- [ ] 检查仓库锁定 MCP SDK 的真实声明，使用其支持的 request signal/timeout/maxTotalTimeout 选项；验证连接初始化也有期限。不能仅以 Promise.race 返回错误而保留未取消 I/O。
- [ ] QCC 采用任务独立 gateway，由该任务最终关闭；画像服务保留自己的 gateway。避免某任务超时关闭共享连接，影响画像查询或其他任务。
- [ ] 测试两个并行任务：取消 A 不影响 B；同任务融资和招聘并发时一个请求超时不取消另一个；正常结束只清理本任务资源。
- [ ] 新增配置正整数和合理上限校验（单次最多600000ms、任务最多7200000ms，单次不大于任务）；默认均使用本文值，不读取或输出真实 `.env` 凭证。
- [ ] 先运行失败测试，再实现最小取消传播和期限清理。应用关闭信号优先识别为 ABORTED，单次超时为 TIMEOUT。
- [ ] 重跑 client/config 和生命周期测试。提交：`fix: bound upstream requests with isolated cancellation`。

### Task 4：任务执行总期限与部分报告收尾

**Files:** 新增 `assessment-context.ts`；修改 Runner、依赖构造、FIFO 队列相关测试；测试 `tests/assessment-runner.test.ts`、`tests/queue.test.ts`、`tests/lifecycle.test.ts`。

**接口约定：** `createAssessmentContext(shutdownSignal: AbortSignal | undefined, timeoutMs: number)` 返回 `{ signal, deadlineAt, dispose }`；用任务 signal 构建本任务 QCC/search/Ark 实例。`dispose()` 清理自有计时器与监听，不取消其他任务。

- [ ] 测试 queued 不消耗执行时间；开始 Worker 后启动期限；总期限触发停止新请求及重试，取消在途请求。
- [ ] 测试截止时已完成 Ark 批次保留：只合并已成功通过验证的结果，生成部分报告并写明“执行时限已到，剩余材料未处理”；无成功批次则 failed，错误码 ASSESSMENT_TIMEOUT。
- [ ] 将已成功批次即时收集，而非等同组所有请求完成才保存到内存列表，防止同组另一个挂起请求吞掉已有成果。
- [ ] 明确总期限是上游执行停止期限：取消后允许一次本地合并/渲染/SQLite 终态写入；该收尾不调用网络。单进程同步渲染无法保证硬实时毫秒截止，不对外承诺。
- [ ] 防止迟到响应提交结果；终态条件写和完成标志共同保护。取消属于任务级，不拿应用全局 abortController 取消单任务。
- [ ] 使用忽略 signal 的模拟依赖验证：在期限处结束 Runner 等待、阻止其结果参与后续流程，并消化迟到 rejection；真实适配器测试必须另外证明 I/O 取消，二者不能互相替代。
- [ ] 测试任务 A 超时后队列任务 B 启动，预算不继续增长；应用关闭的中断语义保持，不把关闭伪装成正常部分完成。
- [ ] 跑任务/队列/生命周期/客户端定向测试及类型检查、构建。提交：`fix: finalize assessments at execution deadline`。

**阶段一交付门槛：** 合法新任务可完成；无画像立即拒绝；排队与运行区分；模拟挂起可结束并释放队列；已有证据可保留为部分报告。阶段二不得成为阶段一上线的前置条件。

## 阶段二

### Task 5：Ark 首轮优先与明确错误分类

**Files:** 新增 `ark-batch-executor.ts`；修改 Runner、retry、Ark client、安全日志；测试新增 `tests/ark-batch-executor.test.ts`，并更新 `tests/retry.test.ts`、`tests/ark-adapter.test.ts`、`tests/assessment-runner.test.ts`。

**接口约定：** 执行器消费 `plan.batches`、任务 signal、共享 `CallBudget`、`extractWithAudit` 和进度回调。输出按原批次索引排序的成功结果、失败/跳过原因及 HTTP 尝试数。从现有 retry.ts 提取 `attemptOnce`（消费一次预算、记录一次尝试）和 `isRetryable`；`retryOnce` 复用它，QCC/search 不改变最多两次的现有策略。

```ts
type ArkBatchOutcome = {
  batchIndex: number;
  status: 'completed' | 'failed' | 'skipped';
  attempts: 0 | 1 | 2;
  errorCode: string | null;
};
// completed 必须另外携带成功 extraction；不要使用可空结果模拟成功。
```

- [ ] 失败测试：4批、预算4次，第一批暂时失败；实际调用顺序先覆盖1/2/3/4，不允许第1批重试抢走第4批。
- [ ] 失败测试：4批、预算5次，第1批首轮失败；1/2/3/4后才重试1，每批最多2次。并发完成顺序不同不能改变合并顺序。
- [ ] 保留固定并发2和简单两批一组，不引入优先队列框架；首轮覆盖所有预算允许批次，第二轮按原索引重试可恢复失败批次。
- [ ] 首轮预算不足的未调用批次标 skipped/BUDGET_EXHAUSTED，HTTP attempts=0；已调用失败但无剩余重试预算的批次保留原始安全错误，不覆盖成“未调用”。
- [ ] HTTP 分类：401/403 AUTHENTICATION_ERROR、400/404/413/422 REMOTE_REQUEST_ERROR 不重试；408/TIMEOUT、429 RATE_LIMITED、5xx REMOTE_SERVER_ERROR、网络失败允许一次重试。无效 JSON/证据沿用不重试规则。
- [ ] Ark 认证失败或明显地址/模型参数错误时停止该来源的后续批次，保留既有成功结果；其余未调用批次标 SOURCE_UNAVAILABLE。413仅阻止该批重试，不据此宣告整个来源不可用。
- [ ] 重试前采用一次有上限等待：有效 Retry-After 按最多5秒执行，否则1秒；等待受任务 signal 取消且不超出剩余期限。等待不计 HTTP 次数，不另加配置项。
- [ ] 测试超时/关闭发生在首轮、轮间、重试等待时均无新调用；总预算、单源预算和真实日志尝试数一致；全部失败仍明确 failed。
- [ ] 安全失败码贯穿进度与日志。已知错误可解释为“整理阶段认证失败/超时”，未知异常输出固定 INTERNAL_ERROR，禁止直接输出 cause。
- [ ] 跑上述测试及 `tests/call-budget.test.ts`。提交：`feat: prioritize first-pass Ark batch coverage`。

### Task 6：区分输入覆盖、有效引用与跳过原因

**Files:** 修改结果审计契约、Runner/批次执行器、报告模型/渲染和 logger；测试 `tests/contracts.test.ts`、`tests/report.test.ts`、`tests/assessment-runner.test.ts`、`tests/logging.test.ts`、`tests/db.test.ts`。

保留既有计数，明确 `processedCount` 仅表示“已成功整理批次的输入材料数”。新增可选字段：`citedCount`、`uncitedProcessedCount`、`attemptedFailedBatchCount`、`skippedBatchCount`。旧数据字段不存在时解释为未知，不能推断引用数为0。

```ts
const citedIds = new Set([
  ...evidence.industryEvidenceIds,
  ...evidence.facts.flatMap(f => f.evidenceIds),
  ...evidence.financingRecords.flatMap(f => f.evidenceIds),
]);
// 仅统计与成功批次输入ID集合的交集；证据目录存在不等于被事实引用。
// 新报告：processedCount = citedCount + uncitedProcessedCount。
// 保留：originalCount = processedCount + unprocessedCount + deduplicatedCount。
// 兼容旧 failedBatchCount 含未调用批次的语义：
// failedBatchCount = attemptedFailedBatchCount + skippedBatchCount。
```

- [ ] 失败测试：3条成功输入只引用1条，输出 processed=3、cited=1、uncited=2；重复引用同ID只计一次。
- [ ] 测试行业、融资摘要、产品事实均计入引用；仅在 evidence 数组出现不计入；失败批次和未调用批次不能计入成功输入。
- [ ] 测试跨批去重/同URL去重不破坏计数守恒；原始条目与去重后条目必须分别说明。
- [ ] 报告增加简短覆盖段，呈现原始数、去重数、成功输入数、有效引用数、未处理数；说明未引用不代表无价值、无业务场景或没有采购需求。
- [ ] 区分请求失败、预算未执行、期限未执行、材料无法装入请求；优先在已有缺口段按原因聚合，不逐条刷屏，不保存原始材料。
- [ ] 不因为覆盖率低而修改七产品等级；不添加第二轮 LLM 总结或自动补采。
- [ ] 测试旧 result_json/Markdown 可读取，新报告渲染与结构统计一致；日志不包含正文和凭据。
- [ ] 跑覆盖/报告/数据库定向测试及类型检查。提交：`feat: audit extracted evidence citation coverage`。

### Task 7：文档、全量回归与一次真实验收

**Files:** 修改 `README.md`、`.env.example`、`skills/salestools-customer-assessment/SKILL.md` 中受本计划影响的说明；新增 `docs/validation/2026-09-19-submit-assessment-phase-1-2.md`，仅在真实执行后写入结果。

- [ ] 文档同步：请求/执行期限、排队不计执行时限、首轮优先、来源降级、进度、引用统计；删除已不符合代码的“固定8批”“串行批次”等旧描述。
- [ ] 全量验证：`rtk npm test -- --run`、`rtk npm run typecheck`、`rtk npm run build`、`rtk git diff --check`。隔离 worktree 内运行，避免主目录把嵌套测试重复扫描。
- [ ] HTTP MCP 集成测试：画像→提交→排队/采集/整理→报告；另测缓存复用、前置拒绝、超时释放、预算截断和历史报告兼容。测试阶段不用真实费用换取已能模拟的边界验证。
- [ ] 真实验收采用此前已确认主体“深圳市普渡科技股份有限公司 / 91440300359857967F”，执行一次正式任务；运行前确认本轮真实调用授权和实际预算。无本轮授权时保留为明确未完成的真实验收，不暗中消费。
- [ ] 记录代码提交、脱敏配置（模型标识、期限、预算，不含凭证）、任务ID、排队/采集/整理耗时、HTTP尝试数、批次结果、成功输入/引用/未处理数量、来源状态与七产品结果。认证失败立即停查配置，不重复创建任务碰运气。
- [ ] 真实验收只证明执行与可观测性；不得把一次 completed 宣称为销售准确率达标。若因供应商故障产生部分报告，分别报告已通过的机制和未覆盖的真实成功路径。
- [ ] 提交文档；本计划不自动授权 push、镜像发布或生产部署。

## 自审结论

- 六项升级要求分别由 Task 1–6 覆盖，Task 7 负责兼容说明与验收。
- 提交前校验保留缓存优先，快照解决排队跨TTL；没有新建数据库任务系统。
- 单请求期限和任务期限分别验证，任务取消不触发全局连接关闭。
- 阶段一可独立交付；阶段二沿用其进度字段，新增引用统计为可选，兼容历史数据。
- 尚未执行代码变更、数据库迁移或收费上游调用。
