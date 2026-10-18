# 产品销售场景专题实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 原制定阶段仅编写计划；现按用户明确指令执行。代码及受控验证已完成，未授权提交、推送或部署。

**Goal:** 在已实现的持续研究中开放 product_sales_scenario@1，按目标产品输出有证据的新购／替换／补充探索路径。

**Architecture:** 复用既有三张表、六个 MCP 工具、Runner、来源、队列、预算和评级；新增受控模板注册、专题结果分支与校验、问题模板、摘要/差异处理。不新建专题系统，不改变旧 company_research@1 结果。

**Tech Stack:** Node24、TypeScript、Zod、node:sqlite、现有模型 JSON transport、Vitest、现有远程只读 CI。

**Spec:** [专题功能设计](../specs/2026-10-17-product-sales-scenario-design.md)。

**Implementation baseline:** `858cca4 feat: add versioned continuous company research`。第一阶段开发已完成；仓库验收记录仍无远程完整 gate、真实上游或真实宿主通过证据。它们不能被本计划标为已完成；本阶段最终远程回归必须一并覆盖第一阶段。

## 1. 全局约束

- 七产品客户场景研究；不做产品能力/价格对比，不因竞品存在认定替换机会，不生成拜访简报或企业排序。
- 仍是共享成果，同企业单任务互斥，actor 来自认证；首次/继续/刷新、取消、重启、限额和幂等不变。
- 专题显式选择 products；同模板继续可继承范围，切换模板必须指定范围。模板版本由服务端固定，客户端不能指定。
- first-stage facts/claims/evidence 是判断依据，专题只引用保留到最终快照的 claim_id。个人技能、供应商项目、过期证据、否定语义和重复来源的既有约束必须保留。
- 不改变 `RESEARCH_EVALUATOR_VERSION=opportunity@1` 或评级规则；如果发现确需改变事实适配语义，另行评审版本影响，不夹带在专题工作中。
- 不增加模型/搜索预算；专题生成占现有 final 阶段额度，失败最多重试一次且不能突破已有 deadline。
- 不执行本地 build/dev/native/full-suite；远程 CI 使用当前 contact-upload-validation 工作流。PRD 本地忽略，既有 .gitignore/PRD 索引改动不纳入本功能提交。

## 2. 实际代码与原设计差异

| 位置 | 当前实现 | 本阶段动作 |
| --- | --- | --- |
| contracts.ts | 请求认识专题 ID，模板 schema、snapshot/result、parseResearchSnapshot 仅支持通用@1 | 增加严格 union 与 envelope/result 一致性校验，旧分支保留 |
| repository.ts begin | 显式拒绝专题；模板取 options.template；目标按逐产品历史版本继承 | 解析模板与产品目标、保持 replay 优先，按实际 product_base_versions 复用证据 |
| templates/company-research.ts | 定义受控 topic、提示词和分析 schema | 抽取仅必要的公共分析契约；增加专题模板与显式注册，非插件平台 |
| planner/model/runner | planner 主题与模型 system prompt 固定；Runner 再次调用 parseAnalysis；pending=0 跳过 final | 模板贯穿真实装配和双重校验；区分需补查与需生成专题，不靠虚构缺口强制搜索 |
| opportunity-adapter.ts | buildResult 固定 company_research，压缩时可能删除 claims | 在最终裁剪后校验/降级专题引用，不允许悬空 claim_id |
| render/diff/MCP | 通用摘要；模板差异已有处理；MCP 多处依赖 schema.shape | 保留 Zod object 外层以兼容 .shape，扩展结果联合与专题摘要/路径差异 |
| service.ts | readProductContext 已实现，返回 facts/claims/gaps/evidence_checks；未单独存在 product-context.ts/freshness.ts | 就地保证专题兼容，不按旧方案文件名重复创建服务，不顺带实现拜访/排序专用读模型 |

当前 ID schema 为非空有界字符串，不是普遍 UUID 校验；遵循实际第一阶段接口，不在此阶段额外收紧。schema_version 保持1，通过 template id/version 和严格结果分支识别新增类型；旧程序遇到专题应明确拒绝，不当作通用解码。通用 method_version 保留 research@1；专题采用 research-sales-scenario@1，评级版本不变。

## 3. 最小契约与运行语义

### 3.1 模板与结果

