# 目标客户体检远程 MCP v0.1

## 一、目标

部署一个中国大陆云上的远程 MCP 服务。

用户在 Codex 中输入企业名称，确认法定主体后提交体检任务。正常单任务通常在 5–10 分钟内获得一份中文 Markdown 报告；该时间是经验预估，不是 SLA，排队时可能更久。

首版只验证：

- 企业主体能否正确确认
- 企查查和公开网页证据能否有效组合
- 报告能否帮助销售判断是否值得跟进
- 七项产品机会中哪个更适合作为切入点

不追求团队级平台能力。

## 二、技术结构

使用：

- Node.js 24 LTS
- TypeScript
- 官方 MCP TypeScript SDK v2
- SQLite
- 单个应用进程
- HTTPS Streamable HTTP `/mcp`

同一进程同时处理：

- MCP 请求
- 后台体检任务
- SQLite 状态和报告存储
- 企查查 MCP 调用
- 豆包搜索 HTTP API 调用
- 火山方舟分析

不使用：

- PostgreSQL
- Redis
- 独立 Worker
- Kubernetes
- 微服务
- 豆包搜索 MCP Server 或额外 Python 运行时
- 网页 UI

进程重启时，尚未完成的 `processing` 任务统一标记为 `failed`，用户重新提交即可。

### 部署与密钥边界

- 公司现有中国大陆云的负载均衡或 API 网关终止 HTTPS，并对外提供 `/mcp`。
- 部署为单个常驻 Node.js 容器或虚拟机实例（副本数固定为 1），不用函数计算或自动扩缩；Node.js 应用只监听私网端口，不直接暴露公网 HTTPS。
- SQLite 数据库位于应用实例挂载的持久化云磁盘，不得写入容器临时文件系统；启用 WAL 模式和合理的 `busy_timeout`，以支持 MCP 请求与后台任务的并发读写。
- 应用校验 MCP 请求的 `Host`，仅接受配置的公开 MCP 域名。`ALLOWED_ORIGINS` 保存逗号分隔的完整 HTTPS Origin（scheme、hostname 和可选显式 port）；配置加载同时保留 `allowedOriginUrls` 完整值集合，并用 `new URL(v).hostname` 派生 `allowedOriginHostnames` 供 `createMcpExpressApp` 的 hostname 防护使用。SDK 防护之后、Bearer 认证之前增加同一文件内的小型 middleware：请求带有 `Origin` 时必须与 `allowedOriginUrls` 精确字符串匹配，否则返回 403；未携带 `Origin` 时放行到后续 Bearer 鉴权。
- 企查查、豆包搜索和火山方舟的调用地址、模型标识和凭证统一通过环境变量读取，不写入业务代码。用户 Bearer Token 的明文只在创建时显示一次，由客户端的安全环境变量保存；服务端只保存其哈希。
- 本地开发和测试从 `.env` 加载环境变量；生产环境由云密钥管理或部署平台注入同名环境变量，不依赖服务器磁盘上的 `.env` 文件。
- `.env` 必须加入 `.gitignore`；仓库只保存不含真实凭证的 `.env.example`。真实凭证不得写入代码、SQLite、报告、日志或测试夹具。
- 健康检查仅供内部负载均衡访问，不提供公开调试接口。

### 上游环境变量

首版使用以下内部配置名；适配器负责将其转换为各上游实际需要的请求头和参数：

```ini
QCC_MCP_COMPANY_URL=https://agent.qcc.com/mcp/company/stream
QCC_MCP_RISK_URL=https://agent.qcc.com/mcp/risk/stream
QCC_MCP_IPR_URL=https://agent.qcc.com/mcp/ipr/stream
QCC_MCP_OPERATION_URL=https://agent.qcc.com/mcp/operation/stream
QCC_API_KEY=

DOUBAO_SEARCH_API_URL=https://open.feedcoopapi.com/search_api/web_search
DOUBAO_SEARCH_API_KEY=

ARK_API_URL=
ARK_MODEL=
ARK_CREDENTIAL=
```

应用启动时只从 `process.env` 挑选上述已声明配置键，再交给拒绝未知字段的严格 Schema 校验；`PATH`、`HOME` 等进程固有键不得导致启动失败。调用地址必须是合法的 HTTPS URL，模型标识和凭证必须为非空字符串；缺失或非法时拒绝启动，错误和日志只列配置名称，不输出配置值或整个环境对象。企查查 4 个远程 MCP Server 共用 `QCC_API_KEY`；豆包搜索使用独立的 `DOUBAO_SEARCH_API_KEY`。两者请求头均使用 `Authorization: Bearer <对应 API Key>`。

## 三、鉴权

每位用户使用独立 Bearer Token。

服务端保存：

- Token 哈希
- 用户标识
- 是否启用
- 创建时间

Token 仅用于：

- 验证调用者
- 日志归属
- 单独撤销

不新增 MCP 管理工具或网页界面。部署管理员通过仅在受控运维环境可运行的本地 CLI 创建、禁用和查看 Token 元数据：

- `tokens:create --user <id>`：生成随机 Token，只输出一次明文，同时写入 Token 哈希、用户标识、启用状态和创建时间。
- `tokens:disable --user <id>`：禁用该用户的 Token；后续请求立即拒绝。
- `tokens:list`：只显示用户标识、启用状态和创建时间，绝不显示 Token 明文或哈希。

首版不实现：

- 用户限流
- 用户配额
- 角色权限
- 报告跨用户隔离
- OAuth

`assessment_id` 使用随机 UUID，降低被猜测的风险。

## 四、四个 MCP 工具

### 1. `get_company_profile`

用于初步了解企业，不启动完整销售评估。

输入：

```json
{
  "query": "深圳市海明润超硬材料股份有限公司",
  "region_hint": "深圳"
}
```

当只有一个明确匹配主体时，除候选主体外立即返回基础画像。该调用只使用企查查基础信息，不调用豆包搜索和火山方舟，不创建异步任务。

```json
{
  "source_status": "completed",
  "candidates": [
    {
      "legal_name": "深圳市海明润超硬材料股份有限公司",
      "credit_code": "...",
      "status": "存续",
      "registered_address": "...",
      "match_reason": "名称完全匹配"
    }
  ],
  "basic_profile": {
    "industry": "超硬材料制造",
    "region": "深圳",
    "company_type": "股份有限公司",
    "founded_year": 2010,
    "registered_capital": "...",
    "legal_representative": "...",
    "website": "...",
    "employee_range": "100-499",
    "risk_summary": "未发现明显经营异常",
    "collected_at": "2026-08-28T10:00:00.000Z"
  },
  "cache_hit": false
}
```

