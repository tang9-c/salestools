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

每位用户使用独立 Bearer Token。明文只在创建时输出一次，服务端 SQLite 只保存 SHA-256 哈希。

Token 命令使用构建后的 `dist/cli/tokens.js`，执行前先运行 `npm run build`；生产镜像已包含该编译产物，不依赖开发依赖 `tsx`。

```bash
npm run tokens -- tokens:create --user sales-a
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
- `discover_contacts`：按企业关键词和可选地域，从公开网页中同步查找企业负责人、研发/技术、数字化/IT、采购和质量负责人；最多返回 3 家企业、每家 10 人。
- `submit_assessment`：仅在用户确认法定名称和统一社会信用代码，并明确要求正式销售评估后调用。
- `get_assessment_status`：轮询 `processing`、`completed` 或 `failed`。
- `get_assessment_report`：读取完成后的 Markdown 报告，或返回当前处理/失败状态。

公开网页发现工具已由 `get_contacts` 改名为 `discover_contacts`，不保留旧工具别名。升级后请重新加载 MCP 工具列表，并更新脚本中的调用名称；输入、输出、缓存和快照同步行为不变。图谱搜索仍使用 `search_contacts`，单个档案读取仍使用 `get_contact`。

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

镜像使用非 root 用户，SQLite 固定写入挂载的 `/data/salestools.sqlite`，可选图谱写入同卷的 `/data/contact-graph.sqlite`；镜像中不包含 `.env`。运行前可用 `docker run --rm salestools-mcp:v0.1 /opt/contact-worker/.venv/bin/python /usr/local/bin/contact-runtime-smoke.py` 验证真实 Docling OCR 和 Rust 图谱临时读写。发布 workflow 在推送 GHCR 前分别构建并 smoke `linux/amd64`、`linux/arm64`。SQLite 是单副本、单进程队列设计：一个数据库文件只能由一个服务副本拥有；不要运行多个副本共享同一个 SQLite 文件。如需横向扩展，必须先迁移到具备并发协调能力的存储和队列方案。

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
