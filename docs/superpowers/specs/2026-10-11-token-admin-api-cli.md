# Token 管理 API 与本机 CLI 设计

## 目标和范围

管理员在本机运行一个 Node 24 单文件 CLI，通过现有 HTTPS 域名创建、分页查看、按用户禁用 MCP Token，不需要 kubeconfig 或容器 exec。第一版只有一个运维管理员身份，不新增网页、管理 MCP、OAuth、RBAC、数据库迁移或依赖。保留现有容器 CLI 作为紧急恢复入口。

当前 tokens 表以 token_hash 为主键；同一用户可以有多枚 Token，disableByUserId 会禁用该用户全部启用 Token。新 API 保持这个行为。Token 没有有效期，禁用前持续有效。新建 Token 不撤销旧 Token。

## 认证与启停

服务端仅新增可选环境变量 TOKEN_ADMIN_KEY_SHA256：64 位小写十六进制 SHA-256；缺省或空白表示管理 API 关闭，所有 /admin 路径返回 404，业务服务照常运行；非空错误格式启动失败。不通过普通 MCP Token 校验器认证管理员。

CLI setup 在本机使用 crypto.randomBytes(32) 生成管理员密钥，写入本机配置（不输出明文），仅显示其 SHA-256。管理员将摘要通过 Sealos 配置界面注入主服务的 Secret 引用/环境配置。Worker 不注入此配置。服务器对 Bearer 明文进行 SHA-256，固定长度后 timingSafeEqual 比较。管理员密钥不写入 tokens 表，因此不能直接用来访问 /mcp。

所有管理响应 Cache-Control: no-store。只接收 Authorization: Bearer，不接受 Cookie、query 或正文凭据；不开放 CORS，并拒绝带 Origin 的管理请求（第一版仅 CLI）。复用 PUBLIC_MCP_HOST 的精确 Host 校验。CLI 强制 HTTPS、拒绝 URL 用户密码/query/hash/非根路径、不跟随重定向，不支持跳过 TLS 验证。代理只负责 TLS 终止；应用不盲信 X-Forwarded-For。

两层进程内限流：认证失败尝试全局每分钟 120 次，认证后的操作每分钟 30 次，固定窗口、常量空间，不建 IP 字典；超限 429 + Retry-After。合法凭据独立使用操作预算，不因认证失败预算耗尽被阻断。失败计数饱和到121，汇总不代表精确攻击次数。业务接口不受管理预算影响。多副本不提供全局精确配额；服务入口仍可配平台限流，本方案不新增 Redis。

## HTTP 契约

统一前缀 /admin/v1。响应都带服务端生成的 UUID requestId；不接收客户端日志字段。错误形状 {error:{code},requestId}，不回显异常、Authorization 或请求正文。认证在 JSON 解析前执行；JSON 上限 2 KiB，仅 application/json，拒绝压缩请求正文，schema.strict 拒绝额外字段。

| 方法/路径 | 参数 | 成功响应 |
| --- | --- | --- |
| POST /admin/v1/tokens | {userId:string} | 201 {userId,token,requestId} |
| GET /admin/v1/tokens | ?limit=100&offset=0 | 200 {items:[{userId,enabled,createdAt}],nextOffset:number或null,requestId} |
| POST /admin/v1/tokens/disable-user | {userId:string} | 200 {userId,disabled:boolean,requestId} |

userId 为原值：1–128 字符、首尾不得有空白、禁止 Unicode 控制字符，允许中文与现有常见 ID；不静默 trim 或更改身份。分页 limit 1–100（默认 100），offset 为非负安全整数；仅允许这两个 query 参数且不允许重复。按 created_at、user_id、token_hash 排序，SQL 读取 limit+1 决定 nextOffset，不返回 hash；offset 分页不是变更期间的快照。

重复禁用返回 disabled=false，不报错。disable-user 立即影响后续 Token 校验；不承诺取消已经执行中的请求。现有上传会话每次授权会检查源 Token 状态，需回归验证该行为。