基础画像只回答企业是什么、在哪里、做什么、是否正常经营和大致规模，不包含七项产品机会、采购时机判断或销售行动建议。多候选时只返回候选列表和匹配依据，不自动选择，也不生成基础画像。

企查查调用失败后重试一次；仍失败时不生成候选和画像，返回：

```json
{
  "source_status": "failed",
  "candidates": [],
  "basic_profile": null,
  "cache_hit": false,
  "message": "企查查暂不可用，请稍后重试"
}
```

该来源失败作为正常工具结果返回，不转换为泛化 MCP 内部错误。

### 2. `submit_assessment`

输入：

```json
{
  "credit_code": "...",
  "legal_name": "深圳市海明润超硬材料股份有限公司",
  "force_refresh": false
}
```

按统一社会信用代码查找最近结果。30 天内有效的已完成报告直接复用，仍在 `processing` 的任务直接返回原任务；失败任务允许重新提交。SQLite 事务和部分唯一索引保证同一主体同时只有一个 `processing` 任务。`force_refresh=true` 时忽略已完成缓存，但若已有进行中任务仍返回该任务，避免重复上游调用。

新建任务或复用进行中任务时输出；两种情况均明确表示未命中完成报告缓存：

```json
{
  "assessment_id": "uuid",
  "status": "processing",
  "estimated_minutes": "5-10",
  "cache_hit": false
}
```

复用有效期内的已完成报告时，不伪装成进行中任务，输出：

```json
{
  "assessment_id": "uuid",
  "status": "completed",
  "cache_hit": true,
  "cached_at": "2026-08-29T10:00:00.000Z"
}
```

`cached_at` 等于该报告的 `completed_at`；报告 TTL 也只按 `completed_at` 计算。

### 3. `get_assessment_status`

只保留三种状态：

- `processing`
- `completed`
- `failed`

输出：

```json
{
  "assessment_id": "uuid",
  "status": "processing",
  "message": "正在收集公开资料"
}
```

不暴露内部八阶段状态机。

### 4. `get_assessment_report`

任务完成时返回 Markdown，并附少量结构字段：

```json
{
  "assessment_id": "uuid",
  "status": "completed",
  "legal_name": "...",
  "overall_opportunity": "高",
  "recommended_product": "windchill",
  "collected_at": "2026-08-29T10:00:00.000Z",
  "dynamic_signal_freshness": "current",
  "source_status": {
    "qcc": "completed",
    "doubao_search": "failed",
    "ark": "completed"
  },
  "markdown": "..."
}
```

`processing` 时返回当前状态，不作为 MCP 工具错误。任务失败时返回：

```json
{
  "assessment_id": "uuid",
  "status": "failed",
  "message": "模型事实整理不可用"
}
```

失败结果不包含 Markdown，也不转换为泛化 MCP 内部错误。

当没有任何产品机会达到有效判断门槛时，返回 `overall_opportunity: "待核实"`、`recommended_product: null`；Markdown 只说明待补充的证据和下一步核实动作，不输出产品、目标岗位或销售切入建议。

### 工具选择规则

- “看一下”“了解基本情况”“这家公司是做什么的”等请求，调用 `get_company_profile`。
- “正式评估”“做客户体检”“判断是否值得跟进”“推荐切入产品”等请求，先调用 `get_company_profile`，确认法定主体后再调用 `submit_assessment`。
- 用户意图不明确时，默认调用 `get_company_profile`，不得直接启动完整评估。
- `submit_assessment` 必须接收用户已经确认的 `legal_name` 和 `credit_code`。

### MCP 输入最小校验

四个工具在运行时使用 MCP input schema 校验必填字段、基本类型和最大长度，拒绝未知字段并返回明确的参数错误。首版不做名称与信用代码的交叉核验，也不增加业务权限规则。

- `query`、`legal_name`：非空字符串，最大 256 个字符。
- `region_hint`：可选字符串，最大 64 个字符。
- `credit_code`：18 位大写字母或数字的统一社会信用代码基本格式。
- `force_refresh`：可选布尔值，默认 `false`。
- `assessment_id`：UUID 格式。

### 缓存策略

- **主体基础画像**：以统一社会信用代码作为主键缓存，并为规范化法定名称建立查找索引，默认有效期由 `PROFILE_CACHE_TTL_DAYS=30` 配置。`get_company_profile` 先按规范化法定名称查找有效缓存；只有一个匹配结果时直接返回，多个结果时结合 `region_hint` 过滤，仍无法唯一确认则调用企查查。简称或模糊名称不直接命中该索引。缓存的是清洗后的主体字段，不保存企查查原始响应；每次返回必须附 `collected_at` 和“截至该时间的快照”标记。该配置只控制是否复用，不控制数据删除。
- **动态信息**：经营状态、处罚、诉讼、招聘、招投标、扩产和采购信号不视为 30 天内不变。它们只在正式评估任务中重新采集，并在报告中标注各自采集时间。
- **正式评估报告**：默认复用从 `completed_at` 起算、`ASSESSMENT_CACHE_TTL_DAYS=30` 天内的已完成报告；不得用 `created_at`、`collected_at` 或最后读取时间延长 TTL。超过期限时创建新任务。首版不使用规则版本自动失效缓存；规则改变后如需立即生成新报告，使用 `force_refresh=true`。缓存是否命中只由 `submit_assessment` 返回；报告保留信息截至时间。读取报告时由报告模块纯函数使用持久化 `completed_at` 和当前时间计算时效：严格超过 7 天才返回 `stale` 并规范化加入唯一警告，恰好 7 天仍为 `current`；不保存或重建 `ReportModel`。该配置只控制是否复用，不控制数据删除。
- 用户说“重新查最新情况”“强制刷新”或“不要使用缓存”时，调用 `force_refresh=true`。
- `cache_hit` 只出现在 `get_company_profile` 和 `submit_assessment` 的输出中：基础画像用自身 `collected_at` 表示快照时间；完成报告缓存由 `submit_assessment` 返回 `cached_at=completed_at`。进行中任务复用和新建任务均返回 `cache_hit: false`；`get_assessment_status` 与 `get_assessment_report` 不返回该字段。

## 五、处理流程与模块边界

