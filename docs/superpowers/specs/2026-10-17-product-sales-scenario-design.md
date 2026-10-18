# 产品销售场景专题：功能设计与接口衔接

日期：2026-10-17。状态：专题代码已实施并完成受控开发验证，尚未提交或完成远程／真实环境验收。实施顺序为持续企业研究 → 本专题 → 首次拜访准备 → 单产品企业比较。

第一阶段实施基线见[持续企业研究方案](../plans/2026-10-17-continuous-company-research.md)。本文件确定专题功能、输出与接入契约。第一阶段已本地提交 `858cca4`，本阶段已补充[任务级实施计划](../plans/2026-10-17-product-sales-scenario-implementation.md)，按实际逐产品基线、模型和快照实现衔接；专题实现记录见[验证文档](../../validation/2026-10-17-product-sales-scenario.md)；远程完整及真实环境验收仍待执行。

## 1. 定位与边界

专题回答：“针对这家企业的某款目标产品，哪些业务场景值得探索，现有软件线索支持什么，新购／替换／补充路径分别需要验证什么？”

复用第一阶段的企业档案、证据、补查、任务、共享权限、预算、版本和取消机制。专题是同一研究流水线中的版本化模板，不新建队列、档案表、证据库或 MCP 工具集合。

范围限定现有七产品及其替代软件的客户使用线索。首版不比较产品功能、价格、优劣或迁移工具，不采集产品官方能力库或内部销售材料，不推导成交概率，不自动联系客户、写 CRM 或调度后续研究。

用户可指定一款或多款目标产品；专题必须显式选择 products，不默认展开七项。每个产品分别输出，不将 CAD 线索自动视为 PLM 需求。最多七项，沿用现有 ProductKey，不允许自定义产品。

## 2. 用户流程

1. 用户要求“围绕 Windchill 分析该企业的销售切入场景”。有企业档案时读取最新版本，没有时先完成企业画像身份确认。
2. 通过第一阶段 `start_company_research` 发起专题，选择 product_sales_scenario 模板及产品。已有档案首次做专题使用 continue；没有档案使用 initial，不要求先跑一遍七产品研究。
3. 优先读取该企业已有产品事实、工程场景、招聘、图谱职业证据和未解问题。模板挑选与产品有关的问题，不重复检索已经解决且仍适用的证据。
4. 缺口影响判断时，在同一次标准预算内补查。专题没有额外预算池，没有“完成通用研究后再完整研究一次”的隐式串行调用。
5. 用既有规则计算目标产品机会，并生成专题结构；保存为同一企业的新研究版本。
6. 首屏展示简要结论、值得探索的路径及关键验证问题；聊天按需读取证据。读取和展开不得调用模型或上游。
7. 用户要求继续或更新时仍用同一工具与模板；基线固定到发起时的版本，完成前不混入其他任务的新结果。

团队共享和同企业单任务互斥均沿用第一阶段。不因更换模板绕过队列、操作者额度或幂等约束。

## 3. 专题输出

每个目标产品包含以下部分；证据不足时返回不足，不虚构完整答案。

| 部分 | 内容与约束 |
| --- | --- |
| 场景摘要 | 客户的产品、工程活动、流程或技术约束；分别标明事实与假设 |
| 现有软件线索 | 软件、用途、岗位/项目/企业归属、时间与证据强度，不填充未知版本和规模 |
| 产品机会 | 沿用确定性规则的等级、置信度及依据；标明覆盖范围和事实时间 |
| 销售路径 | 新购、替换、补充，各给出探索状态、理由、成立前提和证据，不强行选出最佳路径 |
| 障碍与未知项 | 有依据的限制与待询问的问题分开，不将假想风险写成客户事实 |
| 验证问题 | 围绕关键前提的中立问题，按对判断的影响排序；不生成完整拜访简报 |

路径状态使用 `worth_exploring / insufficient / contradicted`，分别显示为“值得验证／依据不足／已有反证”。这些是销售假设的探索状态，不是采购阶段或成交可能性。

