# 第一阶段：持续企业研究实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本文仅制定方案，不授权立即实施、提交、推送或部署。

**Goal:** 围绕现有七产品，将公开资料、招聘及联系人图谱证据结合为可继续、可更新、可追溯的共享企业研究档案。

**Architecture:** 在现有单实例 Node/SQLite 服务中增加独立研究模块，复用来源适配器、企业身份核验、图谱读取和确定性产品规则。新证据契约与版本不进入旧 assessments 表；新异步队列与旧评估隔离。旧 MCP 工具和历史报告保持兼容。

**Tech Stack:** Node.js 24、TypeScript、Zod、node:sqlite、现有 MCP SDK、企查查 gateway、豆包搜索、方舟 JSON transport、现有 Rust 图谱只读协议、Vitest。

**Next-stage contract:** [产品销售场景专题设计](../specs/2026-10-17-product-sales-scenario-design.md)，只落实本文列出的接口预留，不提前实现专题。

**Spec:** 本地 `docs/PRD.md` 第 11.1–11.2 节（Git 忽略）。本计划复述必要需求，避免另一 checkout 缺少本地 PRD 时无法执行。

## 1. 全局约束与交付边界

- 默认扫描七产品，有线索再深挖；显式指定产品时只研究该范围。产品键复用 `ProductKeySchema`。
- 输入企业须已通过画像确认法定名称与信用代码。不按同名自动关联集团、子公司或图谱组织。
- 所有有效 MCP 用户共享读取、继续、更新权限；记录操作者，不按 qx/st 隔离。
- 自动按缺口补查，标准预算内产出；继续解决缺口，更新检查新资料及判断变化。首版没有定时调度或通知。
- 首屏简要结论，证据在聊天中按需分页读取；读证据不访问上游。
- 招聘要求是强技能／使用线索，不能直接认定部署规模或采购意愿。个人技能加任职仅是关联线索；任职／项目使用必须有明确企业归属证据。
- 只实现第一阶段。不实现产品销售专题模板、拜访简报、企业排序、产品能力对比、CRM 写回或新 UI。
- 禁止任何本地构建（含 dev、native、页面和容器）。完整 native/browser/container 验证仅用现有远程只读 workflow。
- 不改旧 `ResearchItemSchema.source`，不伪造图谱 URL，不扩大旧问答材料预算；不更改产品评级规则。
- PRD 继续留在本地并忽略；本计划是独立 Markdown 文件，按现有 plans 目录约定可跟踪，但本轮不提交 Git。

## 2. 当前实现与复用裁决

| 现有实现 | 裁决 |
| --- | --- |
| `AssessmentRunner` 一次收集与分批抽取 | 保持原样；新 Runner 负责多轮补查，复用适配器与纯函数，不复制旧 Runner |
| `CompanyQuestionService` 同步问答、小预算、不存答案 | 保持旧行为；新功能使用独立 MCP 工具，避免悄悄把追问变为付费异步任务 |
| `CallBudget` 支持来源预算与模型调用预留 | 复用计数；最终阶段额度另由新研究policy保护，不能仅依赖reserveArkCalls；每次真实尝试（含失败、重试）都计数 |
| `CompanyContextService` 已有企业关联、关系与证据依赖检查 | 提取/公开最小只读组织解析入口供研究用，不修改旧 materials 输出和默认预算 |
| `get_contact` 已有证据和关系分页 | 复用并检查版本和分页推进；不用不分页的 list_relations 拉大图 |
| 项目仅保存 name/description，关系有 memberOf/clientOrganization | 使用原文与关系证明项目归属，不新增“项目必属雇主”的隐含规则 |
| `ResearchItem` 仅有 qcc/doubao_search | 新建研究专用证据契约；通过受校验适配器接入旧评级，不把图谱标为网页 |
| 上游部分 signal 是实例级 | 每个研究 run 创建独立来源客户端及 signal，结束关闭 QCC 连接；取消不能关闭旧评估使用的共享客户端 |

## 3. 数据与契约

### 3.1 三张新增业务表

使用原业务 SQLite，在 `SCHEMA_SQL` 中添加幂等建表；不改图谱库 schema。

1. `company_research_dossiers`：`dossier_id` UUID 主键、`credit_code` 唯一、确认的 `legal_name`、`created_by/created_at/updated_at`。每企业一个共享档案，版本维护各自的产品范围。
2. `company_research_runs`：`run_id` UUID、`dossier_id`、`actor`、`operation_id`、规范化 `request_hash`、`mode`、`base_version_id`、`request_json`、状态、进度、实际预算、停止原因、脱敏错误码、时间。`UNIQUE(actor, operation_id)`；状态 queued/running 的 dossier 建部分唯一索引，保证同企业只运行一个研究。
3. `company_research_versions`：`version_id` UUID、`dossier_id`、`run_id UNIQUE`、档案内递增 `sequence`、`parent_version_id`、`scope_json`、状态 completed/partial、`snapshot_json`、生成时间。`UNIQUE(dossier_id, sequence)`，正式快照不可原地覆盖。

快照保存限定长度证据摘录与定位、facts、claims、gaps、product_assessments、coverage、changes、source_status、budget_usage 和方法版本，不保存完整网页／简历或模型原始响应。每版本 JSON 上限 2 MiB；写入前整包验证，超限删去低优先级完整依赖组并记录省略，不能截断 JSON 或留下悬空引用。

产品范围的“最新”按每个产品最后覆盖它的有效版本解析。单产品更新不得冒充其他六产品更新；API 返回每产品 `as_of/version_id`。不自动将旧 assessments 转成新研究版本。读取最新版本时不自动拼接其他模板的旧结论；通过版本目录选择历史模板成果。

### 3.2 研究证据与结论

新建 `src/research/contracts.ts`，使用 snake_case 对外字段与现有 ProductKey：