```text
get_company_profile：确认法定主体并返回基础画像
    ↓
建立主体身份档案（全称、简称、曾用名、品牌及集团关系）
    ↓
并行收集企查查与豆包搜索资料，形成 ResearchBundle
    ↓
方舟豆包模型整理为 EvidenceBundle，并判断主体归属和行业分类
    ↓
确定性规则判断七项产品机会
    ↓
生成 Markdown 报告
    ↓
SQLite 保存最终报告
```

以上模块全部运行在同一个 Node.js 进程中；“模块”是代码和数据契约边界，不是独立服务。这样可以分别修改信息源、机会规则和报告格式，而不引入微服务部署成本。

### 模块一：信息获取与证据整理

职责：

- 调用企查查 MCP
- 调用豆包搜索 HTTP API
- 建立主体身份档案
- 处理简称、曾用名、品牌、集团和子公司关系
- 记录来源失败、调用次数和信息缺口

输入：已确认的 `legal_name`、`credit_code`。

输出：`ResearchBundle`，包含已获取的来源条目、URL、标题、摘要、发布时间或采集时间、来源状态和主体身份档案，不包含产品机会等级，不生成销售结论，不生成 Markdown。

#### 模型事实引用校验

企查查和豆包搜索是首版信任的数据源，不做二次真实性审查。方舟豆包模型接收 `ResearchBundle`，从本次已获取的来源中抽取和组织事实，判断证据主体归属，并输出结构化 `EvidenceBundle`。每个事实和非 `unverified` 的行业分类必须引用已有的 `evidence_id`；当 `ResearchBundle` 为空时，允许输出没有证据引用的 `unverified` 分类和空事实列表。

方舟输出的行业分类为 `P1`、`P2`、`non_target` 或 `unverified`。模型可以根据来源资料自由分类，因此重新调用方舟时分类可能变化；机会判断模块不得自行重新分类。

服务端校验被引用的 `evidence_id` 对应本次 `ResearchBundle` 中已有的来源条目，且 URL、网页提及名称和主体归属字段完整。模型不得创建新来源、URL、别名或证据 ID。方舟适配器对一次调用只发起一次 HTTP 请求；方舟返回空内容、非法 JSON、悬空引用或其他不合格结构时抛出类型化错误，由任务编排的 `retryOnce` 重试整个调用一次。第二次仍不合格则任务标为 `failed`，不生成正式报告。

固定提示和服务端校验同时保守拒绝以下推断，无论它们出现在 `facts[].statement`、`conflicts[]` 还是 `gaps[]`：高管人格或按年龄推断决策风格；营收估算、倒推或员工人数/行业人效乘法；把招聘、扩产等线索改写为采购意向、计划采购、即将采购或有采购需求。已发布的招聘和招投标原始事实仍允许保留；销售问题可以询问采购计划。

#### 企查查适配器契约

首版只实现一个企查查适配器，不建立通用多数据源框架。适配器只连接企查查官方的 4 个企业主体远程 MCP Server；它们共用同一个 API Key：

- `qcc-company`：主体识别、工商、简介、联系方式、股东、实控人和主要人员
- `qcc-risk`：风险扫描、经营异常、行政处罚、执行和司法风险
- `qcc-ipr`：专利、商标、软件著作权等技术资产
- `qcc-operation`：年报、资质、融资、招投标、招聘和其他经营信号；其中融资和招聘是正式评估的重点信息

`qcc-history`、`qcc-executive`、`regulation`、`case`、`tender` 和 `document` 不进入 v0.1。当前主要人员由 `qcc-company` 获取；司法和招投标优先使用企业主体 Server 中可按已确认主体查询的工具，首版不做个人深度背景、通用法规/案例/标讯检索或文档解析。

接入前读取 4 个 Server 的实际工具目录，记录已使用工具的名称、输入参数、调用上限和返回字段，并为每个已使用工具保存脱敏 JSON 测试样本。官方新增或调整工具时，不自动扩大调用范围，只有适配器映射表中明确允许的工具可以被任务编排模块调用。

适配器负责把企查查返回统一映射为 `IdentityProfile` 和 `ResearchBundle` 所需字段：主体标识、工商状态、别名、股权/集团关系、主要人员、风险、知识产权、年报、资质、融资、招投标、招聘和其他经营线索。某项数据不存在或企业未披露时记录为信息缺口，不因单项缺失直接降低机会等级；字段缺失、认证失败、配额耗尽和上游工具变更必须映射为明确的来源状态和信息缺口，不得静默跳过。

正式评估固定为最多 8 次企查查调用。`get_financing_records` 排在第一位，`get_recruitment_info` 排在第二位，不得被其他调用或重试挤出预算；其余调用按主体、风险、专利、年报、招投标等基础需要排列，最后一个名额可在股东、软件著作权和资质中按信息缺口选择。融资调用失败但其他企查查资料可用时，企查查整体状态为 `partial`；全部企查查调用均无可用资料时才为 `failed`。报告正文必须明确列出“融资信息获取失败”，但不增加独立的融资状态字段，也不得用豆包搜索结果伪装成企查查融资记录。

适配器的输入输出使用运行时 Schema 校验；契约测试覆盖 4 个 Server 的连接配置、Bearer 鉴权、工具入参、关键字段映射、缺字段、认证失败和上游返回结构变化。

企查查客户端的单次 `call` 不做业务重试。遇到 transport error 时只关闭并丢弃当前 client/transport，然后立即抛出类型化错误，不得在客户端内部重发同一工具调用；任务编排的下一次外层 `retryOnce` attempt 再懒加载新连接并发起一次调用。这样每个上游业务请求只有一个重试所有者，也不会在网络结果未知时出现隐式第三次调用。

#### 豆包搜索适配器契约

v0.1 直接调用豆包搜索 Custom 版 HTTP API，不部署或连接豆包搜索 MCP Server，也不引入 Python、UV 或 UVX。适配器通过 `POST DOUBAO_SEARCH_API_URL` 请求搜索接口，使用 `DOUBAO_SEARCH_API_KEY` Bearer 鉴权，并把返回的网页结果统一映射为 `ResearchBundle` 来源条目。

适配器固定 `SearchType=web` 和 `Filter.NeedUrl=true`，不启用图片搜索。每条查询必须满足 API 的 1～100 字符限制，`Count` 不得超过 50；首版搜索计划默认每次最多取 10 条结果。近期招聘、采购、扩产等动态查询使用 `TimeRange=OneYear`；官网、产品、软件生态等非时效性查询不设置 `TimeRange`。招聘和需要正文的技术场景查询设置 `Filter.NeedContent=true`，其他发现型查询设置为 `false`，避免因为正文缺失而过早排除有效链接。

