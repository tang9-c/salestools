# 目标客户体检 MCP v0.1

这是一个单进程、单实例的远程 MCP 服务。它先返回企业基础画像，再按需异步生成带可追溯来源的中文销售机会报告。只有真实 HTTP(S) 直接 URL 才渲染为链接；QCC 上游未提供直接 URL 时报告明确显示“来源链接不可用”。v0.1 使用 Node.js 24、TypeScript、SQLite、企查查 MCP、豆包搜索 HTTP API和火山方舟。

当前功能与产品边界见 [PRD](docs/PRD.md)；首次使用请阅读 [MCP 快速入门](docs/QUICKSTART.md)，其中包含 Codex 注册、Token 配置、原有五个工具及共享联系人图谱的使用路径。

## 本地运行

要求 Node.js 24 和 npm。复制配置模板后填写真实的上游凭据；不要提交 `.env`。

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

非生产运行会读取项目目录中的 `.env`；`NODE_ENV=production` 时只读取部署环境注入的变量。应用在私网 HTTP 端口监听，公网 HTTPS 必须由公司负载均衡或反向代理终止。

## 用户 Token

每个 `userId` 只有一个 Bearer Token，一个邮箱只对应一个人，每人只属于 `qx` 或 `st` 中的一个 CRM 组织。`tokens` 表同时保存邮箱、CRM 连接代号、实际组织 ID 和用户 ID；明文只在创建或重发时输出一次，服务端只保存 SHA-256 哈希。老用户可暂时未绑定。

Token 命令使用远程 CI 构建后的 `dist/cli/tokens.js`；生产镜像已包含该编译产物。本项目禁止本地构建。管理员创建时按指定组织中的邮箱匹配 CRM 用户，唯一匹配、有效且已确认才创建；查询失败不写入。

```bash
npm run tokens -- tokens:create --user sales-a --email sales-a@example.com --crm qx
npm run tokens -- tokens:update-identity --user sales-a --email sales-a@example.com --crm st
npm run tokens -- tokens:rotate --user sales-a
npm run tokens -- tokens:enable --user sales-a
npm run tokens -- tokens:list
npm run tokens -- tokens:disable --user sales-a
```

当前边界是：Token 用于验证、记录和撤销；任一有效 Token 在知道报告 UUID 后可以读取该报告，不做跨用户报告隔离。

Codex 客户端将 Token 保存在环境变量中，例如：

```bash
export SALESTOOLS_MCP_TOKEN='创建时返回的明文 Token'
codex mcp add salestools \
  --url https://mcp.example.cn/mcp \
  --bearer-token-env-var SALESTOOLS_MCP_TOKEN
```

## 五个 MCP 工具

- `get_company_profile`：默认用于“看一下”“了解基本情况”或意图不明确的请求；只查询基础画像。
- `discover_contacts`：默认从公开网页按企业关键词和可选地域查找关键岗位人员（最多 3 家、每家 10 人）；配置 Zoho 后可用 `source=zoho` 或 `source=all` 实时读取 CRM 客户及全部已取得的关联联系人。
- `submit_assessment`：仅在用户确认法定名称和统一社会信用代码，并明确要求正式销售评估后调用。
- `get_assessment_status`：轮询 `processing`、`completed` 或 `failed`。
- `get_assessment_report`：读取完成后的 Markdown 报告，或返回当前处理/失败状态。

公开网页发现工具已由 `get_contacts` 改名为 `discover_contacts`，不保留旧工具别名。升级后请重新加载 MCP 工具列表，并更新脚本中的调用名称；输入、输出、缓存和快照同步行为不变。图谱搜索仍使用 `search_contacts`，单个档案读取仍使用 `get_contact`。

### Zoho CRM 只读联系人来源（可选）