```ts
type ResearchMode = 'initial' | 'continue' | 'refresh';
type RunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
type SignalKind = 'direct_use' | 'job_requirement' | 'associated_skill' | 'project_use' | 'supplier_project' | 'other';
type ClaimKind = 'supported' | 'strong_signal' | 'hypothesis' | 'unknown';
interface ResearchEvidence {
  evidence_id: string; source_type: 'qcc' | 'web' | 'graph' | 'assessment';
  source_key: string; title: string; quote: string;
  url: string | null; published_at: string | null; collected_at: string;
  valid_from: string | null; valid_to: string | null;
  company_scope: 'confirmed' | 'probable' | 'unverified';
  signal_kind: SignalKind; product_keys: ProductKey[];
  locator: Record<string, string | number>; required_evidence_ids: string[];
}
interface ResearchClaim {
  claim_id: string; kind: ClaimKind; text: string;
  product_keys: ProductKey[]; evidence_ids: string[];
  temporal_scope: 'historical' | 'current_supported' | 'unknown';
}
```

实现时 locator 用 source_type 区分的严格 Zod union：网页为 URL/发布方；QCC 为工具与记录定位；graph 为实体、版本、证据/关系 ID、原文件摘要/页码或 text hash；旧评估为 assessment_id 和原 evidenceId。不能允许模型自由提供定位或来源时间。

`evidence_id` 由来源定位＋摘录＋内容版本计算 SHA-256，继续研究相同材料稳定复用；`source_key` 表示原始文件／网页／记录，不以抽取字段数量增加独立来源数。人物姓名同名不做去重依据，图谱用真实 ID。

每项 supported/strong_signal 必须有合法引用，引用的依赖闭包必须完整。hypothesis 必须标为待验证且有推导依据；unknown 不得携带肯定使用结论。原文包含否定、计划或历史限定时不得移除限定词；冲突材料保留并降为待核实。

软件别名采用版本化代码常量（`software-aliases.ts`），仅作候选命中与规范名称，不代表能力等价。先覆盖七产品的英文/中文全名及明确别名；替代软件名称可由原文抽取，记录所属 CAD/CAE/PLM/QMS 类别和引文，未收录名称保持原文，不猜测版本、厂商或竞争关系。

### 3.3 下一阶段模板与版本预留（2026-10-17 补充）

第一阶段即实现 envelope：`schema_version:1`、`template:{id:'company_research',version:1}`、`method_version`、`effective_goal`、`product_keys`、`parent_version_id` 和 `evidence_base_version_ids`。run.request_json 固定模板及有效目标，snapshot_json 同时保留第4节的 product_goals，并包含严格的 `template_result:{kind:'company_research'}`；不新增专题 SQL 表或队列。

对外 template_id 允许识别 company_research/product_sales_scenario，但第一阶段只开放前者，后者返回 RESEARCH_TEMPLATE_UNAVAILABLE 且不写任务/不访问上游。服务端接受任务时固定模板版本，排队后不得静默换版本。模板只设代码模块入口，提供问题集合、结果 schema 和提示词；Runner 持有预算与执行权，不做动态插件平台。

为变化比较补充 ResearchClaim 的结构化 `subject_key/predicate/object_key`，源自已验证实体/产品/软件规范名；无法稳定归一的结论仅列为分析变化，不凭自然语言近似宣称事实改变。changes 分成 business_changes、method_changes、analysis_changes；模板、目标及方法变化不算企业事件。

新版本复制所引用历史证据的完整依赖组，保留原 ID/日期/定位；evidence_base_version_ids 仅记录输入来源，不代替版本内引用闭包。每产品覆盖信息返回 template/version_id/as_of。方法/schema 版本与模板版本分别管理。

读取未知 schema/template 返回 RESEARCH_VERSION_UNSUPPORTED，不强制按通用结果解码。启动发现已完成版本不兼容时禁用新研究写入口、允许读兼容历史，旧评估和其他功能继续工作；未知运行任务按恢复规则失败。未来回退须考虑存储兼容，不得静默写坏专题版本。

### 3.4 第一阶段最小读取契约与后续实现边界

第一阶段只实现持续研究自身需要的单企业/单产品读取，不提前实现拜访、比较的完整 ProductResearchContext。内部 `readProductContext(creditCode, product, asOf, versionId?)` 直接读取已存版本，返回产品对应的 version_id/template/schema_version/as_of/evaluator_version、coverage、该产品已存 claims/opportunity、证据时间及引用；不再复制一套事实结构，也不新增专用 product-context.ts/freshness.ts 模块。复用 repository/service 的读取逻辑，刷新优先级放入研究 policy.ts。

versionId 未传时，在 asOf 时点及当前读取快照内选择该产品最后覆盖它的 completed/partial 版本；未覆盖返回 researched=false、version_id=null、opportunity=null，不能给默认低等级。找到最新产品版本但质量不足时如实返回，不自动回退到更旧的有利版本。其它产品的更新不改变该产品的 version_id。显式版本需验证公司、模板兼容性与产品范围。ProductOpportunity 使用现有产品级契约，不能要求单产品调用提供七产品完整结果。evaluator_version 标识已有确定性规则与新证据适配语义，使用显式代码常量管理。

每版本保存各产品实际覆盖及 technical_gap_ids/knowledge_gap_ids/blocking_conflict_ids：knowledge 表示已调查仍未知的业务问题，technical 表示预算、截断、失败等未完成处理；scope_complete 按产品处理范围计算，不能直接复制 run.status。已有已验证结论和原始证据定位供未来消费者读取，不从报告正文重建事实。

证据复查元数据随版本保存，按 evidence_id 关联 last_checked_at、check_outcome（unchanged/changed/unavailable/not_checked）及尝试诊断，不参与证据内容 ID 的计算。last_checked_at 仅在实际重新读取来源并成功核查后记录；unavailable 保留旧成功值。读数据库、重渲染和复制历史证据不能更新时间；旧版本元数据不可回写。首次采集可标 unchanged 并记录检查时间，但发布时间未知仍不能支持近期事件/当前使用；复查历史招聘未变不改变其过去的招聘日期。来源不可访问不证明旧事实失效。