适配器只接收搜索计划生成的明确查询，不让模型在调用过程中自行追加查询。它保留标题、站点名、URL、正文或摘要、发布时间、排序位置、搜索原始 Query、采集时间和日志 ID，并将原始发布方与 URL 域名分别映射为 `originalPublisher`、`originalDomain`；缺少正文、发布时间或原始发布方时明确留空，不由模型补写。API 参数错误、鉴权失败、额度不足、QPS 限制和服务端错误统一映射为来源错误。`DoubaoSearchClient.search(query)` 是不接收预算的单次 HTTP attempt；只有任务编排把预算交给 `retryOnce`，后者在每个 attempt 前计入 `MAX_SEARCH_CALLS` 和总调用预算。预算耗尽时编排不得调用 client。

### 模块二：机会判断

职责：

- 接收 `EvidenceBundle`
- 按固定规则分别判断七项产品机会
- 应用 P1/P2、技术场景、组织复杂度、软件生态、采购时机、预算和决策权逻辑
- 处理证据不足、主体冲突和集团/子公司边界
- 选出最佳切入产品和综合机会等级

输入：`EvidenceBundle`。

输出：`OpportunityAssessment`，包含七项产品的 `高/中/低/待核实`、依据证据 ID、阻碍、缺口和综合判断。

本模块不得调用外部数据源，不负责网页搜索，不直接生成 Markdown。相同的 `EvidenceBundle` 必须产生相同结果；该确定性承诺不覆盖重新调用方舟可能产生的行业分类差异。

### 模块三：报告输出

职责：

- 接收 `EvidenceBundle` 和 `OpportunityAssessment`
- 有有效产品机会时生成一屏摘要、七项产品矩阵、关键证据、销售建议、风险与缺口；无有效产品机会时只生成证据缺口、来源状态和下一步核实动作
- 将证据 ID 渲染为来源名称、链接、时间和主体归属依据
- 将已验证的 `EvidenceFact.statement` 逐条渲染，并为其引用的每个 `EvidenceReference` 单独保留链接；产品支持标签必须同时满足 fact 的 `productTags` 和该产品行引用相同 evidence ID，行业资料不得被标成支持无关低机会产品
- 输出 Markdown 及 MCP 所需的少量结构字段

本模块不得调用企查查、豆包搜索或分析模型，不重新判断机会，不修改分级结果。报告只能由结构化结果渲染，避免报告文字与判断结果不一致。

### 模块四：任务编排

职责：

- 接收四个 MCP 工具请求
- 创建和更新 SQLite 任务状态
- 顺序调用“信息获取 → 方舟整理 → 机会判断 → 报告输出”
- 按内部并发阈值调度任务，处理重试、总调用上限、失败降级和进程重启恢复
- 仅保存最终报告和任务元数据

任务编排模块不包含具体搜索规则、机会规则或报告文案；调整这些内容不应修改 MCP 工具接口。企查查和豆包搜索失败只影响对应来源状态，方舟失败或服务无法持久化报告时任务标为 `failed`。对外的 `processing` 同时表示“等待内部调度”和“正在执行”，不新增 `queued` 状态。

任务调度采用单进程内存 FIFO 队列。新任务先写入 SQLite，再加入队列；同时最多运行 `MAX_CONCURRENT_ASSESSMENTS` 个任务，首版默认值为 1。当前任务结束后自动启动下一项。队列不负责崩溃恢复；进程重启后，SQLite 中遗留的 `processing` 任务统一标为 `failed`。

所有企查查工具调用、豆包搜索 HTTP 请求和方舟 HTTP 请求都必须由任务编排模块的同一个 `retryOnce` 包装；适配器和 mapper 不得自行重试或递归调用。`retryOnce` 最多执行两个 attempt，并在每个 attempt 发起网络请求前分别占用分项和总调用预算。

### 模块间最小数据契约

```text
IdentityProfile
    ↓
ResearchBundle
    ↓
EvidenceBundle
    ↓
OpportunityAssessment
    ↓
ReportModel / Markdown
```

五个契约使用 TypeScript 类型和运行时 Schema 固定字段。模块之间只依赖契约，不依赖对方的内部实现。信息获取、机会判断和报告输出分别编写单元测试，再增加一组端到端契约测试验证字段兼容性。

#### 契约字段冻结

所有对象 Schema 均拒绝未知字段；下列字段全部必需，只有显式标为 `| null` 的值可为空，数组无值时使用 `[]`。`UtcTimestamp` 统一为 `Date.toISOString()` 生成的 ISO 8601 UTC 字符串（`YYYY-MM-DDTHH:mm:ss.sssZ`），不得混用本地时间、Unix 秒或仅日期字符串。