在服务端环境中设置 `ZOHO_CONNECTIONS=crm_a,crm_b`，通过 `ZOHO_CRM_A_NAME=QX`、`ZOHO_CRM_B_NAME=ST` 指定组织；分别配置各连接的 `REGION`、`CLIENT_ID`、`CLIENT_SECRET` 和 `REFRESH_TOKEN`。首次绑定时自动从 Zoho 读取组织 ID 并保存到 `tokens.crm_org_id`，以后与保存的 ID 核验，无需手填组织 ID。用户绑定将 `NAME` 去除首尾空白、转为小写后匹配 `--crm qx`／`--crm st`，不按连接 ID 或其他字段匹配。QX／ST 名称重复会导致启动失败。连接 ID 使用小写 ASCII 字母、数字、下划线且以字母开头；区域为 `CN/US/EU/IN/AU/CA`，目前只连接生产环境。未配置时网页路径照常运行，Zoho 查询会明确返回不可用。Sealos 部署时注入同名服务端环境变量；不要将真实 `.env` 放入 Git、构建上下文或镜像。

`discover_contacts` 新增 `source=web|zoho|all`（默认 `web`）、可选 `zoho_accounts` 连接 ID 数组和 `zoho_account_records` 客户记录选择数组。未知连接是输入错误。CRM 客户名称搜索可能包含匹配；有候选需先核对，再用候选的 `connection_id` 与 `account_id` 重新调用。简称不属于全名子串时，将实际候选全名作为 `query` 重新提交。选定记录会重新核验，随后连续读取其关联联系人；Zoho 不受网页每家公司 10 人上限约束。`source=all` 将两种来源分别返回，不合并同名人员。网页结果保留原 `companies/warnings/collected_at`，CRM 结果在独立 `zoho` 区域；Zoho/all 的文本响应按公司列出所有已取得联系人，结构化响应保留连接和记录 ID。`status`、`complete`、`warnings` 必须一起阅读：`partial` 或 `failed` 不能当作全量，`needs_confirmation` 尚未开始联系人全量读取；120 秒同步期限内无法完成的超大客户也会如实标记。

只请求客户和联系人姓名、职位、两类 CRM 记录负责人、修改时间及来源 ID，不请求电话、邮箱、备注、附件或其他关联资料；Owner 表示 CRM 内部记录归属，不代表客户企业所有者或人员上级。所有有效 MCP 用户共享已配置连接及该账号在 CRM 中的可见范围；这里不按销售用户隔离 Zoho 权限。已绑定用户经实际组织核验后，Owner 增加 `is_current_user=true|false|null`（未知为 null），分别判断客户和联系人负责人；这是每次请求的投影，不持久化到共享图谱。Zoho 实时只读，不写 CRM 或网页快照。

启用 `CONTACT_GRAPH_ENABLED` 后，已取得的 Zoho 客户和联系人会在查询后自动同步到共享联系人图谱；无需另行上传。关闭开关、待确认、失败及无客户结果不触发同步，partial 只同步实际取得的记录。连接 ID 必须长期稳定：身份按连接、模块和记录 ID 定位，同名或跨连接记录不自动合并；`get_contact` 的结构化来源详情保留这三个定位值，不构造 CRM 链接，图谱 App 继续展示关系和任职状态。重复查询不增加节点、关系、证据或内容版本。任职关系为 `employment_status=unknown`，不能称为现任。归档记录不会自动恢复，关联部分跳过时明确提示。CRM `status/complete` 仍表示查询完整性；图谱计数、失败、超时、超大记录和索引调度警告独立显示（部分为 `ZOHO_GRAPH_SYNC_PARTIAL`，全部未确认同步为 `ZOHO_GRAPH_SYNC_FAILED`），不能据 CRM 查询成功推断全部已入库。每批完整 UTF-8 请求帧最多 256 KiB，单条过大仍保留 CRM 结果，其他可处理记录继续同步；每批和索引回读各限时 30 秒。成功的实质 Person 内容变化复用已有向量索引器，只有负责人变化不触发索引。图谱、App、容器端到端验证使用远程只读 CI 的合成数据，真实 CRM 和宿主验收仍待授权。