首期只按已存成功复查时间在 policy.ts 安排 refresh 优先级：招聘/软件/项目30天、基础业务/工程场景180天；未知日期或冲突优先核查。这是补查优先级，不提高事实强度，也不替代既有90/365天评级时机规则。

后续契约只保留设计约定，不列入第一阶段代码或测试交付：拜访阶段按真实消费者需要实现 freshness-policy@1 和充分度投影；比较阶段实现跨企业固定版本批量读取、timing_signals 与 known_blockers 的专用投影。完整 ProductResearchContext 在消费者实施时定义，复用前置实现，不重复建服务。其共同约束仍为：固定 assessed_at、输入版本及策略版本；时机/阻碍只来自已验证事实和引用，不从摘要或销售假设猜测；无证据表示未知；批量读取固定版本的 SQLite 短事务结束后才 await 图谱。第一阶段不增加批量读取 API、占位输出字段或第七个 MCP 工具。

## 4. MCP 接口与用户行为

新增 `src/mcp/company-research-tools.ts`，由开关控制注册；旧 tools 文件只增加注册调用。

| 工具 | 参数与结果 |
| --- | --- |
| `start_company_research` | initial：legal_name、credit_code、可选 products（默认七项）、goal（可选，1–1000字）、operation_id；continue/refresh：dossier_id、base_version_id、可选 products/goal、operation_id。另可传 template_id，第一阶段仅开放 company_research。返回 run_id/dossier_id/status/replayed 和固定 template |
| `get_company_research_status` | run_id；返回阶段、已完成轮次、来源状态、实际使用预算、停止原因和完成后的 version_id，不暴露内部提示词 |
| `get_company_research` | dossier_id 或 credit_code 二选一、可选 version_id；返回目标版本简要结论、产品覆盖时间、引用编号、缺口与 changes；version_id 必须属于档案 |
| `list_company_research_versions` | dossier_id、offset=0、limit=10（1–50）；返回稳定按 sequence 倒序的版本元数据和 next_offset；并发新增不保证 offset 快照，历史实体本身不可变 |
| `get_company_research_evidence` | version_id、可选 claim_id 或 product（互斥）、offset=0、limit=10（1–20）；按稳定 ID 排序，返回证据及 required_evidence_ids、total/next_offset，不请求上游 |
| `cancel_company_research` | run_id；所有有效用户可取消共享任务，记录取消者，重复取消返回现状；终态不覆盖、不删除版本 |

所有写入 actor 来自认证上下文，不能由参数注入。同一 actor/operation_id 同请求回放原 run；不同请求拒绝 `RESEARCH_OPERATION_CONFLICT`。存在活跃 run 时不同操作返回 `RESEARCH_ALREADY_RUNNING` 与其 ID，不错误地复用不同范围。continue/refresh 要求 base_version_id 为档案当前最新有效版本，否则 `RESEARCH_VERSION_CONFLICT`，返回最新版本提示重新读取。该字段仅作档案写入并发基线，不要求它覆盖本次全部产品；资料继承按下文逐产品固定，不能把两者混为一个版本。

initial 未传 template_id 默认 company_research；continue/refresh 未传时继承基线模板。客户端不能指定模板版本。第二阶段显式切换模板时要求 products，并用新模板默认目标合并 goal；同模板缺 goal 按下文逐产品继承已有有效目标。第一阶段不实现专题行为。

幂等先比较规范化客户端请求（含模板选择、范围与基线）并查重，命中后回放已固定的模板，不因服务器模板升级而重新接受或拒绝原操作。已有运行方法支持的模板版本不能静默替换。

同企业已有有效版本时，再次 initial 返回 `RESEARCH_ALREADY_EXISTS`，引导读取后 continue/refresh。若档案存在但尚无有效版本（例如首次失败、取消或重启后失败），且没有 queued/running 任务，则允许使用新的 operation_id 再次 initial：复用原 dossier_id，创建新 run，不删除原任务和诊断，也不要求 base_version_id。是否允许重试、检查活跃任务及创建新 run 在同一个短事务内完成，仍受队列和用户额度限制。原 actor/operation_id 的同请求始终回放原任务，包括失败和取消终态；不同请求仍返回 `RESEARCH_OPERATION_CONFLICT`，不能用重试规则绕过幂等。存在活跃任务时，新操作仍返回 `RESEARCH_ALREADY_RUNNING`。continue/refresh 仍必须引用有效基线，不承担无版本档案的重试。产品参数为空、重复、未知键一律拒绝；未指定时 continue/refresh 继承基线范围。

profile 名称/代码核验使用现有缓存和 TTL；缺少或过期时返回 `RESEARCH_IDENTITY_REQUIRED`，让用户先调用画像工具确认，不在新接口内暗中猜选主体。图谱未启用不阻断公开研究，明确 `GRAPH_UNAVAILABLE`。

继续：继承版本证据与缺口，合并可选新问题，优先未解问题。更新：保留历史证据，优先重新检查招聘、项目和软件线索；网页同 URL 内容变化新增证据版本，找不到旧材料不解释为旧事实已失效。

接受 continue/refresh 时，在校验档案写入基线的同一短事务内，为本次每个目标产品选择截至接受时点、同模板且兼容的最新有效覆盖版本，保存 `request_json.product_base_versions`（产品→version_id或null），队列执行时不重选。产品未指定仍按接口规则继承写入基线的范围；显式产品可以不在该基线范围中。没有该产品历史版本时记录null并研究其新范围，不借用无关产品的机会结论。该映射仅服务端生成，客户端不能传入；新版本 evidence_base_version_ids 记录实际继承来源，parent_version_id 仍指档案写入基线。