```ts
type UtcTimestamp = string; // Date.toISOString()
type ProductKey = 'windchill' | 'feigenbaum_qms' | 'creo' | 'catia' |
  'abaqus' | 'cst' | 'solidworks';

type IdentityProfile = {
  legalName: string;
  creditCode: string;
  formerNames: string[];
  aliases: string[];
  englishNames: string[];
  brands: string[];
  officialDomains: string[];
  registeredAddress: string | null;
  parentLegalName: string | null;
  subsidiaryLegalNames: string[];
};

type ResearchItem = {
  evidenceId: string;
  source: 'qcc' | 'doubao_search';
  sourceKind: 'company' | 'risk' | 'ipr' | 'operation' | 'web';
  title: string;
  url: string;
  originalPublisher: string | null;
  originalDomain: string | null;
  summary: string | null;
  content: string | null;
  publishedAt: UtcTimestamp | null;
  collectedAt: UtcTimestamp;
  mentionedName: string;
  entityScope: 'legal_entity' | 'group' | 'subsidiary' | 'brand' | 'unknown';
  entityMatch: 'confirmed' | 'probable' | 'unverified';
  matchBasis: string[];
  query: string | null;
  position: number | null;
  logId: string | null;
};

type ResearchBundle = {
  identity: IdentityProfile;
  items: ResearchItem[];
  sourceStatus: {
    qcc: { status: 'completed' | 'partial' | 'failed'; error: string | null };
    doubaoSearch: { status: 'completed' | 'partial' | 'failed'; error: string | null };
  };
  gaps: string[];
  collectedAt: UtcTimestamp;
};

type EvidenceReference = {
  evidenceId: string;
  title: string;
  url: string;
  originalPublisher: string | null;
  originalDomain: string | null;
  publishedAt: UtcTimestamp | null;
  collectedAt: UtcTimestamp;
  mentionedName: string;
  entityScope: 'legal_entity' | 'group' | 'subsidiary' | 'brand' | 'unknown';
  entityMatch: 'confirmed' | 'probable' | 'unverified';
  matchBasis: string[];
};

type EvidenceFact = {
  factId: string;
  statement: string;
  kind: 'industry' | 'product_scene' | 'recruitment' | 'software_ecosystem' |
    'organization' | 'quality' | 'manufacturing' | 'procurement' | 'budget' |
    'decision_power' | 'risk';
  productTags: ProductKey[];
  strength: 'direct' | 'supporting' | 'weak';
  evidenceIds: string[];
  entityScope: 'legal_entity' | 'group' | 'subsidiary' | 'brand' | 'unknown';
  entityMatch: 'confirmed' | 'probable' | 'unverified';
  matchBasis: string[];
};

type FinancingRecord = {
  occurredAt: UtcTimestamp | null;
  typeOrRound: string | null;
  disclosedAmount: string | null;
  investors: string[];
  evidenceIds: string[];
};

type EvidenceBundle = {
  identity: IdentityProfile;
  industryClassification: 'P1' | 'P2' | 'non_target' | 'unverified';
  industryEvidenceIds: string[];
  evidence: EvidenceReference[];
  facts: EvidenceFact[];
  financingRecords: FinancingRecord[];
  conflicts: string[];
  gaps: string[];
  collectedAt: UtcTimestamp;
};

type ProductOpportunity = {
  product: ProductKey;
  level: '高' | '中' | '低' | '待核实';
  evidenceIds: string[];
  reasons: string[];
  blockers: string[];
  gaps: string[];
};

type OpportunityAssessment = {
  products: ProductOpportunity[]; // 七个 ProductKey 各且仅各一项
  overallOpportunity: '高' | '中' | '低' | '待核实';
  recommendedProduct: ProductKey | null;
  summaryReasons: string[];
};

type ReportModel = {
  legalName: string;
  industryClassification: 'P1' | 'P2' | 'non_target' | 'unverified';
  companyScaleClues: string[];
  overallOpportunity: '高' | '中' | '低' | '待核实';
  recommendedProduct: ProductKey | null;
  summaryReasons: string[];
  latestFinancing: FinancingRecord | null;
  products: ProductOpportunity[];
  facts: EvidenceFact[]; // 只含目标法定主体、引用存在且归属与全部引用一致的事实
  evidence: EvidenceReference[];
  salesQuestions: string[];
  risks: string[];
  gaps: string[];
  nextVerificationActions: string[];
  sourceStatus: {
    qcc: 'completed' | 'partial' | 'failed';
    doubaoSearch: 'completed' | 'partial' | 'failed';
    ark: 'completed';
  };
  collectedAt: UtcTimestamp;
  dynamicSignalFreshness: 'current' | 'stale';
};
```

`originalPublisher` 和 `originalDomain` 表示原始发布方，而不是企查查或豆包搜索这一获取通道。去重优先按规范化 `originalDomain`，缺失时按规范化 `originalPublisher`；两者都为空的条目可以引用，但不能计入“两个独立原始发布方”的门槛。同一去重键的转载只计一次。`EvidenceReference` 必须由服务端从对应 `ResearchItem` 复制并校验，方舟不得创建或改写这些来源字段。这里的契约只是五个既有模块边界，不抽象通用事件、来源或规则框架。

### 主体身份档案与证据归属

公开网页经常只使用企业简称、品牌名或集团名称，因此确认法定主体后，还需要建立轻量的主体身份档案：

- 法定全称
- 统一社会信用代码
- 曾用名
- 有来源支持的官方简称
- 英文名称
- 品牌名称
- 官方网站域名
- 注册地址
- 母公司和主要子公司

简称、英文名和品牌名必须有企查查、企业官网或监管披露等来源支持，模型不得自行创造别名。

搜索时可以使用已验证的简称和品牌名扩大召回范围，但每条证据在采信前必须重新判断主体归属。证据归属至少包含：

```json
{
  "mentioned_name": "海明润",
  "matched_legal_name": "深圳市海明润超硬材料股份有限公司",
  "entity_scope": "legal_entity",
  "entity_match": "confirmed",
  "match_basis": [
    "官网域名一致",
    "产品名称一致",
    "注册地址一致"
  ]
}
```

`entity_scope` 取值：

- `legal_entity`：目标法定主体
- `group`：目标所属集团
- `subsidiary`：目标子公司
- `brand`：品牌或事业部
- `unknown`：无法确认

`entity_match` 取值及采信规则：

- `confirmed`：全称、信用代码、官方域名或多个身份要素明确一致，可以作为事实并参与机会判断
- `probable`：简称一致，并有行业、产品、地域等辅助证据；可以写入报告并注明依据，但关键机会判断不能只依赖这一条
- `unverified`：只有简称或模糊提及，只能作为调查线索，不能参与机会判断

集团、子公司、品牌和事业部证据不得自动归属于目标法定主体。招聘、采购、招投标及软件使用证据必须检查发布主体；存在同名、简称冲突或归属不足时，在报告中标记“主体归属待核实”。

每份报告设置一个可配置的总调用上限，例如：

```ini
MAX_QCC_CALLS=8
MAX_SEARCH_CALLS=8
MAX_ARK_CALLS=2
MAX_TOTAL_UPSTREAM_CALLS=18
PROFILE_CACHE_TTL_DAYS=30
ASSESSMENT_CACHE_TTL_DAYS=30
MAX_CONCURRENT_ASSESSMENTS=1
```

每次向企查查、豆包搜索或火山方舟发起的请求都计入对应分项和 `MAX_TOTAL_UPSTREAM_CALLS`，重试也计数。任一上限达到后，停止尚未开始的对应调用，并在报告中列出信息缺口。后台同时最多执行 `MAX_CONCURRENT_ASSESSMENTS` 个评估；超额任务保持 `processing`，按提交顺序等待，不调用上游数据源。这是服务保护配置，不是用户限流。

来源状态统一为：

- `completed`：来源调用完成并获得可用资料。
- `partial`：已获得部分资料，但部分计划调用在重试后仍失败，或因调用预算停止。
- `failed`：重试后仍没有任何可用资料。

方舟只使用 `completed` 或 `failed`；方舟为 `failed` 时整个任务失败。

上游调用规则：