保留 RESEARCH_TEMPLATE 常量作为通用默认，新增 PRODUCT_SALES_SCENARIO_TEMPLATE_REF。ResearchTemplateSchema 使用两个 id/version object union。ResearchSnapshotSchema 保持外层 z.object，template_result 为 discriminated union；superRefine 检查两者 id 一致及 products 集合与 product_keys 一致。

每产品结果遵循功能设计的 ProductScenario。三条路径 new_purchase/replacement/complement 唯一且齐全，state 为 worth_exploring/insufficient/contradicted。文本长度限制：rationale 1000、单个 prerequisite/question/unknown 300，每路径前提与问题各最多5，unknown最多10，claim引用每数组最多20。摘要有界，完整字段保留结构化结果。

专题接纳前复用现有 `containsPrivateContact` 检查全部新增自由文本，包括 rationale、prerequisites、questions、unknowns；未来新增文本字段也必须经过同一遍历校验。命中时拒绝本次专题结果并返回固定 TEMPLATE_OUTPUT_INVALID，不把原文写入快照、诊断或日志；不只依赖 renderSummary 遮盖。可在同一个 final 调用额度内重试，否则采用第3.4节无敏感内容的确定性 partial 回退。最终存储边界再次执行此检查，覆盖继承/复用专题路径；MCP 的完整 structuredContent 和文本响应都必须不包含命中内容。检测能力以现有 helper 为界，不宣称能识别所有形式的个人信息。


worth_exploring 必须有可支持客户场景及该路径前提的合法 claims；contradicted 必须有反证 claims。引用须归属当前企业、对应产品，非仅由关联个人技能或供应商使用推出的企业事实，且 evidence 闭包在快照内。只有软件使用/招聘要求、没有变化/不足证据时 replacement 不得为 worth_exploring。缺少证据则降为 insufficient 并列缺口；不能因为引用格式正确就宣称语义验证成功。

结构、范围、引用和必要证据类别由代码检查；路径理由语义由受控提示词+具备正反例的测试验证。无法证明语义合格时保守降级，不声称自由文本已经被完全形式化验证。不得根据单个“痛点”关键词提升状态。

### 3.2 模板选择与幂等

initial：template_id 缺省为 company_research；专题要求 products。continue/refresh：缺省继承 latest 基线模板，显式切换要求 products。产品目标必须逐产品解析，不能只比较档案最新版本模板：显式 goal 优先；否则仅当该产品 product_base_versions 指向的版本模板 id/version 与本次固定模板完全一致时，继承其 product_goals；不匹配、缺少基线或目标时使用本次模板该产品默认目标。证据仍按该产品真实基线复用，不因目标重置丢弃。显式切换模板时仍须指定 products。

回归场景固定为：Creo通用研究 → CST专题 → 省略template_id并指定Creo。第三次选择最新档案的专题模板，但Creo目标须采用专题默认目标，不能继承Creo通用研究目标；Creo既有证据仍复用。另测同模板同产品目标保留、显式goal覆盖和反向切换。

先按现有 normalizeResearchRequest/researchRequestHash 查询幂等回放，再解析服务器当前模板，不修改旧 hash 算法。旧请求省略字段保持缺省，不在 hash 前注入新默认值。有效 run 的 request.template 与 product_goals 固定后，Runner 不再从当前默认配置重选。

模板不可用在写 run 前报 RESEARCH_TEMPLATE_UNAVAILABLE。已有 failed/cancelled initial 无有效版本时可按实际第一阶段逻辑重发新操作，不恢复成原计划中“一有档案就拒绝”的旧假设。

### 3.3 收集与最终分析

模板注册仅导出 ref、defaultGoals、受控问题集合、systemPrompt(stage) 与结果校验入口。不能提供任意网络执行回调；source 与 policy 仍归 Runner 控制。

collect 阶段沿用 claims/gaps/queries 严格结构；topic 仍用现有枚举，由服务器按产品模板映射允许的 terms/focus，模型不能自定 URL、公司或工具名。专题关注 Windchill 的BOM/变更/协作，QMS的质量流程/追溯，Creo/CATIA/SolidWorks的实际设计活动，Abaqus/CST的相应仿真任务，详见功能设计；这些是调查问题，不是产品优势宣称。

final 阶段专题输出 claims/gaps/queries（queries须为空）及 template_result。模型上下文包含经过验证的可引用历史 claims 以及当前材料；packModelRequest 必须对这部分和新增提示词一起按真实 body 字节计数，只有依赖组完整可见的 claims 才能引用。Runner 的第二次解析也必须按固定模板/stage 校验，不能出现 model 接受但 Runner 拒绝的分叉。