initial为每个目标产品固定显式goal或模板默认目标。continue/refresh的各产品分别继承其固定版本的相关证据闭包、缺口与有效目标；显式 goal 覆盖本次所有目标产品，省略时保留各产品已有目标，无历史目标用模板默认目标，逐产品目标存为 request_json 与 snapshot_json 的 product_goals，键严格等于本次产品范围；envelope.effective_goal 仍为字符串，单产品取该目标，多产品按 ProductKey 固定顺序生成带产品名的目标说明，不用模型改写。未研究产品保持原 version_id/as_of，不混入本次覆盖或生成新的评级。幂等比较仍只用规范化客户端请求，回放已接受任务时不得重算产品来源和目标。例如V1只研究Creo、V2只研究CST，基于V2显式继续Creo时读取V1的Creo资料，生成V3且parent=V2，CST仍由V2覆盖。


## 5. 研究流水线与硬预算

### 5.1 首版默认值

以下为可执行的初始工程上限，不是实测耗时/SLA。上线前用样本校准，只能通过审阅后的配置变更调整。

- 新增 `COMPANY_RESEARCH_ENABLED=false`；`COMPANY_RESEARCH_TIMEOUT_MS=600000`（允许 60000–1800000）。
- 默认全服务研究并发 1、等待队列最多 20；最多每用户 queued/running 3 个。队满明确拒绝，不创建悬空任务。
- 每 run：QCC 4、网页搜索 16、模型 8、总计 28 次，包含失败和重试；新增对应 `COMPANY_RESEARCH_MAX_*` 配置，均为正整数，总计不能超过三类预算之和；模型上限至少2次、总上限至少3次，不满足时配置校验失败，不能创建研究任务。所有统计为上游业务调用，SDK 握手/刷新另行记录，不假称零成本。
- 最多 3 轮：首次搜索至多 8 条，后两轮各至多 4 条；未使用额度可留给重试，但不能突破任一硬预算。上游并发最多 2。
- 以 run 转为 running 时的单调时钟计时，总时长 T 为 `COMPANY_RESEARCH_TIMEOUT_MS`；最终整合预留时间 R = min(60000, floor(T / 5)) 毫秒，采集截止点为开始后 T−R，上游总截止点为开始后 T，T限制来源/图谱读取和模型处理窗口，不包括下述必要的本地收尾时间。默认 T=600000 时 R=60000；最小合法 T=60000 时 R=12000，保留 48000 毫秒采集窗口。采集阶段的来源请求及重试、轮间模型分析均不得超过采集截止点；到点停止启动新采集或重试，取消未完成的采集阶段请求并进入最终整合，不将阶段截止误记为整个 run 被用户取消。预留 2 次模型调用用于最终整合（包含一次失败重试）；最终调用仍受剩余时间和调用硬预算限制，不保证一定能执行两次。不足时用已验证事实确定性渲染，不再无限重试；技术缺口按 partial/failed 规则处理。
- 到达上游总截止点后，停止发起来源、图谱、模型请求与重试，取消未完成的可取消请求，不再接纳迟到响应；冻结截止前已经校验完成的证据、claims与实际预算，进入本地收尾。仅响应字节已到但尚未完成校验的材料不算已验证成果。截止信号与用户取消/关闭信号区分处理，不能因上游超时而把任务误标cancelled，也不能让已中止的上游signal阻止本地状态落库。
- 本地收尾允许在T之后执行，但仅做有上限材料的引用闭包检查、确定性评级/渲染及一次正常的短事务提交，不追加网络/图谱/模型调用、不重开研究、不无限重试。截止前有有效可提交成果（含本次固定继承的有效成果）则发布partial，记录TIME_BUDGET_EXHAUSTED和未完成范围；没有则落库failed且不发版本。持久化失败沿用失败诊断/启动恢复规则，不假称结果已保存。T不是包含本地收尾的端到端SLA，验收分别记录上游耗时与本地收尾耗时，不再笼统禁止超时后写入。
- 本地提交仍在同一短事务检查run处于running、写入基线未变化：若用户取消先落库，则不发布版本；若收尾提交先完成，后到取消只返回终态。服务关闭仍遵循Task 5等待窗口，强制关闭或已失败任务不能被收尾/迟到响应复活。网络取消、连接释放完成后才释放活动跟踪并关闭DB。
- 最终整合的2次调用额度由新研究 policy.ts 在 CallBudget 之外按阶段保护，不修改旧评估的 CallBudget 语义。采集/轮间分析的每次真实尝试（含重试）在扣预算前同步检查：扣后 total 剩余至少2次；若为模型分析，ark 剩余也至少2次。所有请求共用同一预算，无 await 跨检查与扣数；现有 reserveArkCalls 不足以替代此检查，因为它不区分中间与最终模型调用。进入最终整合后才允许消费这2次额度，首次成功不再调用，失败至多重试一次；剩余时间不足则沿用确定性降级，不借用其它来源未用额度突破模型上限。
- 单个模型请求沿用实际序列化 body 字节检查及现有 `ARK_REQUEST_MAX_BYTES`；证据按依赖组装包，最多 80 条证据、60 条结论，每条摘录最多 2000 字符，每个 run 最多接纳 1 MiB 来源摘录；超量报告省略。
- 图谱最多 40 次实际 IPC 读请求、最多 20 个 Person 与 10 个 Project，包含组织解析/分页/失败；每页 50，帧不超过现有 256 KiB。读取某实体中途版本变化或分页不推进时丢弃该实体材料并警告。

### 5.2 执行算法