- **新购**：有相关工程活动和新增/未满足场景线索时提出。未发现软件记录不等于客户没有软件；“尚未覆盖”必须有证据，否则只能列为问题。
- **替换**：有现有方案证据，并有相关不足、替换计划或业务约束证据时可标 worth_exploring；仅发现竞品或招聘要求时为 insufficient。不能推断我方替换可行或更优。
- **补充**：有现有工作场景及新增/未覆盖活动的证据时可提出；不能断言现有软件不具备某能力，除非客户资料明确描述其实际使用限制。
- **反证**：如明确不启动相关项目，仅影响与之矛盾的路径，保留来源和时间，不扩大成企业永久无机会。

每条 worth_exploring/contradicted 必须引用支持相关判断的 claim_id，引用闭包必须在版本内；附成立前提及仍需验证事项。insufficient 可以没有事实支持，但必须解释缺少什么，并且不能写肯定需求结论。

招募技能、关联个人技能、供应商项目只能按既定语义使用。无工程痛点证据时，招聘不能成为“客户现有软件不好用”的依据。

## 4. 七产品模板的研究问题

模板定义调查问题，不是我方产品能力宣称。替代软件沿第一阶段规范名称和原文分类，不扩展竞争产品功能数据库。

| 产品 | 客户场景调查重点 |
| --- | --- |
| Windchill | 产品数据、BOM、变更、版本、跨部门/供应商协作现状；已有 PLM/PDM 的使用线索及明确约束 |
| Feigenbaum QMS | 来料、过程、供应商质量、问题闭环、质量追溯的实际流程与工具；不能只凭认证推断系统需求 |
| Creo | 机械产品设计、装配、变型及设计协同的实际活动；已有 CAD 和岗位/项目使用证据 |
| CATIA | 复杂产品/曲面/系统设计等企业自身证据支持的活动；不能仅按所属行业认定需求 |
| Abaqus | 结构、材料、接触、非线性等实际分析/验证活动；区分内部仿真、委外和招聘技能要求 |
| CST Studio Suite | 电磁、天线、射频、EMC 等企业资料明确涉及的研发/验证任务及工具 |
| SolidWorks | 机械设计、产品开发、工程图和相关协作场景；区分个人经验与企业项目中的实际使用 |

同类 CAD/CAE 场景允许同时关联多款产品，但不能只因共同类别就声称可替代、功能等价或我方优势。产品模板的变化须递增模板版本，历史输出不重新解释。

## 5. 接口与存储衔接

### 5.1 模板元数据

第一阶段即实现以下结构，第二阶段只增加模板注册及严格类型分支：

```ts
type ResearchTemplateId = 'company_research' | 'product_sales_scenario';
interface TemplateRef { id: ResearchTemplateId; version: number }
interface ResearchEnvelope {
  schema_version: 1;
  template: TemplateRef;
  method_version: string;
  effective_goal: string;
  product_goals: Partial<Record<ProductKey, string>>; // 键严格等于product_keys
  product_keys: ProductKey[];
  parent_version_id: string | null;
  evidence_base_version_ids: string[];
}
```

第一阶段仅开放 company_research@1，收到 product_sales_scenario 返回 `RESEARCH_TEMPLATE_UNAVAILABLE`，在写入任务和调用上游前拒绝。不能接受任意字符串或预先返回空专题假装支持。

模板版本由服务端解析、在接受任务时固定，客户端不能注入任意历史模板版本。排队过程中部署版本变化时，执行已固定的实现；不可用则失败 `RESEARCH_TEMPLATE_UNAVAILABLE`，不得静默切换。模板实现是显式代码注册，不建设通用插件平台或动态提示词后台。

### 5.2 发起与读取

`start_company_research` 增加可选 template_id：