模板切换或明确新目标：即使 pending=0，也允许仅 final 模型生成专题，不创建 source 对象，不为“触发模型”虚构查询。相同专题/目标/范围且无变化、无缺口的 continue 可复用经产品裁剪后仍完整的专题，保持零模型调用；裁剪后不完整则需要 final。模型调用与重试仍计入既有 ark/total 预算。

任一 collect/final 失败不得丢弃已经验证的 facts/claims。专题 final 阶段整个 run 合计最多 **2 次实际 Ark dispatch**，传输自动重试、结构错误后的重试、隐私校验失败后的重试共同消耗这2次，不能分别获得2次额度。即使全局 ark/total 尚有余额也不得发起第3次；剩余额度不足、取消或deadline到达时不重试。对已经提交给模型的 claims 保留稳定 ID，最终未保留的引用会在 buildResult 阶段再次检查。

最小实现放在现有 `ResearchPolicy` 的实际dispatch计数边界：为专题run启用final Ark上限2，在canStart及每次businessDispatch前检查，并与原ark/total扣费同时增加run级计数。外层模型解析失败重试不重置计数，内层policy.call传输重试也经过同一检查。沿用现有预算和deadline实现，不新建重试包装器或额外预算池；旧通用研究保持现有行为。未发送的参数/装包失败不算dispatch，但无新输入的确定性装包失败不重试。

混合失败回归必须包括：网络失败→非法结构后停止（2次）；非法结构→网络失败后停止（2次，内层不得再重试）；非法结构→成功（2次）；首轮成功（1次）；只剩1次全局额度或期限到达时不得补发。失败均保留可用事实并按第3.4节降级。


### 3.4 最终裁剪与降级

buildResult 先沿现有逻辑完成事实、证据、claims、评级与容量裁剪，再装配专题结果并验证引用；最终2MiB循环每次删除证据组后都必须重新验证专题依赖。

专题失败且有有效事实时输出所有产品/三路径均 insufficient 的确定性 template_result，缺口记录 TEMPLATE_OUTPUT_INVALID/TEMPLATE_BUDGET_EXHAUSTED 或既有超时原因，run 为 partial。不能沿用过时路径当作本轮已完成分析。完全无有效研究成果仍 failed 无版本。

方法/模板变化进 method_changes；路径状态、理由或问题变化进 analysis_changes。仅事实来源变化才能进入既有 business_changes，不因生成新替换假设而写“客户开始替换”。纯模板变化同一已校验事实输入的 product_assessments 必须完全相同。

## 4. 实施任务（每项独立先红后绿）

### Task 1：模板契约与仓库接纳

**修改：** src/research/contracts.ts、repository.ts。**新增：** src/research/templates/registry.ts、product-sales-scenario.ts（本任务先定义ref/schema/defaultGoals）。**测试：** tests/company-sales-scenario-contracts.test.ts、company-sales-scenario-repository.test.ts；补原 repository/contracts 测试。

- [x] 用真实 SQLite 写失败测试：专题initial必须有产品；通用→专题与反向切换；专题省略模板继续继承；无有效版本的initial恢复；旧通用快照兼容；模板/result不匹配拒绝。
- [x] 实现模板union、严格结果schema与begin解析。options.template测试覆盖保持或改为显式受限resolver，不允许绕过注册表。
- [x] 真实SQLite补充Creo通用→CST专题→省略模板指定Creo回归：模板继承档案最新选择，目标按产品基线模板匹配，证据保留；同模板目标继承及显式goal覆盖同时通过。
- [x] 同一操作跨默认模板版本变化仍回放；未知版本、不同actor、参数冲突及并发限制保持。
- [x] noEmit 与本任务测试通过后审查diff，暂不提交除非用户要求。

```ts
expect(() => service.start(topicWithoutProducts, 'u1')).toThrow();
const first = service.start(topic, 'u1');
expect(service.start(topic, 'u1').run_id).toBe(first.run_id);
expect(parseResearchSnapshot(legacyCompanySnapshot).template.id).toBe('company_research');
expect(() => parseResearchSnapshot(mismatchedTemplateResult)).toThrow();
```

### Task 2：受控产品问题与模型双层校验