1. queued 原子转 running，创建 run 独立 AbortController 与上游客户端，固定开始时 now 和预算。
2. 按已固定 product_base_versions 加载逐产品历史快照、目标与缺口，再读取已确认画像和最近一个同主体完成评估的精简证据；不把档案写入基线当作唯一资料来源，旧报告正文不反向生成证据；按第5.2.1节先生成本次待查项，空集合直接转本地结果生成。
3. 仅为待查项中需要图谱补证或复查的部分读取正式组织关联；没有相关待查项则复用已存证据，不重复遍历。通过分页关系发现相关任职人员和客户项目，再读取人物/项目证据和必要关系。只作为线索使用的技能仍保留完整任职归属链；不遍历家庭关系。
4. 按第5.2.1节选择本轮待查项，不统一重跑初始搜索骨架。只对实际待查项调用QCC/搜索；招聘相关待查项优先QCC招聘，余量按本次缺口选择专利、资质或招投标，复用既有mapper和工具参数形状，不请求个人联系方式。
5. 有待查项且确需分析/规划时才请求模型；模型输出严格结构：有引用结论、缺口、建议后续 query（每条必须引用 gap_id，附目的和目标产品）。模型不执行网络、不选择任意 MCP 工具；Node 校验范围、长度、去重及预算后调用既有搜索端点。 所有网页、招聘、QCC与图谱摘录均为不可信数据：固定系统提示声明其不是执行指令，来源内容只放在序列化材料字段，不拼接进系统提示或工具定义。模型不能提供 actor、工具权限、来源定位或预算；结构输出和建议 query 仍由服务端按已固定企业/产品、可见证据ID及依赖闭包校验。材料中的指令不改变研究范围、事实类型或校验规则。
6. 后续最多两轮聚焦缺口。每轮更新验证后的材料集合；若一整轮无新的可验证证据则停止。模型声称“发现新信息”但内容去重后相同不算进展。
7. 整理证据/结论、变化与产品机会，校验引用闭包和来源，不把关联技能或供应商项目转换成目标企业确定使用的事实。
8. 在一个事务内写不可变版本、更新 run 终态；先检查 run 仍 running 且基线未变化，取消/关闭后的迟到结果不能提交。
9. finally 中停止计时、关闭该 run 上游连接、释放队列容量。

`completed`：范围内计划已执行且没有技术处理缺口；可以仍有公开信息无法回答的问题，不表示事实穷尽。`partial`：有有效结果，但预算、来源失败、分页截断或材料省略造成技术缺口。`failed`：主体无效、持久化失败或无有效可提交材料；不写正式版本。`cancelled`：不发布新版本，保留运行诊断。完成无新增资料仍可写版本；无其他判断/目标/方法变化时changes为空，只在实际成功核查来源时更新对应证据last_checked_at，不用版本生成时间冒充核查时间，不刷新旧证据published_at/collected_at。上游超时后的partial/failed与提交权限按第5.1节本地收尾规则处理。

### 5.2.1 按模式生成待查项

同一个planner按mode分支，不新增调度服务、队列或表；三种模式共用原有最多3轮、每轮8/4/4条搜索上限及全部硬预算，上限不是必用配额。每个待查项保留目的、目标产品及所依据的gap/evidence ID（或首次/新范围缺背景的理由），方便验证是否存在无理由重复采集；这也是QCC和图谱读取的选择依据，不只约束网页搜索。

| 模式 | 首轮待查项 | 后续轮次与跳过条件 |
| --- | --- | --- |
| initial | 在选定产品范围内构建业务/工程/招聘/软件生态骨架；先读取已有可靠资料，已覆盖的项直接复用，只查询缺失部分。默认七产品扫描不平均分配次数 | 基于验证后的缺口定向补查，不重跑完整骨架；一轮无新增有效证据则停止 |
| continue | 从固定逐产品版本继承的未解问题、技术缺口、冲突及显式新目标产生定向待查项。已覆盖且未出现新问题的主题不查询，不因启动新run重新检查全部来源 | 新证据产生的新缺口可以补查；同一已成功处理的待查项不重复请求。此前失败的技术缺口可在新run再尝试，重试仍计预算 |
| refresh | 先选择本次产品范围内到期、日期未知、有冲突的证据，及与用户更新目标有关的变化检查。明确要求更新本身允许针对相关主题检查新资料，即使旧证据未到复查期；记录理由，不能扩大成全部主题重扫 | 按变化与未完成复查定向补查，不重跑无关背景；同URL内容未变仅记录真实检查，内容变更才生成新内容证据，访问失败只记缺口 |

continue/refresh仅在新增产品从未研究，或继承材料不足以理解当前问题的背景时，补该产品相关的最小骨架；记录对应产品与缺口，不因此扫描其他已覆盖产品。去重按规范化查询与待查目的、来源记录处理：同一run不重复成功请求，允许的失败重试除外；跨run可因未解技术缺口、到期复查或明确更新要求重查，不能仅靠文本相同就禁止合理复查。

没有待查项时直接复用已验证材料进入本地结果生成，stop_reason=NO_PENDING_WORK，不为凑轮次调用来源或模型。仍按现有版本与差异规则处理，只有真实业务/目标/方法变化才记录对应changes；没有实际来源核查不得更新证据last_checked_at。若确无有效材料可提交，按failed处理，不能凭空生成完整研究结论。

### 5.3 时间、评级与变化

保留 published_at/collected_at/valid_from/valid_to；未知日期不填当前日期。招聘/项目线索超过 30 天未复查或发布时间未知，在 refresh 时优先检查；365 天招聘时机界限沿用原评级规则，两者不可混淆。基础业务材料超过 180 天未核查或出现冲突时优先刷新；这是补查优先级，不是事实到期删除规则。

`opportunity-adapter.ts` 将通过核验且可归属于目标企业的证据映射为 `EvidenceBundle`，调用 `evaluateOpportunities`。graph 保持内部定位、url=null；不是 `ResearchItem`。associated_skill/supplier_project/冲突和未知归属仅进入线索及缺口，不形成确定的目标企业软件部署事实。招聘保留 recruitment 类型及原限定语。单产品研究只公布所选产品结果，不展示未研究产品的低分。新别名只帮助检索，不改变原评分支持范围。