首次授权由对应 CRM 授权人员在所在区域的 Zoho API Console 创建 Self Client，选择目标组织和生产环境，申请最小只读 scopes：`ZohoCRM.modules.accounts.READ`、`ZohoCRM.modules.contacts.READ`、`ZohoSearch.securesearch.READ`、`ZohoCRM.settings.fields.READ`、`ZohoCRM.settings.modules.READ`、`ZohoCRM.settings.related_lists.READ`。保持 SDK 的 findUser 关闭；用户匹配和组织核验另需 `ZohoCRM.users.READ`、`ZohoCRM.org.READ`，需重新授权，不能仅修改 scope 文本。仍不申请 `settings.ALL` 或写权限。Users API 返回字段较多，适配器仅投影用户 ID、邮箱、状态和确认标志，不保存其他字段或原始响应。生成短期授权码后，在有效期内用对应区域的 Accounts Token endpoint，以 POST 请求体交换 Refresh Token；凭证不放入 URL、终端命令历史、聊天或日志。仅把 Client ID、Client Secret、Refresh Token 放入服务端配置，授权码不作为运行配置。SDK 按需刷新 Access Token 并只在内存保存；授权被撤销或 Refresh Token 失效时，需由授权人员重新授权、更新环境并重启。外部客户自有 CRM 应另行采用 Server-based OAuth 流程，不要求客户交付 Refresh Token。

锁定的 Zoho SDK 在 `npm ci` 的 `postinstall` 中应用经校验的最小补丁；使用 `--ignore-scripts` 安装后需显式执行 `npm run postinstall`。已配置连接在创建适配器前检查安装字节，校验失败仅禁用 Zoho，不中断网页来源。SDK 元数据写入系统临时目录中的独立连接目录，权限为 0700；不存 Token 或联系人数据，应用关闭时等待在途操作并清理。临时目录不可写会令 Zoho 查询返回不可用。首次 SDK 元数据初始化需要上述三个 settings 只读 scope。真实 CRM 字段权限、远程 CI 与 MCP 宿主大响应容量尚需获授权后验收。

## 共享联系人图谱（可选）

启用图谱后，`search_contacts` 附带只读“联系人图谱”MCP App。支持的宿主展开 App 后，会逐步显示当前搜索页所有命中节点的全部一跳职业关系（含入向与出向），自动读完关系分页并补齐端点名称；不递归展开补充节点。点击查看详情和来源，加载可停止、继续或重试。只有原查询显式包含 `include_unverified:true` 时才绘制待核实虚线；接口仅覆盖命中主体自身的 claim，不包括反向 claim 查询。正式边不等于人工核实，未知任职不显示为现任。JSON 返回保持不变；无 App 支持时继续在聊天读取结果。没有图谱备用网页查询入口。

`CONTACT_GRAPH_ENABLED` 默认 `false`。开启后，服务使用独立的 `/data/contact-graph.sqlite` 保存 `Person`、`Organization`、字段证据和关系；原有 `discover_contacts` 仍按企业关键词搜索公开网页，不等同于 `search_contacts` 查询共享图谱。镜像内已包含锁定依赖的 Docling OCR worker 与 Rust `contact-graph` worker；同一 `/data` 卷应保留主库和图谱库。

开启时设置 `CONTACT_GRAPH_ENABLED=true`，并保持 `CONTACT_GRAPH_SQLITE_PATH` 与 `SQLITE_PATH` 不同。若容器的 `--env-file` 基于 `.env.example`，必须把其中的相对路径和占位路径改为 `SQLITE_PATH=/data/salestools.sqlite`、`CONTACT_GRAPH_SQLITE_PATH=/data/contact-graph.sqlite`、`CONTACT_GRAPH_BIN=/usr/local/bin/contact-graph`、`CONTACT_PYTHON_BIN=/opt/contact-worker/.venv/bin/python`；环境文件会覆盖镜像默认值。本地源码运行则先执行 `cargo build --locked --release --manifest-path rust/contact-graph/Cargo.toml` 和 `uv sync --project python --locked`，再在 `.env` 中填写绝对路径。语义检索可选，需要分别设置 `ARK_EMBEDDING_API_URL`、`ARK_EMBEDDING_MODEL`、`ARK_EMBEDDING_CREDENTIAL`；它们与用于抽取/问答的方舟配置相互独立，未配置时仍可使用关键词检索。