**修改：** templates/company-research.ts、templates/product-sales-scenario.ts、planner.ts、model.ts；必要新增 templates/analysis-contracts.ts 提取共享topic/analysis类型，避免循环依赖。**测试：** tests/company-sales-scenario-model.test.ts、company-sales-scenario-planner.test.ts。

- [x] 写七产品场景映射与严格范围测试；模型自定公司、URL、actor或越界产品失败。
- [x] packModelRequest 接收固定模板和stage，通用默认保持原字节/语义；专题final加入可引用claims及严格结果，collect不生成销售路径。
- [x] parseAnalysis 按模板/stage派发，模型和Runner统一使用；先做scope/引用闭包检查，再返回标准claims与可选专题结果。
- [x] 对rationale/prerequisites/questions/unknowns逐字段加入电话/邮箱反例，接纳校验拒绝且不记录原文；正常文本通过，固定回退文本不泄露输入。
- [x] 超字节预算不能丢失依赖引用；不可见claim/跨企业claim/个人技能误推企业事实/纯招聘误推替换均有反例。

```ts
expect(() => parseScenarioFinal(crossCompany, visibleClaims, evidence, ['creo'])).toThrow();
expect(validateScenarioPaths(recruitmentOnlyReplacement, context).products[0].paths
  .find(p => p.kind === 'replacement')!.state).toBe('insufficient');
expect(Buffer.byteLength(packed.body)).toBeLessThanOrEqual(maxBytes);
```

Task2 定义内部 parseScenarioFinal(raw, visibleClaims, evidence, scope) 与 validateScenarioPaths(result, context)，后者返回经校验/保守降级结果及warnings；不导出新MCP工具。

### Task 3：Runner、实际装配与最终快照

**修改：** runner.ts、policy.ts、opportunity-adapter.ts、src/index.ts；扩展 ResearchRunContext/ResearchResultInput 带固定template和可选专题结果。**测试：** tests/company-sales-scenario-runner.test.ts、company-sales-scenario-results.test.ts。

- [x] 失败测试覆盖pending=0模板切换仍生成专题但source调用为0；同模板无变化复用时model为0；缺口调查仍沿三轮与原预算。
- [x] 实际 ArkResearchModel 装配传入 run.request.template，不只让测试stub支持专题。分析结果跨Runner与resultBuilder传递，原company分支保持不变。
- [x] 在最终保留claims后装配专题。容量删引用、final失败、无剩余额度均按3.4节降级；已验证事实不能因专题失败被清空。
- [x] 使用实际ResearchPolicy＋ArkResearchModel统计fetch dispatch，覆盖第3.3节五类混合失败，断言专题final总计≤2且budget_usage按真实调用累计；不能只测model.analyze调用次数。
- [x] 取消、deadline、重启、无有效证据失败沿原语义；非合作transport迟到结果不写版本。模型重试全计数。
- [x] 纯模板变化不改评级、evidence时间、已确认主体、其他产品覆盖。

```ts
expect(templateSwitch.sourcesCreated).toBe(0);
expect(templateSwitch.modelCalls).toBeGreaterThan(0);
expect(sameTemplateNoWork.modelCalls).toBe(0);
expect(failedScenario.status).toBe('partial');
expect(result.product_assessments).toEqual(companyResultOnSameFacts.product_assessments);
```

### Task 4：摘要、差异与六工具兼容

**修改：** render.ts、diff.ts、service.ts（仅必要类型适配）、src/mcp/company-research-tools.ts。**测试：** tests/company-sales-scenario-tools.test.ts、company-sales-scenario-results.test.ts。

- [x] renderSummary 根据template_result显示场景、三路径状态与关键问题；保持首屏4000字符和隐私过滤，不能只返回通用“产品机会”而丢专题结论。
- [x] HTTP MCP回归逐字段注入电话/邮箱，核对落库快照、完整structuredContent、文本响应和捕获日志均无敏感原文；不得仅断言4000字摘要。
- [x] 完整结构通过get_company_research返回；现有get_company_research_evidence继续以claim_id/product查证据，专题路径列出可用claim_id，用户无需新接口。
- [x] status/list保留模板元数据；MCP .shape/.pick 以及outputSchema覆盖新分支，旧返回契约不丢字段。
- [x] diff为路径增加稳定key=product/path kind，与原事实差异隔离；方法变化和hypothesis变化不得污染business_changes。
- [x] readProductContext仍只返回共同事实/评级，不把销售路径假设填进采购信号；零网络读取测试。