changes 由稳定证据键、结论语义键（企业/产品/谓词/对象）及规则评级差异生成：新增证据、原文变化、冲突、结论变化、评级变化。模型仅可为已计算出的差异写说明，不凭措辞变化创造业务变化。

## 6. 任务拆解（逐项先红后绿）

每项均先添加针对失败行为的测试，运行定向测试确认失败，再实现，运行相同测试及 noEmit。完成一项留下可审查 diff；用户要求提交时才按任务提交，不包含本地 PRD 删除/忽略变更。

### Task 1：契约、数据库与幂等服务

**新增：** `src/research/contracts.ts`、`repository.ts`、`service.ts`；**修改：** `src/db/schema.ts`；**测试：** `tests/company-research-repository.test.ts`、`company-research-contracts.test.ts`。

- [ ] 同步实现第 3.3 节的严格 envelope、模板固定、未知版本拒绝及跨模板升级的幂等回放测试；第一阶段专题请求不得生成任务。

**接口：** service.start(input, actor) 返回 run 元数据；repository.begin/claim/finish/cancel/recover 使用 SQLite 短事务，禁止 await 跨事务。service.read(version) 返回验证后的不可变 snapshot。

- [ ] 建立真实临时 SQLite fixture；加入同一操作复放、参数冲突、同企业并发、单产品版本不更新其他产品的失败测试。
- [ ] 分别构造首次 failed、cancelled、重启恢复为 failed/PROCESS_RESTARTED 的无版本档案：确认原操作同请求回放且无新增调用，不同请求仍冲突；新 operation_id 可创建同 dossier_id 的新 initial，成功后仅新增一个有效版本，原终态与诊断保留。再验证已有 completed/partial 版本时 initial 仍被拒绝，无基线 continue/refresh 仍被拒绝。
- [ ] 验证无版本档案的两个新 initial 竞争时至多创建一个活跃 run，另一操作返回 RESEARCH_ALREADY_RUNNING；队满或用户额度不足时不创建新 run，也不改变原失败/取消任务。
- [ ] 验证接受任务时逐产品固定 product_base_versions 和有效目标；V1=Creo、V2=CST、基于V2继续Creo时引用V1且parent=V2，CST版本/日期不变。覆盖同时选择两个产品、从未覆盖的产品、显式goal覆盖及省略goal分别继承；伪造内部映射拒绝，原请求回放不能重算映射或目标。
- [ ] 实现三张表、规范化请求 hash、索引和原子状态更新；SQLite 外键按现有连接设置处理，不依赖默认外键开启，事务内校验 dossier/base/version 归属。
- [ ] finish 同事务先查 status=running，再插入版本和更新终态；所有读写都用 Zod 校验存储 JSON。
- [ ] 验证初次建库与旧库升级均不改旧表记录；终态不可被迟到结果覆盖。

```ts
expect(service.start(input, 'u1').run_id).toBe(service.start(input, 'u1').run_id);
expect(() => service.start({...input, goal:'different'}, 'u1')).toThrow('RESEARCH_OPERATION_CONFLICT');
repo.cancel(runId, 'u2');
expect(() => repo.finish(runId, snapshot)).toThrow('RESEARCH_RUN_NOT_ACTIVE');
expect(repo.versions(dossierId)).toHaveLength(0);
```

### Task 2：证据摄取与图谱归属

**新增：** `src/research/evidence.ts`、`graph-evidence.ts`、`software-aliases.ts`；**修改：** `src/companies/company-context-service.ts` 公开受预算控制的 confirmedOrganizationIds(code, readContext) 只读入口；**测试：** `tests/company-research-evidence.test.ts`、`company-research-graph.test.ts`。

**接口：** collector.collect(identity, scope, readContext) 返回 evidence/coverage/warnings；readContext 提供 request(op,payload) 并统一扣 IPC 预算。新公开入口使用它计数，旧调用保持原默认行为。

- [ ] 先写四组场景：个人技能＋历史任职、明确任职软件使用、所属项目使用、供应商客户项目。加姓名相同但 ID 不同和时间重叠不能归属的反例。
- [ ] 实现源定位、引文子串验证、同源去重、隐私字段白名单及依赖组；带冲突证据不能成为确定使用结论。
- [ ] 不扩展 Rust 协议；逐页 `company_organizations/company_relations/get_contact`，人物项目从人物关系页继续读取。若图谱仅有技能但缺任职证据，记覆盖缺口，不补造关系。
- [ ] 验证分页版本变化、图谱关闭、IPC 超限、真实帧容量；从截断材料中不能保留依赖缺失的结论。

```ts
expect(classify(skillAndEmployment)).toBe('associated_skill');
expect(classify(explicitEmployerProjectUse)).toBe('project_use');
expect(classify(supplierClientProject)).toBe('supplier_project');
expect(validateClaim(claim, evidenceWithoutEmploymentProof)).toBe(false);
```

### Task 3：上游适配、预算与多轮 Runner

**新增：** `src/research/policy.ts`、`sources.ts`、`planner.ts`、`model.ts`、`runner.ts`；**测试：** `tests/company-research-runner.test.ts`、`company-research-budget.test.ts`。复用既有 mapper、CallBudget 和 requestArkJsonContent，不将新契约传进旧 ArkEvidenceService。

- [ ] 把通用研究问题集合、结构输出和提示词放入 `src/research/templates/company-research.ts`，显式注册 company_research@1；不实现专题模板，不泛化执行器。

**接口：** runner.run(runId, serviceSignal)；sources 为 run 专属 collectQcc/search/close；model.analyze(materials,gaps,scope,signal) 返回严格结构的 claims/gaps/queries。测试用 stub 注入 source/model/clock，不调用真实上游。