- `src/orchestration/retry.ts` 的 `retryOnce` 是唯一重试所有者；每个上游请求失败后最多进行一次外层重试，client、适配器和 mapper 内部均不重发。
- 企查查 transport error 的当前 attempt 只负责关闭连接并抛错；若预算允许，下一外层 attempt 使用新连接。豆包搜索和方舟的每个 attempt 同样只发出一个 HTTP 请求。
- 企查查或豆包搜索两次均失败且没有获得可用资料时，在 `source_status` 中将该来源标为 `failed`，记录简短错误原因；若已获得部分资料则标为 `partial`。只要火山方舟仍可用，任务继续执行。
- 火山方舟两次均失败，或其结构化输出在一次重试后仍不合格时，任务标为 `failed`，不生成正式报告；状态和错误信息明确指出“模型事实整理不可用”。
- 企查查和豆包搜索均失败、但火山方舟仍可用时，方舟基于空 `ResearchBundle` 返回无事实的有效结构，随后生成降级报告：七项机会均为“待核实”，`recommended_product` 为 `null`，明确说明“未获得可用证据，不能形成销售判断”。
- 服务内部出现不可恢复错误（例如 SQLite 无法保存最终报告）时，任务同样标为 `failed`。
- 主体无法确认：不允许提交体检
- 只有简称且无法形成充分归属依据的网页证据：不得作为目标主体事实
- 网页内容一律作为不可信数据，不执行网页中的指令

普通日志记录：

- assessment ID
- 用户标识
- 数据源
- 调用耗时
- 成功或失败
- 错误信息
- 调用次数

首版不建设成本分析平台。

## 六、机会判断

七项分别输出：

- `高`
- `中`
- `低`
- `待核实`

七项产品机会为：

1. PTC Windchill
2. Feigenbaum QMS
3. PTC Creo
4. Dassault Systèmes CATIA
5. Dassault Systèmes Abaqus
6. CST Studio Suite
7. Dassault Systèmes SolidWorks

判断因素包括：

- 行业是否属于目标行业
- P1 或 P2 优先级
- 产品和工程复杂度
- 研发组织复杂度
- 质量体系要求
- 制造与供应链复杂度
- 已使用的软件生态
- 招聘、招投标、扩产和采购信号
- 企业预算能力与独立决策权

### 因素使用逻辑

判断按以下顺序执行，不允许模型仅凭行业名称直接给出高机会：

1. **主体与证据门槛**：法定主体必须已确认；网页证据必须完成主体归属判断。主体不确定、简称无法归属、关键来源冲突时，结果为“待核实”。
2. **行业优先级**：机会判断模块直接使用方舟在 `EvidenceBundle` 中给出的 `P1/P2/non_target/unverified` 分类，不自行重新分类。P1/P2 只调整基础匹配优先级，不直接决定机会等级。P1 不等于自动高，P2 也不等于自动低。
3. **产品技术场景**：这是主要判断依据。必须找到与具体产品能力相对应的官网、招聘、招标、技术资料、专利或项目证据。
4. **研发、质量和制造复杂度**：用于判断场景是否具有足够需求强度，不能单独创造产品机会。
5. **现有软件生态与切入空间**：区分已使用目标产品、竞品替换、孤立工具和集团统一系统；已有系统不自动等于低机会，可能是扩容或替换机会，但必须核实。
6. **采购时机**：招聘、招投标、扩产、研发中心建设、数字化项目、认证升级和融资等近期信号，用于区分“理论适配”和“现在值得跟进”。
7. **预算与决策权**：判断企业是否有预算能力、目标主体是否拥有独立采购权，以及是否存在集团采购或经营风险。

### 融资信号

融资是正式评估的重点信息。报告必须展示最近一轮可获得的融资日期、融资类型或轮次、披露金额、投资方和来源；未披露的字段保持为空，不估算金额或估值。多轮融资按时间倒序保留为证据，最近融资优先进入一屏摘要。

融资信息用于增强以下判断：企业是否处于扩张阶段、是否具备预算能力、近期是否可能启动研发或数字化建设，以及是否存在上市、增发等采购时机。融资不能单独建立任何产品技术场景，不能单独证明采购意向，也不能仅凭融资把某项机会判为“高”。没有融资记录表示“未查到或未披露”，不作为负面证据；融资调用失败作为报告中的证据缺口，不影响已有证据形成报告。

### 产品场景与招聘信号

招聘信息对七个产品类别均为高价值信号，尤其是岗位名称、任职要求或项目描述中直接出现产品名、竞品名、相关工程方法或实施职责时。普通行政、销售和泛软件岗位不构成产品需求证据。

招聘采用双来源：

- 企查查 `qcc-operation` 的 `get_recruitment_info` 是结构化基础来源，采集发布日期、招聘职位、月薪、学历、经验和办公地点。
- 豆包搜索补充目标公司官网、公众号和招聘平台中的完整职位描述，重点检索 `Windchill`、`PLM`、`QMS`、`Creo`、`CATIA`、`Abaqus`、`CST`、`SolidWorks` 及相关工程方法。

企查查基础招聘记录不保证包含完整职位描述、招聘部门、招聘人数、招聘状态或原始招聘页面链接；缺少这些字段时不得由模型补写。豆包搜索补充内容也必须进入 `ResearchBundle`，经过主体归属和证据引用校验后才能用于判断。

| 产品 | 重点技术场景 | 高价值招聘信号 |
| --- | --- | --- |
| PTC Windchill | 多产品、多部门、BOM、变更管理、配置管理、PLM/ERP 协同 | Windchill/PLM 管理、PLM 实施、BOM/变更流程、PLM 管理员或实施顾问 |
| Feigenbaum QMS | ISO/IATF/AS9100 等体系、CAPA、供应商质量、审计和质量追溯 | QMS 负责人、质量数字化、CAPA/质量系统、供应商质量系统实施 |
| PTC Creo | 参数化机械设计、复杂零部件、工程变更及 PTC 生态 | Creo 设计、Creo 二次开发、Pro/E/Creo 工程师、参数化建模 |
| Dassault Systèmes CATIA | 汽车整车、航空航天、复杂曲面和大型装配 | CATIA 设计、曲面/装配工程师、航空航天或整车建模 |
| Dassault Systèmes Abaqus | 结构、非线性、碰撞、疲劳、材料和多物理场仿真 | Abaqus、有限元、非线性分析、碰撞/材料仿真工程师 |
| CST Studio Suite | 射频、天线、雷达、微波和 EMC/EMI 电磁仿真 | CST、HFSS/电磁仿真、天线、射频、EMC/EMI 工程师 |
| Dassault Systèmes SolidWorks | 中型制造企业、通用机械和设备设计 | SolidWorks、机械设计、设备设计、三维建模或 PDM 岗位 |