```ts
expect(compare(companyBase, scenarioOnSameFacts).business_changes).toEqual([]);
expect(renderSummary(topicSnapshot).length).toBeLessThanOrEqual(4000);
await readEvidenceViaMcp(topicVersionId, supportedClaimId);
expect(upstreamCalls).toBe(0);
```

### Task 5：真实装配贯通与交付记录

**新增：** tests/company-sales-scenario-e2e.test.ts、docs/validation/2026-10-17-product-sales-scenario.md（实现时创建实际记录）。**修改：** 既有研究native测试补专题场景、README、第一阶段/专题设计状态。

- [x] 真实认证HTTP MCP＋临时文件SQLite＋生产Runner/模型解析，只有上游为受控fixture：通用→专题→读取/证据→继续→刷新→反向切换，核验共享、冲突、取消、幂等。
- [x] 模板切换时按产品取旧证据，覆盖Creo→CST→Creo和目标不串用；输入足够不重复搜索；多产品输出完全匹配范围。
- [ ] 远程native使用真实图谱技能/任职/项目/供应商fixture进入实际专题模型校验和结果链；无binary失败，不能mock/skip冒充。
- [ ] 远程完整旧研究/评估/问答/CRM/Token/图谱及生产容器gate；第一阶段未完成的gate不能省略。本机不运行native/full/build。
- [ ] 授权真实上游和宿主环境后，用七产品中至少CAD、CAE、流程管理三类客户样本核对引用、路径前提和耗时；未执行明确记录，不当成发布通过。
- [x] 文档示例用同一start工具模板切换；说明仍默认受COMPANY_RESEARCH_ENABLED控制、存储schema1新增模板的回退限制，不新增专题开关。未获发布授权不部署。

## 5. 本地允许检查与验收门槛

每任务执行其对应新增纯测试，以及实际被修改的既有研究测试；不盲目重复完整套件。示例：

```sh
node node_modules/vitest/vitest.mjs run tests/company-sales-scenario-contracts.test.ts tests/company-sales-scenario-repository.test.ts tests/company-research-contracts.test.ts tests/company-research-repository.test.ts --exclude '.worktrees/**' --maxWorkers=1 --minWorkers=1
node node_modules/typescript/bin/tsc --noEmit --pretty false
git diff --check
```

必须使用已安装Node24。贯通文件仅在确认无native/build hooks时本地运行；native/完整/容器由远程workflow承担。计划不把未来测试命令标作已执行。

交付必须满足：旧通用行为兼容、同一事实评级不漂移、销售路径有依据或明确不足、完整引用闭包、零重复系统/预算池、版本和幂等稳定，以及真实装配而非只测模板函数。没有真实环境时只报告开发验证完成。

## 6. 自审与执行顺序

顺序 Task1→Task2→Task3→Task4→Task5，依赖串行；无需并行改同一contracts/model/runner文件。实施前已重新核对源码基线和隔离工作区，保留主目录既有.gitignore和PRD索引变更。串行执行与实际验证记录见验证文档，未运行的远程项仍保持未勾选。

已覆盖产品范围、目标继承、三路径、共享、证据归属、模板切换、无补查生成、预算失败回退、结果裁剪、版本差异、旧读模型、实际装配与验收。未纳入拜访准备、企业排序或第1阶段无关重构。


## 7. Ponytail 审查修订（2026-10-17）

- 全部专题自由文本在接纳与持久化边界复用隐私检查，并验证完整MCP输出和日志。
- 产品目标按各自基线模板id/version判断继承，修复多产品交错研究的目标串用。
- 专题final实际dispatch统一上限2，传输/结构/隐私重试共用计数，沿用现有Policy与deadline。

仅补必要规则和回归，不增加新系统、依赖或独立重试层。上述修订已在本轮代码与纯测试中实现；远程和真实环境验收尚未完成。

## 8. 本轮执行结果

分支codex/product-sales-scenario，复用隔离工作树，按executing-plans由同一执行者串行完成，无子代理。最终20个相关纯测试文件279项、Node24 noEmit、diff检查通过；原生测试仅扩展与类型检查。详见[专题验证记录](../../validation/2026-10-17-product-sales-scenario.md)。本轮未提交、推送、合并、构建或部署。Task5的远程与真实验收项待执行，不将开发完成当作生产验收通过。