- [ ] 先写预算包含失败/重试、模型保留额度、无进展停止、恶意 query 越界、非法引用和超大依赖组测试。
- [ ] 预算验证同时检查来源、模型、总额度：默认4/16/8/28及总额度缩小为24时，中间模型已调用2次后仍保护最后2次整合额度；非最终来源/模型及各自重试均不能越过保留线。覆盖模型2/总3的最小配置、模型1或总2配置拒绝、最终成功只调用一次、失败重试最多一次；均断言实际调用数等于扣数，旧CallBudget/旧评估回归不变。
- [ ] 使用可控单调时钟，覆盖 T=60000、300000、600000、1800000，分别断言 R=12000、60000、60000、60000 及采集窗口始终大于零；最小配置下立即完成的 stub 来源能在 48000 毫秒前被调用，不能启动即进入最终整合。配置边界外的 59999/1800001 毫秒必须拒绝。
- [ ] 在采集截止点前、恰好到点、到点后三个位置验证调度：到点后来源调用、重试和轮间分析计数不再增加，未完成的阶段请求收到取消信号，最终整合仍可使用上游剩余时间；最终尝试及重试均扣预算，到上游总截止点停止并拒绝迟到响应。测试推进假时钟，不真实等待超时。
- [ ] 构造“截止前已有已验证材料＋最终模型挂起到T”：T后零新增来源/图谱/模型调用，本地确定性收尾只提交一个partial版本并记录TIME_BUDGET_EXHAUSTED；无有效材料则failed且零版本。响应在T前到达但未完成校验、T后模型返回合法内容，均不得纳入冻结成果或触发二次写入；实际预算不因迟到回调改写。
- [ ] 验证收尾与取消竞争的两种事务先后顺序：先取消则零新版本，先提交则后到取消保持终态；服务关闭等待完成后才关DB，已强制关闭/失败任务不能发布。注入存储失败时不回报已保存、不无限重试；进程在收尾前中断仍按PROCESS_RESTARTED恢复。
- [ ] 按第5.2.1节验证三模式：initial七产品与指定产品骨架及已有背景复用；continue仅剩一个Creo问题时不重查无关业务/招聘/CST主题；refresh仅复查到期/未知/冲突材料与显式更新相关主题，保留未变、变化、不可访问三种结果。断言实际QCC/搜索/图谱请求及其待查理由，不仅检查模型建议。
- [ ] 验证新增未覆盖产品或问题缺背景时只补对应最小骨架；一轮无进展停止、单run去重不吞掉合法失败重试、跨run到期/显式更新不被去重误拦。没有待查项时来源/图谱/模型新增调用均为0，NO_PENDING_WORK且不刷新证据复查时间。
- [ ] 实现三轮流程、query 去重、材料装包、schema 校验及超时取消；搜索请求使用原 SearchQuerySchema 和产品范围。
- [ ] 对 source 中每次业务请求先 tryConsume，再执行；可重试错误最多一次，重试也扣预算；不支持忽略取消的 Promise.race 假超时。
- [ ] 加入网页、招聘原文及图谱摘录的指令注入样本（伪装系统消息、要求换企业/产品、跳过引用或编造来源）。检查最终序列化messages中的系统提示不含这些原文，原文只作为材料字段；用受控模型输出验证越界query、伪造证据ID/归属及额外工具/actor字段被拒绝、不触发额外来源或MCP调用。再用合法引用输出验证正常材料仍可处理；这证明服务端边界，不宣称模型语义判断绝对无误。
- [ ] 建立 run 级独立 gateway/search/model 客户端；测试取消一项不影响旧评估或其他客户端，finally 关闭其连接。
- [ ] 最终模型失败时确定性渲染已验证成果并标 partial；没有有效成果则 failed。

```ts
await runner.run(runId, signal);
expect(searchCalls).toBeLessThanOrEqual(16);
expect(modelCalls).toBeLessThanOrEqual(8);
expect(status.budget.total).toBe(qccCalls + searchCalls + modelCalls);
expect(noProgress.status.stop_reason).toBe('NO_NEW_EVIDENCE');
expect(cancelled.finishedVersion).toBeNull();
```

### Task 4：评级、版本差异与结果读取

**新增：** `src/research/opportunity-adapter.ts`、`diff.ts`、`render.ts`；**测试：** `tests/company-research-results.test.ts`。

- [ ] 增加跨版本证据闭包、结构化语义键及 method/analysis/business 差异测试；模板/目标变化不得冒充企业业务变化。

- [ ] 在现有repository/service读取逻辑中实现第3.4节最小单产品视图；测试按产品选版本、未覆盖返回unknown而非低等级、覆盖/知识/技术缺口区分、引用闭包、显式版本归属校验，以及last_checked_at不被读取/复制刷新。policy.ts只测试30/180天刷新优先级及未知日期，不新增product-context.ts/freshness.ts，不实现跨企业批量读取或timing_signals/known_blockers投影。

**接口：** buildResult(validatedEvidence, claims, scope, productBases, now) 返回 version snapshot；renderSummary(snapshot) 生成固定顺序简报；selectEvidence(snapshot, filter, page) 纯函数分页。

- [ ] 先验证招聘“任一种”不变成全部软件部署、历史日期不升级为当前、关联技能不形成确认部署事实、来源只有图谱时 URL 为空且可定位。
- [ ] 接入现有确定性评级，保留 source_key 同源权重；不改旧规则，为适配前后同一公开证据建立等价测试。
- [ ] 实现继续继承、刷新对照、单产品覆盖合并与不可变证据分页；分页范围固定 version_id。
- [ ] 验证仅措辞变化不构成业务差异、旧证据再读不更新时间、引用与依赖缺失拒绝、报告没有电话邮箱。

```ts
expect(compare(base, sameFactsReworded).business_changes).toEqual([]);
expect(selectEvidence(version, filter, page).items[0].collected_at).toBe(originalDate);
expect(assess(associatedSkillOnly).confirmed_software_use).toEqual([]);
```

### Task 5：MCP、队列、配置与生命周期