招聘证据的使用原则：

- 直接点名目标产品或对应工程技能：高权重，可显著提升机会判断
- 点名竞品或同类工具：作为生态/替换信号，不能直接认定采购目标产品
- 只出现“研发工程师”“质量工程师”“软件工程师”等泛岗位：低权重
- 招聘主体属于集团或子公司时，必须按证据归属规则处理
- 单条招聘信息不能单独证明采购意向；应结合主体归属、技术场景和其他来源
- 最近 12 个月发布的招聘可作为当前组织需求和采购时机信号；超过 12 个月的记录只用于说明历史软件生态，不得提升当前采购时机
- 没有查到招聘记录表示“招聘证据缺失”，不等于企业没有相关岗位，也不得仅据此降低机会等级

P1 行业：

- 机器人
- 电子高科技
- 新能源汽车三电
- 新能源装备

其他已列目标行业为 P2。

通信、射频、天线、雷达、芯片封装等企业即使属于 P2，也可以因明确的电磁仿真场景获得较高的 CST 机会判断。

### 四档机会规则

- **高**：具体产品技术场景明确；至少两个相互独立的可靠原始发布方支持；研发、质量或制造复杂度与该产品匹配；存在近期招聘、采购、扩产、融资或其他时机信号；预算和决策权不存在已知强阻碍。融资可以作为时机或预算证据，但不能替代产品场景证据。
- **中**：产品技术场景明确且有可靠来源支持，并有组织复杂度或软件生态证据；但缺少近期时机信号，或预算、决策权尚不清楚。
- **低**：主体和目标行业已确认，但只有行业匹配而没有产品场景；只有泛化的“数字化/智能制造”表述；研发或质量复杂度不足；或已有强替代系统且没有替换信号。P1/P2 和融资本身不能改变这一结论。
- **待核实**：法定主体未确认、简称证据无法归属、来源互相冲突，或关键结论只能依赖模型推断。

“相互独立”按原始发布方和域名判断，而不是按企查查或豆包搜索这两个获取通道判断；同一招聘信息被多个页面转载仍只算一个来源。

### 综合机会

综合机会取七项产品中最高的有效机会等级，最佳切入产品取最高等级中证据最充分、采购阻力最小的产品。若最高等级仅由单一弱来源、集团级证据或未确认的子公司/品牌证据支持，综合机会仍为“待核实”。

首版不输出 100 分和综合星级，避免未经校准的虚假精确度。

## 七、报告结构

报告控制为一屏摘要加证据附录。

### 客户摘要

- 法定主体
- 所属行业
- P1/P2 等级
- 企业规模线索
- 最近融资概况；未查到、未披露或来源失败时明确说明
- 最佳切入产品
- 综合机会：高/中/低/待核实
- 三条核心判断理由

### 七项产品机会

本节只在 `recommended_product` 非空时输出；为 `null` 时按前述降级规则省略整个产品矩阵。

| 产品 | 机会 | 依据 | 阻碍/缺口 |
| --- | --- | --- | --- |
| Windchill | 高/中/低/待核实 | 简短证据 | 待核实问题 |
| Feigenbaum QMS | 同上 | 同上 | 同上 |
| PTC Creo | 同上 | 同上 | 同上 |
| Dassault Systèmes CATIA | 同上 | 同上 | 同上 |
| Dassault Systèmes Abaqus | 同上 | 同上 | 同上 |
| CST Studio Suite | 同上 | 同上 | 同上 |
| Dassault Systèmes SolidWorks | 同上 | 同上 | 同上 |

### 关键证据

每项包括：

- 事实
- 网页提及名称
- 证据归属范围：法定主体、集团、子公司、品牌或未知
- 主体匹配等级及匹配依据
- 来源名称
- 来源链接
- 发布时间或采集时间
- 该证据支持的结论

本节的“事实”取自 `EvidenceFact.statement`，不是网页标题；一条事实引用多个来源时逐一展示每个来源。最近融资按结构化融资记录另列真实陈述。没有产品标签映射的事实只标注其真实用途（如风险、招聘、软件生态、组织复杂度），不得推断不存在的产品结论。

### 销售建议

- 建议切入产品
- 建议联系的岗位
- 首轮访谈问题
- 主要系统壁垒
- 下一步行动

### 风险与缺口

- 主体冲突
- 经营风险
- 来源冲突
- 信息时效
- 尚未核实的关键问题

禁止输出：

- 缺乏证据的高管人格判断
- 根据年龄推断决策风格
- 无正式数据支持的营收估算
- 将员工人数乘行业人效得到“真实营收”
- 没有来源支撑的采购意向

## 八、SQLite 仅保存

任务表只需要：

- `assessment_id`
- `requested_by`
- `legal_name`
- `credit_code`
- `status`
- `report_markdown`
- `recommended_product`
- `overall_opportunity`
- `source_status_json`
- `cache_key`
- `collected_at`
- `cached_at`
- `error_message`
- `created_at`
- `completed_at`

基础画像另存于 `company_profiles` 表，只保存清洗后的主体字段、统一社会信用代码、规范化法定名称和 `collected_at`，不保存上游原始响应。规范化法定名称使用普通索引；缓存读取仍遵守多候选不自动猜测主体的规则。`source_status_json` 只保存三个来源的最终状态和简短失败原因，不保存原始响应。`cache_key` 直接使用统一社会信用代码。建立 SQLite 部分唯一索引 `cache_key WHERE status='processing'`，保证单主体单进行中任务，同时允许保存同主体的历史完成报告。完成事务将 `cached_at` 与 `completed_at` 设为同一 UTC 时间；查找有效报告只比较 `completed_at`，任何读取都不得续期。不自动清理历史报告。

## 九、首版测试

只测试核心闭环，分为五组：

### 1. MCP 契约

