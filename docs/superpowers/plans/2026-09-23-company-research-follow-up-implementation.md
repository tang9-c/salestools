# 单企业定向追问 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个同步 `ask_company` MCP 工具，利用报告精简证据或定向补查回答单企业销售研究问题，且不改变七产品报告。

**Architecture:** 在现有评估完成事务中保存报告引用的精简证据快照；追问服务核对现有主体画像，优先使用 30 天内快照，必要时最多做 1 次企查查、2 次豆包搜索，并用 1 次方舟调用生成逐条带证据 ID 的回答。整个追问有请求级取消和 60 秒总时限，不进入评估队列。

**Tech Stack:** Node.js 24、TypeScript、MCP SDK、Zod、`node:sqlite`、Vitest；复用现有企查查、豆包搜索和方舟配置。

**Spec:** `docs/superpowers/specs/2026-09-23-company-research-follow-up-design.md`

## Global Constraints

- 只增加单企业一次性追问；不建设聊天会话、追问历史、持续监控或新队列。
- 原评估 Markdown、机会等级与推荐产品只读；追问不触发 `submit_assessment` 或重评分。
- 30 天为快照复用期，不做自动删除；不保存上游完整响应、补查结果或追问答案。
- 每问最多 1 次企查查、2 次豆包搜索、1 次方舟；不重试；整体 60 秒内明确返回并取消未完成请求。
- 只把主体归属已确认的材料用于事实结论；招聘不等于采购意向；网页文字不作为指令执行。
- 保留仓库既有未提交改动；实施阶段不要把无关文件加入提交。

---

### Task 1: 持久化可追问的精简证据

**Files:**
- Create: `src/contracts/company-question.ts`（快照和回答结构）
- Modify: `src/contracts/index.ts`、`src/db/schema.ts`、`src/db/database.ts`、`src/db/assessment-repository.ts`、`src/orchestration/assessment-runner.ts`
- Test: `tests/db.test.ts`、`tests/assessment-runner.test.ts`

**Interface:** `buildEvidenceSnapshot(research: ResearchBundle, model: ReportModel): EvidenceSnapshot` 为 `assessment-runner.ts` 内部辅助函数。快照仅包含 `model.evidence` 引用的 ID、对应 `ResearchItem` 的来源/主体/日期/有限摘录，以及 `model.facts` 中相关事实；摘录截断时标记。`AssessmentCompletion` 增加 `evidenceSnapshot`，随报告一起写入可空 `evidence_snapshot_json`。

- [ ] 先写失败测试：新报告能读回快照、旧 SQLite 自动补列且旧报告仍可读、快照不包含未被报告引用的原始材料。
- [ ] 运行 `npm test -- tests/db.test.ts tests/assessment-runner.test.ts`，确认新增测试先失败。
- [ ] 用现有 `PRAGMA table_info` 迁移模式添加可空列；在评估完成前按 evidence ID 连接 `ResearchBundle` 与 `ReportModel`，一次更新写入报告和快照。旧记录保留 `NULL`，不回填或解析 Markdown。
- [ ] 复跑上述测试；验证缺少或截断的摘录不会被表现为完整原文。

### Task 2: 定向材料获取与请求级时限

**Files:**
- Create: `src/orchestration/company-question-service.ts`、`src/upstream/ark/company-answer.ts`
- Modify: `src/upstream/search/search-plan.ts`、`src/index.ts`
- Test: `tests/company-question.test.ts`、`tests/doubao-search.test.ts`

**Interface:** `CompanyQuestionService.ask({ legalName, creditCode, question, assessmentId? }, signal): Promise<CompanyQuestionResult>`。服务从 `ProfileRepository.findFreshByCreditCode` 验证主体；按需从 `AssessmentRepository` 取指定或最新的已完成快照。方舟回答客户端接收问题、经确认的证据、请求级 `AbortSignal`，返回 `claims: { category: 'supported' | 'interpretation' | 'unknown'; text: string; evidenceIds: string[] }[]`。

- [ ] 先写失败测试：主体缺失/不一致在上游调用前返回 `failed`；指定报告不匹配或未完成时失败；第 30 天快照可复用、之后补查；旧报告无快照不被解析成证据。
- [ ] 再写补查测试：非动态问题明确提及快照中产品名称或来源标题且存在对应已确认事实时不补查；近期/趋势或其他问题补查；问题明显涉及招聘、融资或招投标时只选对应一个企查查工具，其他问题不强行调用企查查；网页查询最多两条且遵守豆包 100 字符限制。只有确认归属目标主体的结果可支持事实，别名仅匹配时列为待核实。
- [ ] 运行 `npm test -- tests/company-question.test.ts tests/doubao-search.test.ts`，确认新增测试先失败。
- [ ] 以一次请求的组合取消信号调用上游：企查查使用请求级 `QccGateway` 实例并在 `finally` 关闭；豆包搜索和新方舟回答客户端使用相同请求信号。内部截止早于 60 秒以留返回余量；不能只 `Promise.race` 而让上游继续运行。无重试，无新全局配置或队列。
- [ ] 方舟只发一次请求，沿用 `ARK_REQUEST_MAX_BYTES` 约束并告知未入选材料数；服务端验证 `supported` 结论至少有一条已确认主体证据、所有引用 ID 均真实存在，再渲染 Markdown。无有效材料返回 `insufficient`，方舟失败/超时返回 `failed`；单源失败但仍可回答时显示来源限制。
- [ ] 复跑测试，使用可观察的假上游验证超时后没有继续调用或写入；检查招聘证据不被表述为采购意向、无日期结果不形成定量趋势。

### Task 3: MCP 契约、集成与回归

**Files:**
- Modify: `src/mcp/tool-schemas.ts`、`src/mcp/tools.ts`、`src/index.ts`
- Test: `tests/mcp-tools.test.ts`、`tests/mcp-e2e.test.ts`

**Interface:** `ask_company` 输入 `{ legal_name, credit_code, question, assessment_id? }`；正常 `structuredContent` 包含 `{ status, legal_name, markdown, used_fresh_research, collected_at, sources }`，同时返回相同内容的文本块。`sources` 的 URL 和发布日期允许为 `null`；输入非法由 MCP 参数校验拒绝。

- [ ] 先写失败契约测试：工具列表从五个增为六个；输入字段严格校验；`answered`、`insufficient`、`failed` 均有匹配的文本和结构化内容，现有五个工具的输出不变。
- [ ] 写本地 HTTP 端到端测试：使用模拟上游确认主体、生成含快照的报告、追问 SolidWorks 招聘；报告及七产品结果前后完全相同。再测仅有画像无报告、单源失败和超时。
- [ ] 运行 `npm test -- tests/mcp-tools.test.ts tests/mcp-e2e.test.ts` 确认测试先失败，再接入新工具与服务。
- [ ] 运行 `npm run typecheck`、`npm test -- --run`、`npm run build`。核对 SQLite 旧库迁移和现有 MCP 工具契约；检查 Git diff 只包含本功能的代码、测试及必要文档。

## 验收交付

三个任务的测试均通过；新工具能用证据说明“岗位使用 SolidWorks”与“存在采购意向”的区别，并能对近期发布或扩张给出有日期的定性事实。失败、超时、无证据时不虚构答案；超时后上游调用被取消。旧报告可读，原七产品结果未改变。