- initial 不传时默认为 company_research；专题必须显式传 product_sales_scenario 及非空 products。
- continue/refresh 不传时继承 base_version.template.id；显式传入可切换模板。切换不继承旧模板的隐含产品范围，必须明确 products；研究目标由模板默认目标与可选 goal 合成，并记录 effective_goal。
- 缺少goal时沿第一阶段规则，从服务端固定的同模板逐产品来源继承product_goals；档案base_version_id只作写入并发基线，不要求覆盖本次产品。切换模板时用新模板默认目标，不继承旧模板目标；显式goal覆盖本次目标产品。effective_goal按产品固定顺序由product_goals生成，不用模型改写；不允许目标文本扩展七产品外的研究范围。
- 版本冲突仍比较 dossier 的最新有效版本；产品专题不另设 head。借助 evidence_base_version_ids 记录读取的历史证据版本，但不能将旧版本当作并发写入基线。
- 幂等比较先归一化客户端请求（含显式/继承模板选择、产品和基线）再查同 actor/operation_id；命中回放后不重解析服务器当前模板版本。不同选择拒绝冲突，同一请求在模板升级后仍回放原任务。

示例（ID 用示意值，遵循现有非空有界字符串校验，不额外收紧为 UUID）：

```json
{
  "mode": "continue",
  "dossier_id": "<dossier UUID>",
  "base_version_id": "<latest version UUID>",
  "template_id": "product_sales_scenario",
  "products": ["windchill"],
  "goal": "分析现有产品数据与变更管理场景及值得验证的切入方向",
  "operation_id": "sales-scenario-windchill-001"
}
```

status 和 list_versions 返回 template、products 与 schema_version。get_company_research 保留共同摘要/证据/缺口结构，附模板结果：

```ts
type TemplateResult =
  | { kind: 'company_research' }
  | { kind: 'product_sales_scenario'; products: ProductScenario[] };
interface ProductScenario {
  product: ProductKey;
  scene_claim_ids: string[];
  software_claim_ids: string[];
  paths: Array<{
    kind: 'new_purchase' | 'replacement' | 'complement';
    state: 'worth_exploring' | 'insufficient' | 'contradicted';
    rationale: string;
    supporting_claim_ids: string[];
    contradicting_claim_ids: string[];
    prerequisites: string[];
    questions: string[];
  }>;
  known_blocker_claim_ids: string[];
  unknowns: string[];
}
```

每产品 paths 必须各有一条三种路径状态，无重复，insufficient 可在首屏合并展示；products 集合与研究范围完全一致。事实通过 claim_id 指向共同证据，不能在 rationale 中偷偷新增未被验证事实。读取证据仍用原 version_id/claim_id/product 参数，无需新工具。

### 5.3 证据来源、版本和差异

run.request_json 保存 template 与有效目标；version.snapshot_json 保存 envelope 与 template_result。无需新增 SQL 列或专题表。第一阶段严格 schema 只写 company_research 分支，第二阶段增加 product_sales_scenario 分支；旧快照仍按原 schema 解码。

模型与渲染器都不能修改 evidence_id、来源时间和 company_scope。专题只继承关联范围的完整证据组；引用历史证据时将所需证据快照及依赖复制进新版本，保留原 ID、时间与定位，使版本内分页可以独立解析，不要求用户跨多个版本拼凑证据。evidence_base_version_ids 记录来源，不代替引用闭包。

模板切换、模板版本升级和目标变化列入 method_changes，不当成企业业务变化。事实/软件/评级变化仍按第一阶段稳定键比较。模板产生新路径假设时标为 analysis_changes，不能写成企业发生了新采购动作。

`product_assessments` 仍由统一规则生成；仅模板重组而没有事实变化时，评级必须一致。补查获得新的有效事实时允许规则产生不同评级，并说明证据变化。

get_company_research 未指定版本时读取档案最新有效版本。若最新是通用研究，不自动拼接旧专题或重新生成专题；版本目录返回模板标识，用户可明确选择旧专题。每产品覆盖信息必须附 template/version_id/as_of，不能将旧专题假设当作刚更新的成果。

### 5.4 失败、回退与发布

通用证据抽取失败沿用第一阶段处理。事实有效但专题输出校验失败时，在原预算内最多重试一次；仍失败可发布 partial，三种路径均 insufficient，说明 TEMPLATE_OUTPUT_INVALID，保留已验证事实及问题，不伪造专题结论。重试仍占用同一模型调用额度。