- 配置加载先挑选声明键再做严格校验；包含 `PATH` 等额外进程键时可启动。缺失或非法的上游 URL、模型标识和凭证会阻止应用启动；错误信息和日志只列配置名称，不包含配置值。
- 本地 `.env` 可加载配置，`.env.example` 不包含真实凭证，`.env` 被 Git 忽略。
- 企查查 4 个 MCP Server 使用各自 URL 和共享 `QCC_API_KEY`；`history`、`executive`、`regulation`、`case`、`tender` 和 `document` 不会被调用。
- 豆包搜索只调用配置的 Custom 版 HTTP API，使用独立 Bearer API Key；不会启动或连接豆包搜索 MCP Server。
- 搜索请求固定为 `SearchType=web`、`NeedUrl=true`，并校验 Query 长度、Count 上限、招聘查询的 `NeedContent=true` 和 `TimeRange=OneYear`。
- 四个工具的输入、输出、有效和无效 Bearer Token。
- 四个工具输出严格匹配冻结字段；`cache_hit` 只允许出现在 `get_company_profile` 和 `submit_assessment`，报告输出拒绝该字段。
- HTTP 服务使用官方 v2 `createMcpHandler(factory)`，经 `toNodeHandler(handler)` 挂载到 `createMcpExpressApp`；后者只接收从完整 Origin 派生的 hostname 白名单。完整 Origin 精确校验 middleware 位于 Bearer 认证之前，Bearer 认证又位于 handler 之前；验证后的 `authInfo` 传入每请求 factory，由 `authInfo.clientId` 构造 caller services，不手工创建服务端 transport，也不新增安全模块。
- 模拟 MCP 客户端显式设置 `versionNegotiation: { mode: 'auto' }`，完成连接和四工具闭环后，`client.getProtocolEra()` 必须为 `modern`。
- `get_company_profile` 的企查查调用重试后仍失败时，返回 `source_status: "failed"` 和空候选，不返回泛化内部错误。
- 缺失字段、错误类型、超长字符串、非法信用代码、非法 UUID 和未知字段返回参数错误。
- Token CLI 创建、禁用和列表不泄露明文或哈希。
- 非法 `Host` 被拒绝。以允许值 `https://codex.example.cn:8443` 为例，完全相同的 Origin 可通过；错误 scheme `http://codex.example.cn:8443`、缺失/错误 port `https://codex.example.cn`、错误 hostname `https://evil.example.cn:8443` 均在认证前返回 403。无 `Origin` 的请求进入 Bearer 鉴权，有效客户端可调用。

### 2. 任务与缓存

- FIFO 按提交顺序运行，默认只执行一个评估；等待任务不调用上游。
- 同一主体的重复提交只保留一个 `processing` 任务。
- 30 天内重复查询画像和报告命中缓存；报告 TTL 仅从 `completed_at` 起算。已完成缓存的 `submit_assessment` 返回 `status: completed`、`cache_hit: true` 和 `cached_at=completed_at`；新建或复用进行中任务返回 `status: processing`、`cache_hit: false`；`force_refresh=true` 忽略已完成缓存，但不复制进行中任务。
- 超过 7 天的缓存报告显示动态信号时效提示。
- 进程重启后遗留 `processing` 任务变为 `failed`，已完成报告仍可读取。

### 3. 来源与错误

- 企查查和豆包搜索分别覆盖 `completed`、`partial`、`failed`。
- `retryOnce` 是所有上游请求的唯一重试入口；上游失败只重试一次，所有 attempt 计入分项和总调用预算，QCC transport error 关闭连接但当前 attempt 不内部重发，下一 attempt 才重连。
- 方舟超时、空响应、非法 JSON、悬空引用或结构校验失败，在一次重试后令任务 `failed`，只记录任务错误元数据，不创建 `ReportModel` 或正式报告；因此 `ReportModel.sourceStatus.ark` 只能是 `completed`。
- 豆包搜索 client 单次调用不接收预算且只发起一次请求；搜索预算耗尽由编排测试证明不会启动 client。
- 企查查和豆包搜索均失败、方舟可用时，任务 `completed`，七项均为“待核实”，`recommended_product` 为 `null`。
- SQLite 无法保存最终报告时任务 `failed`。

### 4. 证据与机会

- 简称可依据官方域名等身份要素归属；同名企业、集团和子公司证据不会错误归属。
- 方舟只能引用本次 `ResearchBundle` 中已有的证据 ID，且输出 `P1/P2/non_target/unverified` 行业分类。
- 相同 `EvidenceBundle` 产生相同七产品机会结果。
- 直接点名产品或工程技能的招聘信息按高权重处理；竞品和泛化岗位不会被误判为目标产品采购。
- `get_recruitment_info` 的基础字段可映射到 `ResearchBundle`；豆包搜索补充的完整职位描述必须通过主体归属和证据引用校验。
- 最近 12 个月招聘可影响当前机会判断；更早记录只影响历史软件生态；招聘缺失不会被解释为不存在需求。
- 正式评估优先调用 `get_financing_records`；融资记录映射日期、类型或轮次、披露金额和投资方，缺字段不补写，调用失败在报告中明确标注。
- 调用预算测试保证融资和招聘的首次调用先于其他企查查调用及重试，后续调用不得挤占这两个预留名额。
- 融资只能作为预算、扩张和采购时机证据，不能单独建立产品场景、证明采购意向或把机会提升为“高”。
- 报告的关键结论包含来源链接、时间和简短依据。

### 5. 真实端到端

- 该组明确延后到真实 `.env`、可访问的 HTTPS `/mcp` endpoint 和一家已授权企业同时到位后执行，不阻塞模拟闭环的实现完成。
- 使用一家已授权的真实企业完成主体画像、提交任务、状态轮询和 Markdown 报告读取；只接受最终状态为 `completed` 且可读取合格 Markdown 报告，任何 `failed` 都是本次验收失败，记录原因后修复并重新验收。
- 真实调用只验证技术链路，不作为销售价值、准确率、并发能力或 SLA 的证明。

## 十、延期内容

以下全部移至报告价值验证之后：

- PostgreSQL 与独立 Worker
- 更复杂的缓存预热、跨来源缓存协调和任务去重策略
- 限流与用户配额
- 跨用户报告隔离
- 原始响应长期保存
- 自动删除
- 详细成本面板
- 100 分制和星级
- 30 家企业盲评
- 并发与 SLA 测试
- 飞书集成
- Zoho CRM 集成
- 豆包搜索 MCP Server、Skill 或额外 Python 运行时
- 网页 UI

## 十一、安全边界确认

每用户 Token 只用于识别、记录和撤销，不阻止一个已认证用户读取另一个用户的报告。

如果不能接受这一边界，则后续必须增加最基本的“按提交用户校验报告归属”；这不需要扩展成完整的角色权限系统。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_open | HOLD SCOPE；10 项取舍已确认，3 项关键风险仍被接受 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | completed | 已完成架构与测试收敛，需随实现复核 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | 无网页 UI 范围 |

**UNRESOLVED:** 0 个未答复决策；主体错配、行业分类不确定、SQLite 升级和排队时间承诺为已知且已接受的风险。

**VERDICT:** 方案可作为“第一份报告”验证的最小实现，不适合作为可重复、可量化的销售决策系统。