当前 Feigenbaum 网关的 `doubao-embedding-vision-251215` 已实测使用 `ARK_EMBEDDING_API_URL=https://aigw.feigenbaum.com.cn/v1/embeddings`、`ARK_EMBEDDING_MODEL=doubao-embedding-vision-251215`。别名 `embedding-vision` 也可用；网关会在响应中给出实际版本，客户端以实际版本标识向量索引。长期保存的向量建议配置固定版本，避免别名指向变化后新旧向量混用。该模型要求 `input: [{"type":"text","text":"..."}]`，结果位于 `data.embedding`；客户端会按模型名使用此格式，普通文本向量模型继续使用标准 Embeddings 格式。参见[火山方舟多模态向量化文档](https://docs.volcengine.com/docs/ark/vectorization?lang=zh)。

新工具包括 `get_contact`、`save_contact`、`merge_contacts`、`delete_contact`、`save_contact_relation`、`delete_contact_relation`、`search_contacts`、`ask_contacts`、`import_contacts`、`get_contact_import`、`commit_contact_import` 和 `cancel_contact_import`。配置好向量端点时还提供 `retry_contact_index`，仅用于重试当前版本的失败索引。保存、合并、删除和导入提交需要由用户核对候选、证据及版本；相同手机号只是可能同人的线索，不自动合并。文件上传先调用 `/contact-files`，之后通过 `import_contacts` 获取预览，再选择创建、合并或跳过并提交；上传本身不会创建联系人。每文件最多 20 MB、PDF 最多 50 页，默认最多保留 10 个待处理文件；这些上限可通过 `.env.example` 的 `CONTACT_MAX_*` 和 `CONTACT_IMPORT_*` 项调整。

已有公开网页联系人快照可先查看数量，再在停服维护窗口完成带备份的首次同步：

```bash
npm run contacts:sync -- --dry-run
npm run contacts:sync -- --backup /data/salestools-before-contact-sync.sqlite
```

第二条要求图谱功能已开启，备份目的路径为尚不存在的绝对 `.sqlite` 文件。CLI 会校验备份完整性后同步快照；再次运行会从图谱游标继续。服务启动后也会同步后续快照。导入中的临时上传文件不跨进程保留：重启后未完成任务标记失败，用户需重新上传并导入；已经提交的图谱事实不会回滚。

基础画像和正式报告默认各复用 30 天，由 `PROFILE_CACHE_TTL_DAYS`、`ASSESSMENT_CACHE_TTL_DAYS` 调整。`force_refresh=true` 忽略已完成报告缓存，但不会复制正在处理的任务。`cache_hit` 只出现在画像和提交结果；状态与报告结果不包含缓存字段。

`discover_contacts` 固定执行两类豆包宽查询：一类覆盖企业官网、官方新闻、公众号和会议嘉宾，另一类覆盖招投标、专利以及研发、技术、信息化、采购和质量负责人。结果只保留页面明确出现的姓名、职位、原始 URL 和发布日期；不返回或推测邮箱、电话等直接联系方式。无明确职位的专利发明人或招投标联系人不会返回。候选来源由服务端根据页面内容、域名和豆包返回的发布者元数据作启发式筛选，而不是信任模型分类；官方新闻还要求域名和发布者同时命中服务端允许列表。由于该工具不调用企查查或其他权威主体库，该筛选可能误判，也不构成官网域名所有权或法人主体认证。

联系人查询按 NFKC、空白和英文大小写规范化后的企业关键词与地域建立全局缓存；同一缓存键 30 天内不会重复调用豆包或方舟，不同地域相互隔离，企业简称、全称和别名不会自动归并。每次正常查询结果（包括空结果或部分搜索失败结果）都会永久追加为快照。`contacts` 返回最新快照中的当前候选联系人，`historical_contacts` 返回旧快照曾出现但最新快照未出现的任职证据；历史证据不代表已离职或已经卸任。过期刷新失败且存在旧快照时会返回旧快照并在 `warnings` 中提示；没有旧快照、全部搜索失败或方舟抽取失败时返回工具错误。部分搜索失败，或部分页面、正文因方舟输入容量限制未进入抽取时，会返回已有结果并在 `warnings` 中说明。

企查查或豆包搜索单一来源失败时，报告继续生成并将该来源标为 `partial` 或 `failed`；两者都失败时，已完成的降级报告仍包含完整七产品矩阵，各项标为 `待核实`，并列出来源和证据缺口。方舟按批次整理证据，每批可重试失败最多尝试两次；单批失败会继续后续批次并将方舟标为 `partial`，所有批次均失败时整个任务才为 `failed`。`INPUT_TOO_LARGE` 等确定性失败在首次尝试后不会重试。融资和招聘是企查查正式评估的前两项采集任务；融资失败会在报告中明确列为缺口。QCC 缺少上游直接 URL 不等于来源失败，但会产生来源链接缺口；工具目录和猜测的公司页面不会计入链接覆盖。

## Ark 证据预算与决策审计

`ARK_REQUEST_MAX_BYTES` 默认 `12288`，限制包含系统提示词和请求信封在内的每个完整 UTF-8 请求。服务按实际剩余字节动态装载证据，不使用固定条数：先尽力覆盖 `industry`、`technology`、`timing`、`capacity` 四类，再按稳定优先级填充；内容过大时先缩短摘要/正文。装满一批后继续处理剩余材料，最多执行 `MAX_ARK_BATCHES` 批（默认 `8`）。达到批次上限仍未装入的材料会计入容量缺口，不会被描述为不存在。

`MAX_ARK_CALLS` 默认 `16`，统计 HTTP 尝试次数而不是批次数，因此可覆盖 8 批各一次重试；`MAX_TOTAL_UPSTREAM_CALLS` 默认 `32`，必须至少覆盖 QCC、搜索和 Ark 三项上限之和。主动下调 Ark 或总调用上限可能得到 `ark=partial` 的报告。各批次在发送前都会按最终模型名称和请求信封重新核对字节数。

`submit_assessment` 对新任务返回 `estimated_minutes=5-40`。这是基于真实串行分批运行修正后的经验区间，不是 SLA，也不包含队列等待；批次越多、模型端点越慢，越接近区间上沿。

每份已完成报告都显示客户摘要、完整七产品机会矩阵、关键证据、销售建议（无推荐时显示“暂不推荐”）、风险与分层缺口以及来源状态。`recommended_product` 为 `null` 不会隐藏这七项判断。

SQLite 的 `assessments.result_json` 只保存可审计的派生结果：有证据支持的自由文本行业标签及其证据 ID、七项产品机会等级与证据 ID、入选证据 ID，以及原始、去重、已处理、未处理、批次成功/失败数量和各批字节数汇总。行业标签只用于报告展示，不参与机会等级、推荐产品或置信度。`recommended_product` 与 `overall_opportunity` 仍分别保存于 `assessments` 的独立列，不属于 `result_json`。`result_json` 不保存研究正文、网页正文、原始上游响应或凭据；MCP 响应仍保持既有精简契约。

## 部署

构建并运行单实例容器：

```bash
docker build -t salestools-mcp:v0.1 .
docker run --rm -p 3000:3000 \
  --env-file /secure/path/salestools.env \
  -v salestools-data:/data \
  salestools-mcp:v0.1
```

镜像使用非 root 用户，SQLite 固定写入挂载的 `/data/salestools.sqlite`，可选图谱写入同卷的 `/data/contact-graph.sqlite`；镜像中不包含 `.env`。运行前可用 `docker run --rm salestools-mcp:v0.1 /opt/contact-worker/.venv/bin/python /usr/local/bin/contact-runtime-smoke.py` 验证真实 Docling OCR 和 Rust 图谱临时读写。发布 workflow 仅构建并 smoke `linux/amd64`，通过后推送 GHCR，并更新版本标签和 `latest`；新发布的镜像面向 Sealos 的 x86_64 节点，不提供原生 ARM64 镜像。SQLite 是单副本、单进程队列设计：一个数据库文件只能由一个服务副本拥有；不要运行多个副本共享同一个 SQLite 文件。如需横向扩展，必须先迁移到具备并发协调能力的存储和队列方案。

反向代理必须：

- 对外只提供 HTTPS `/mcp`，并把应用保留在私网。
- 转发与 `PUBLIC_MCP_HOST` 完全一致的 Host。
- 只允许 `ALLOWED_ORIGINS` 中完整匹配的 HTTPS Origin；无 Origin 的非浏览器客户端仍必须携带 Bearer Token。
- 将 `GET /healthz` 限制为内部负载均衡访问；它只返回 `{"status":"ok"}`。

收到 SIGTERM 或 SIGINT 后，应用停止接收新任务并关闭监听；当前任务和在途 MCP 请求最多等待 30 秒。超时后会取消在途上游请求，等待业务 Promise 收敛并将当前任务标为 `failed`，然后才关闭 SQLite；排队任务不会继续执行。进程重启时，遗留的 `processing` 任务会标为 `failed`，用户可重新提交。

## 验证状态

模拟 MCP HTTP 闭环由测试覆盖，包括 SDK v2 modern 协商、画像、提交、轮询、报告、缓存字段和跨 Token 读取。生产与常规 Task 11 验收仍要求未提交的 `.env` 中具备真实凭据、HTTPS endpoint 可访问且企业已获授权。

2026-08-30 用户明确批准了仅限 Task 11 的本地 `127.0.0.1` HTTP 技术链路例外。修复真实数据暴露的 Ark 输入预算问题后，使用全新临时 SQLite 的单次正式提交在 491 秒内完成。QCC 为 `partial`，豆包搜索和 Ark 为 `completed`；部分关键证据缺少直链，已明确标记而没有伪造 URL。详见 `docs/validation/real-e2e-result.md`。该例外没有验证 TLS、反向代理、生产 Host 或生产 Origin，也不改变上面的生产 HTTPS 要求。

```bash
npm test
npm run typecheck
npm run build
```

## 远程 Token 管理

可通过独立管理 API 和本机单文件 CLI 创建、更新身份、重发、启用、分页查看和禁用 Token，无需进入容器。首次启用、权限、结果未知处理及回滚见 [操作说明](docs/operations/token-admin.md)。默认未配置管理员摘要时 API 关闭；原容器 CLI 仍可使用。

使用 Node 24，将命令指向当前版本的脚本（替换为你的实际绝对路径）：

```bash
alias salestools-admin='node /absolute/path/salestools/tools/salestools-admin.mjs'
salestools-admin --help

# 创建用户：指定唯一邮箱和所属 CRM 组织（qx 或 st）
salestools-admin token create sales-a --email a@example.com --crm qx

# 给已有用户补充或修改 CRM 身份，保留现有 Token
salestools-admin token update-identity sales-a --email a@example.com --crm st

# 重发 Token：旧 Token 立即失效，保留身份及启用状态
salestools-admin token rotate sales-a

# 启用、禁用和查看用户
salestools-admin token enable sales-a
salestools-admin token disable sales-a --all
salestools-admin token list
salestools-admin token list --limit 100 --offset 100
```

新命令需要配套服务端版本及 CRM 配置。已有管理员配置可继续使用，无需重新运行 `setup`；另存的旧脚本需手动更新。创建和重发只输出一次 Token 明文，请妥善保存；请求结果未知时先核对列表和审计，不要盲目重试。

已有 `crm_a`／`crm_b` 连接应保留原 ID，直接使用 `ZOHO_CRM_A_NAME=QX`、`ZOHO_CRM_B_NAME=ST` 匹配组织；组织 ID 在首次绑定时自动读取并保存，具体配置见 [CRM 配置说明](docs/operations/token-admin.md#crm-连接与权限)。`503 CRM_ORG_NOT_CONFIGURED` 表示所选组织未配置，创建尚未写入；CLI 会显示错误码和 requestId。

首次升级前使用 `tools/token-migration.mjs preflight` 检查重复用户；有重复时需停服、备份并明确选择保留记录，启动不会自动撤销旧 Token。具体步骤见 [Token 管理与迁移](docs/operations/token-admin.md)。

### 持续企业研究（第一阶段，默认关闭）

`COMPANY_RESEARCH_ENABLED=false` 为默认值。启用后提供首次研究、继续、刷新、状态、共享版本及分页证据读取，使用已确认企业画像和独立预算。失败／取消保留旧成果；重启不自动恢复付费调用。关闭功能保留研究数据。

当前实现尚待远程完整 gate、授权企业样本和真实宿主验收；启用须在验收后另行授权。数据库备份、迁移、预算、状态、关闭步骤及真实 tested SHA 记录见[持续企业研究验收记录](docs/validation/2026-10-17-continuous-company-research.md)。不在本机执行 build/dev/native 或容器构建。