错误码：401 ADMIN_UNAUTHORIZED；403 ADMIN_ORIGIN_DENIED / ADMIN_HOST_DENIED；400 INVALID_ADMIN_REQUEST；413 ADMIN_BODY_TOO_LARGE；415 ADMIN_CONTENT_TYPE_UNSUPPORTED；429 ADMIN_RATE_LIMITED；500 ADMIN_OPERATION_FAILED。未知路由 404。日志输出失败不改变已经完成的业务写入结果，不输出原异常。

## 创建重试与丢失回执

第一版创建是非幂等操作，无任何隐式重试。服务器仍使用现有 TokenService.create 的 randomBytes(32)，只保存 hash。CLI 网络超时、连接中断、意外响应及写操作 5xx 统一给出“结果未知，请勿盲目重复创建”，退出码 3，并打印已知 requestId；不声称创建未发生。不能恢复丢失的 Token 明文。

管理员可以用 list 和审计记录核对创建情况。若需清除不确定新 Token，当前只能按用户禁用全部再创建，会撤销该用户已有 Token，必须由管理员明确执行 disable --all。CLI 不自动禁用/轮换。需要单枚撤销或可靠重放时再单独设计 token_id/幂等存储，不在首版暗中扩展数据库。

## CLI 交互及配置

文件 tools/salestools-admin.mjs：Node 24、标准库 crypto/fs/os/path/readline、原生 fetch，不依赖项目 node_modules，不依赖本地构建或服务端数据库。通过 shell alias `salestools-admin='node /absolute/path/tools/salestools-admin.mjs'` 使用；第一版从代码仓库获取同版本脚本，不做安装器。

```sh
salestools-admin setup --url https://oojyeijszmwy.sealosbja.site
salestools-admin token create sales-a
salestools-admin token list
salestools-admin token list --offset 100 --limit 100
salestools-admin token disable sales-a --all
```

默认配置 ~/.config/salestools/admin.json，目录 0700、文件 0600；{version:1,url,adminKey}。拒绝符号链接配置和宽松文件权限；setup 使用独占创建，已有配置则退出，不覆盖密钥。默认面向 macOS/Linux，不承诺 Windows 权限模型。

setup 只做本地生成和保存，不自动调用 API或修改集群；输出摘要和 Sealos 配置步骤。其成功不等于服务端已启用。显式管理密钥轮换：将旧配置移至权限0600的备份后执行setup生成新配置、更新服务器摘要并完成滚动更新、验证 list，最后替换本机配置。滚动更新期间可能出现新旧摘要混用；失败时保留旧配置用于回滚。首版不新增自动轮换命令。

create 成功 stdout 仅输出新业务 Token，stderr 提示保存；list stdout 输出 JSON；disable stdout 输出 JSON。所有错误在 stderr，不转储服务端响应原文、fetch 异常或配置。缺少 --all 时禁用不发送请求，说明会禁用该用户所有 Token。所有请求 15 秒超时，redirect:error，无自动重试。退出码 0 成功；2 参数/配置错误；1 明确 HTTP 拒绝；3 写操作结果未知。stdout 写出失败不得报告正常完成。

## 审计

复用 JsonlLogger 输出 admin_token_operation：timestamp、requestId、固定 actor=token-admin、action=create/list/disable、校验后的 userId（如适用）、outcome、httpStatus。禁用保留 disabled 布尔结果；列举不记录整页内容。所有凭据、摘要、请求正文与 Token 明文禁止记录。认证失败只记固定类别，按窗口汇总以免放大日志。共享密钥只能定位到该管理身份，不能区分实际操作者；需要多人管理时再升级身份模型。

## 验收与发布

禁止本地构建，包括间接构建。允许解释器测试、tsc --noEmit、node --check 和 diff 检查。实际构建及包含 native/full-suite 的 gate 在远程 CI。使用合成用户、内存/临时数据库、临时管理员密钥，CI 不读生产 Secret。

首次部署默认不设置摘要，先确认业务兼容，再在 Sealos 启用。真实验收仅创建专用测试用户 Token，验证 MCP 初始化、列表无明文、禁用后新请求拒绝；不碰现有用户。回滚关闭摘要使 /admin 返回404，已创建业务 Token 不自动失效，必须提前显式禁用不需要的测试用户。保留旧容器 CLI。
