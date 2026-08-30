# 目标客户体检 MCP v0.1

这是一个单进程、单实例的远程 MCP 服务。它先返回企业基础画像，再按需异步生成包含来源链接的中文销售机会报告。v0.1 使用 Node.js 24、TypeScript、SQLite、企查查 MCP、豆包搜索 HTTP API和火山方舟。

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

## 四个 MCP 工具

- `get_company_profile`：默认用于“看一下”“了解基本情况”或意图不明确的请求；只查询基础画像。
- `submit_assessment`：仅在用户确认法定名称和统一社会信用代码，并明确要求正式销售评估后调用。
- `get_assessment_status`：轮询 `processing`、`completed` 或 `failed`。
- `get_assessment_report`：读取完成后的 Markdown 报告，或返回当前处理/失败状态。

基础画像和正式报告默认各复用 30 天，由 `PROFILE_CACHE_TTL_DAYS`、`ASSESSMENT_CACHE_TTL_DAYS` 调整。`force_refresh=true` 忽略已完成报告缓存，但不会复制正在处理的任务。`cache_hit` 只出现在画像和提交结果；状态与报告结果不包含缓存字段。

企查查或豆包搜索单一来源失败时，报告继续生成并将该来源标为 `partial` 或 `failed`；两者都失败时仍可生成仅含证据缺口的报告。方舟事实整理连续两次失败时，整个任务为 `failed`。融资和招聘是企查查正式评估的前两项采集任务；融资失败会在报告中明确列为缺口。

## 部署

构建并运行单实例容器：

```bash
docker build -t salestools-mcp:v0.1 .
docker run --rm -p 3000:3000 \
  --env-file /secure/path/salestools.env \
  -v salestools-data:/data \
  salestools-mcp:v0.1
```

镜像使用非 root 用户，SQLite 固定写入挂载的 `/data/salestools.sqlite`，镜像中不包含 `.env`。不要运行多个副本共享同一个 SQLite 文件。

反向代理必须：

- 对外只提供 HTTPS `/mcp`，并把应用保留在私网。
- 转发与 `PUBLIC_MCP_HOST` 完全一致的 Host。
- 只允许 `ALLOWED_ORIGINS` 中完整匹配的 HTTPS Origin；无 Origin 的非浏览器客户端仍必须携带 Bearer Token。
- 将 `GET /healthz` 限制为内部负载均衡访问；它只返回 `{"status":"ok"}`。

收到 SIGTERM 或 SIGINT 后，应用停止接收新任务并关闭监听；当前任务最多等待 30 秒，排队任务不会继续执行。进程重启时，遗留的 `processing` 任务会标为 `failed`，用户可重新提交。

## 验证状态

模拟 MCP HTTP 闭环由测试覆盖，包括 SDK v2 modern 协商、画像、提交、轮询、报告、缓存字段和跨 Token 读取。真实企查查、豆包搜索和方舟调用属于 Task 11；只有未提交的 `.env` 中具备真实凭据、HTTPS endpoint 可访问且企业已获授权后才执行。

```bash
npm test
npm run typecheck
npm run build
```