**新增：** `src/research/queue.ts`、`src/mcp/company-research-tools.ts`；**修改：** `src/config.ts`、`src/index.ts`、`src/mcp/tools.ts`、`.env.example`；**测试：** `tests/company-research-tools.test.ts`、`company-research-lifecycle.test.ts`。

- [ ] status/list/read 返回模板与 schema 元数据；测试未知已完成版本阻止新研究写入、旧功能仍可用，以及未知模板任务不被自动重跑。

**接口：** queue.start/enqueue/stopAccepting/cancel/waitForActive；全局并发1，DB是状态真相，内存只负责调度。队列复制现有 FIFO 行为所需最小逻辑为研究专用实现，不泛化/重构旧 AssessmentQueue。

- [ ] 先写未鉴权拒绝、开关关闭不注册、共享读取和其他用户取消留 actor、队满/用户额度、写操作幂等测试。
- [ ] 注册六个工具、实现严格 schema 与固定错误码；结果返回 structuredContent 和简要中文文本。
- [ ] 启动将遗留 queued/running 标记 failed/PROCESS_RESTARTED，不自动付费恢复；服务启动完成后启动队列。
- [ ] 关闭停止接收与启动新任务，标记尚未执行队列失败；运行任务遵循现有关闭等待窗口，超时 abort，等待状态落库/连接关闭后才关 DB。接入 activity tracker，避免数据库先关闭。
- [ ] 验证 list/read/evidence 路由 source 调用计数始终为0，继续/刷新共享权限及过期基线冲突。

```ts
await client.callTool({name:'get_company_research_evidence', arguments:{version_id: versionId}});
expect(upstreamCalls).toBe(0);
await app.close();
expect(events.indexOf('db.close')).toBeGreaterThan(events.indexOf('research.finished'));
```

### Task 6：贯通验收、部署说明与样本校准

**新增：** `tests/company-research-e2e.test.ts`、`tests/company-research-native.test.ts`、`tests/fixtures/company-research/`、`docs/validation/2026-10-17-continuous-company-research.md`（实施时记录）；**修改：** `.github/workflows/contact-upload-validation.yml`（仅必要的测试发现/开关）、README；本地 PRD 只更新实际完成状态。

- [ ] 合成 HTTP MCP + 真实 Node SQLite：初始研究→状态→摘要→证据→继续→刷新→共享读取→取消→重启；上游受控 stub，记录其边界。
- [ ] 增加 HTTP MCP 恢复验收：分别令首次任务失败、取消、重启失败，原 operation_id 回放不增加上游调用；新 operation_id 复用档案完成 initial，再验证后续必须使用 continue/refresh。用最小合法超时配置和可控时钟贯通采集、阶段截止、最终整合与总截止，确认没有零采集窗口；上游截止后拒绝迟到响应但允许本地partial/failed收尾，结果只提交一次。计时测试使用stub，分别记录上游与本地收尾边界，不作为真实耗时验收。
- [ ] 增加合成HTTP MCP验证：Creo→CST→Creo的版本/目标继承及固定证据回读；受控来源指令注入不能改变企业、产品、权限与引用；压缩总预算后仍可最终整合，source/model/status扣数一致。交付核对仅要求首期最小单产品视图、覆盖与复查元数据，后续批量读取及专用投影不作为首期通过条件，也不填空字段冒充已实现。
- [ ] 增加合成HTTP MCP超时/模式验收：已有有效材料且最终模型挂起时，截止后可读取唯一partial版本、停止原因与预算；无材料读到failed且无版本，取消竞争不发布迟到成果。分别运行initial→定向continue→范围内refresh，核对stub实际请求清单与理由，确认不重扫无关主题；无待查项零新增调用且证据日期不变。
- [ ] 远程原生图谱：真实 Rust Store 写入四类职业关系样本，再实际读取研究结果。若缺原生二进制必须失败，不能 skip/mock 后声称 native 通过。
- [ ] 远程运行既有完整只读 workflow，验证旧评估、问答、Token、CRM和联系人功能；构建仅远程，不部署不读生产密钥。
- [ ] 用专用授权环境选择制造设计、仿真、质量/流程三类企业，再加弱资料企业，记录每次耗时、调用数、未处理材料、引用准确率、错误归属、重复研究比例；验收要求无伪造引用、无已知错误归属、无静默截断。预算无须耗尽才能通过。
- [ ] 真实宿主单独记录环境版本、tested SHA、首次/继续/刷新及证据展开结果；没有环境时明确未执行，不替代为合成结果。
- [ ] 文档记录开关默认关闭、迁移备份、预算与结果状态。验收通过后才在授权环境开启；关闭开关停止新任务并按生命周期收尾，数据不删除。生产发布/部署另外执行，不在本计划自动发生。

## 7. 本地验证命令与实施交付物

本地每任务只执行其指定纯测试（不要运行 native/e2e 全套），排除其他 worktree：

```sh
node node_modules/vitest/vitest.mjs run tests/company-research-contracts.test.ts tests/company-research-repository.test.ts --exclude '.worktrees/**' --maxWorkers=1 --minWorkers=1
npm run typecheck
git diff --check
```

要求 node --version 为24或更高；当前默认 Node 如低于24，使用已有 Node24 runtime，不进行安装或构建以绕过限制。Task 2–5 依次替换为本任务列出的纯测试文件。任何会启动构建/native fixture 的测试移至远程工作流。

最终交付：六个 MCP 工具、共享可版本化档案、证据读取与归属约束、有预算的多轮研究、继续/刷新差异、生命周期和幂等防重复，以及代码提交级验证记录。首次生成研究成果不等于实际七产品采购机会成立。

## 8. 自审与剩余外部条件

本方案已覆盖 PRD 第一阶段的输入、归属、补查、范围、共享、版本、读取和失败边界；没有提前实现其余三阶段。默认数值为初始限制，需真实样本校准，不写成性能保证。真实上游额度与宿主环境是验收外部条件，不阻塞合成开发；未满足时只标开发验收，不宣称线上通过。