schema_version 是存储协议版本，template.version 是模板行为版本，method_version 标识证据处理/评级适配方法，三者不能混用。模板兼容性由注册表显式判断。

第一阶段读取器遇到未来专题版本时返回 `RESEARCH_VERSION_UNSUPPORTED`，不按通用版本误解也不写入。启动发现库中存在自身不支持的已完成版本时，关闭新研究写入口并提供明确状态；仍允许读取其支持的历史版本，旧评估与其他功能保持可用。运行中的未知模板任务按启动恢复规则失败，不自动重跑。第二阶段部署后不能假定直接回退第一阶段即可继续写库；回退需停止研究写入，使用兼容版本，或在明确接受数据损失后恢复一致性备份。

## 6. 第一阶段必须预留的最小集合

| 位置 | 第一阶段实现 | 第二阶段扩展 |
| --- | --- | --- |
| 请求与 run | template_id、服务端固定 TemplateRef、有效目标、幂等策略 | 开放专题模板，校验显式产品范围 |
| 版本与读取 | schema_version/method_version/template、证据来源版本、通用 template_result | 新增严格专题结果分支，历史兼容 |
| 多轮研究 | 一个模板模块提供问题集合、结果结构与提示词，预算仍由 Runner 控制 | 增加七产品场景问题与路径输出 |
| 证据与 claims | 稳定 ID、结构化语义键、完整依赖闭包、归属与时间 | 专题通过 claim_id 引用，不复制评级逻辑 |
| 差异与摘要 | business/method/analysis 变化分开；所有读取标模板 | 专题摘要、路径变化，不伪装业务变化 |
| 生命周期 | 不支持模板/版本明确拒绝，升级不改变旧请求回放 | 新增模板部署与回退兼容检查 |

不预留空专题表、额外队列、任意 JSON 插件结果或独立 API；不先实现七产品专题提示词、三路径生成器和专题渲染页面。

## 7. 后续消费者衔接

[首次拜访准备](2026-10-17-first-visit-preparation-design.md)读取本专题已存路径、问题和证据，但无专题时仍能从通用研究生成简报，不自动补跑专题。[单产品企业比较](2026-10-17-product-company-comparison-design.md)读取共同 product context 和确定性评级，不能把替换/补充假设直接当作项目或采购信号。

两者复用第一阶段第3.4节的最小单产品读取、coverage、evaluator_version、已验证claims及证据复查时间。完整ProductResearchContext和freshness消费策略在拜访阶段按需实现，跨企业批量读取及timing_signals/known_blockers投影在比较阶段实现，不作为第一阶段或专题阶段的占位代码。专题保持相同的事实/引用/时间语义，路径仅存template_result；不存在证据的字段不能通过专题文案补齐，last_checked_at不因专题重组旧证据而改变。

## 8. 验收场景与衔接门槛

第一阶段预留测试：旧请求省略 template_id 行为不变；专题请求被明确拒绝且不写任务；同一请求跨模板升级仍回放；版本元数据和证据引用闭包可读；未知 schema/template 不静默误解析。

专题阶段验收：

- 无档案可直接 initial 指定产品专题；有档案可 continue 切换模板，不重复建立企业档案。
- CAD 招聘仅支持技能或使用线索，不能自动产生替换假设；个人技能和供应商项目归属边界保持。
- 已有方案加明确痛点可形成待验证替换路径，不能输出我方必然优于竞品。
- 三路径均依据不足时如实返回；不能强行挑选“最佳路径”。
- 同一事实仅更换模板不改变评级；方法变化、分析变化与企业变化可区分。
- 多产品分别出结果，未研究产品不标低机会；引用有缺失或跨企业时拒绝。
- 专题和通用任务同企业互斥，同一预算计数，取消后迟到结果不能提交。
- 阅读专题和展开证据不发起网络或模型调用；模型输出失败按部分完成显式回退。
- 历史模板版本保持原内容；回退旧程序不得解释或继续写未知版本。

先用合成数据与真实 SQLite 完成兼容及业务测试，再按项目规则通过远程原生/完整/容器 gate。真实客户资料、真实上游与宿主验收单独记录，不能把模板输出样例当作真实结论。
