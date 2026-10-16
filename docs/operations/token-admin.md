# 远程管理 MCP Token

管理员使用本机 Node 24（macOS/Linux）和 `tools/salestools-admin.mjs`，通过 HTTPS 管理 Token，无需 kubeconfig。首次启用仍需在 Sealos 主服务配置一次管理员摘要。

## 首次启用

从与服务端匹配的版本取得脚本，定义本机命令（路径替换为你的实际文件）：

```sh
alias salestools-admin='node /absolute/path/tools/salestools-admin.mjs'
salestools-admin --help
salestools-admin setup --url https://oojyeijszmwy.sealosbja.site
```

setup 生成随机管理员密钥，写入 `~/.config/salestools/admin.json`（文件0600、所属目录0700）。输出的是 SHA-256 摘要，不是密钥明文；已有配置不会覆盖，符号链接或宽松权限会被拒绝。脚本无需安装 npm 依赖或本地构建。

在 Sealos 配置界面将输出的 `TOKEN_ADMIN_KEY_SHA256` 设置到 **salestools 主容器**，不要设置到 contact-worker。使用平台 Secret 引用保存摘要并滚动更新。该值必须是64位小写hex；空值/未设置关闭API，非空错误格式启动失败。setup本身不访问服务，配置成功不代表服务端已启用。

更新完成后验证：

```sh
salestools-admin token list
```

管理员明文保留在本机，不粘贴到聊天、日志或命令行参数。备份配置同样使用0600权限。初版采用共享管理身份，不区分实际操作者。

## 常用操作

```sh
salestools-admin token create sales-a --email sales-a@example.com --crm qx
salestools-admin token update-identity sales-a --email sales-a@example.com --crm st
salestools-admin token rotate sales-a
salestools-admin token enable sales-a
salestools-admin token list
salestools-admin token list --limit 100 --offset 100
salestools-admin token disable sales-a --all
```

- 每个 `userId` 一行、一个 Token；邮箱全局唯一，每人仅属一个 CRM 组织。重复 userId、邮箱或 CRM 用户返回冲突，包括已禁用记录。
- create 必须提供邮箱和组织代号 `qx` 或 `st`；仅查询指定连接，分页按规范化邮箱匹配，唯一且 active、confirm=true 后才写入。12 秒内未完成、无匹配、多匹配或实际组织不符均不创建。stdout 仅输出新 Token，明文之后不可查询。
- update-identity 使用相同匹配规则，成功整体更新；失败保留旧信息。支持给旧用户补绑定或由管理员明确更换邮箱、组织，保留原 Token；需要撤销原持有者时另行 rotate。并发变更会返回冲突，应先 list 核对。
- rotate 只替换哈希，立即撤销旧 Token 及其来源上传会话，保留邮箱、绑定和 enabled；禁用用户重发后仍禁用。stdout 仅输出新 Token。
- enable 恢复现有 Token 的可用状态，不生成新 Token。
- list 输出 JSON 元数据和 nextOffset；字段为 userId、enabled、createdAt、email、crmConnectionId、crmOrgId、crmUserId、updatedAt。老用户新增身份字段为 null。分页不是数据库变更期间的快照，不返回明文或哈希。
- disable 保留旧 `--all` 命令格式，会禁用该用户唯一 Token，重复返回 disabled=false；不删除身份和历史记录，不承诺取消执行中的请求。当前 Token 没有有效期。

普通 MCP Token 不能访问管理API；管理员密钥也不能直接调用MCP。管理请求仅使用Bearer头、严格HTTPS、不跟随重定向、15秒超时、不重试。浏览器Origin请求被拒绝。

## 结果未知和故障

退出码：0成功，2参数/配置错误，1明确HTTP拒绝或查询失败，3写操作结果未知。

创建发生超时、网络中断、HTTP5xx或成功回执损坏时，可能已经写入数据库；CLI不会自动重试。先运行list，查看服务端 `admin_token_operation` 审计并结合时间/requestId核对。无法恢复丢失的明文；确认需要替换后使用 rotate，不能重复 create，也无需删除用户记录。重发请求结果未知时也不要盲目重复，先查日志。

HTTP401：管理员摘要与本机密钥不匹配/未授权。404：管理API未启用或未部署该版本。403：Host不匹配或请求携带Origin。429：按Retry-After等待。配置读取失败：核对目录0700、文件0600、所有权，无符号链接；不要放宽权限绕过检查。

日志包含操作、userId、固定管理员身份、requestId、结果，以及成功变更前后的身份元数据（含邮箱）；应限制日志访问。不记录管理员密钥、业务 Token 或哈希。认证失败计数饱和到121，下一分钟首次请求时输出前一窗口汇总；它是诊断指标，不是精确攻击次数。限流仅在本实例内生效。

## 管理密钥轮换

1. 将现有配置复制到权限0600的安全备份文件，保留旧摘要用于回滚。
2. 在本机把现有admin.json移到受限备份位置，再执行setup生成新密钥及摘要；不要删除唯一备份。
3. 在Sealos将主服务摘要更换为新值并完成滚动更新。期间多副本可能暂时混用新旧配置。
4. 运行token list验证；失败则恢复服务端旧摘要和本机旧配置。成功后安全保管新配置，按自身备份策略处理旧密钥。

服务器不能从摘要恢复明文。全部本机配置丢失时，通过Sealos重新配置管理员摘要即可恢复管理能力，业务Token不会因此失效。原 `node dist/cli/tokens.js` 容器CLI继续可用。

## 上线验收与回滚

先部署代码而不设置摘要：/admin返回404，原MCP行为正常；随后配置摘要，仅使用专用测试用户创建Token、验证MCP初始化、查看列表、禁用后验证新请求401。不要对现有用户做全用户禁用测试。记录tested SHA、镜像版本和脱敏结果，不能把本地测试当成线上通过。

关闭/移除摘要后滚动更新即可关闭管理 API。已创建业务Token不会自动失效；回滚前明确禁用不需要的测试用户。首次镜像构建及完整native/容器验证使用远程CI，禁止本地构建。

## CRM 连接与权限

使用 `ZOHO_CONNECTIONS=qx,st`，分别配置 `ZOHO_QX_*`、`ZOHO_ST_*` 凭证和 `ORG_ID`。
`ORG_ID` 必须为 `GET /crm/v8/org` 返回的 `org[0].id`，不是 zgid、primary_zuid 或组织名称。
增加 `ZohoCRM.users.READ`、`ZohoCRM.org.READ` 只读 scope，并重新完成授权。保留原有联系人、客户和 SDK 元数据 scopes，findUser 继续关闭。
现有其他连接代号仍可用于原联系人查询，但用户绑定仅接受 qx/st；不要直接重命名已用于图谱同步的连接，否则来源键会改变，应先确认并迁移既有来源数据。

绑定是身份对应，不改变所有有效 MCP 用户共享 CRM 数据的权限。客户及联系人 Owner 返回可选 `is_current_user`：组织核验成功且 ID 一致为 true，不一致为 false，未绑定、其他组织或核验失败为 null；Owner 本身缺失时仍为 null。核验失败保留联系人查询结果并给出 `CRM_IDENTITY_UNVERIFIED`，不把标记写入共享图谱。

管理 API（沿用现有管理员鉴权、Host/Origin 限制与限流）：

| 方法与路径 | 请求体 | 成功结果 |
|---|---|---|
| POST /admin/v1/tokens | userId, email, crm | 201，userId, token, requestId |
| POST /admin/v1/tokens/update-identity | userId, email, crm | 200，userId, updated, requestId |
| POST /admin/v1/tokens/rotate | userId | 200，userId, token, requestId |
| POST /admin/v1/tokens/enable-user | userId | 200，userId, enabled, requestId |
| POST /admin/v1/tokens/disable-user | userId | 200，userId, disabled, requestId |
| GET /admin/v1/tokens | limit / offset 查询参数 | items, nextOffset, requestId |

错误状态：400 参数错误；409 身份唯一性或并发冲突；404 重发/更新的用户不存在；422 CRM 无匹配、多匹配、用户无效或组织不符；503 组织未配置；502 CRM 调用失败。5xx 写请求仍按结果未知处理，先核对列表和审计。

容器 CLI 使用远程 CI 编译产物：

```sh
node dist/cli/tokens.js tokens:create --user sales-a --email sales-a@example.com --crm qx
node dist/cli/tokens.js tokens:update-identity --user sales-a --email sales-a@example.com --crm st
node dist/cli/tokens.js tokens:rotate --user sales-a
node dist/cli/tokens.js tokens:enable --user sales-a
node dist/cli/tokens.js tokens:disable --user sales-a
node dist/cli/tokens.js tokens:list
```

## 旧库升级与重复 Token 处理

此流程仅对实际部署数据库执行，不能把开发机合成测试当成生产迁移已完成。

1. 停止所有访问该 SQLite 的服务和管理进程，保存与数据库匹配的旧版本镜像。以下工具需要 Node 24，无需依赖或本地构建。
2. 对**现有文件**执行只读预检，记录重复用户的 recordId、创建时间和启用状态；工具不输出哈希。

```sh
node tools/token-migration.mjs preflight --db /data/data.sqlite
```

3. 创建本地受限的 selections.json，为每个重复 userId 明确选择一个 recordId。例如 `[{"userId":"sales-a","recordId":2}]`；没有重复时使用 `[]`。创建时间无法区分时，应结合旧管理记录确认，不猜测。
4. 执行处理，backup 必须为不存在的新路径。工具检查选择合法性后创建 0600 的 SQLite 一致性备份，再检测数据变化并事务删除未选中的重复 Token；其他用户不变。没有重复时也可用此命令生成升级前备份。

```sh
node tools/token-migration.mjs resolve --db /data/data.sqlite --selections /secure/selections.json --backup /secure/before-token-identity.sqlite
node tools/token-migration.mjs preflight --db /data/data.sqlite
```

工具实际上先检查选择合法性，再生成备份；选择有误不会删除任何记录。备份路径已存在时失败，绝不覆盖。输出保留记录编号，不输出 Token。请保存命令结果作为维护记录；备份仍包含可用 Token 哈希，需要受限保管。

5. 部署新版本。启动在事务中扩展 tokens 表并建立唯一约束，保留原 userId、Token 哈希、启用状态和 createdAt，updatedAt 初始化为 createdAt；邮箱和 CRM 字段暂为空。若仍有重复，启动报 TOKEN_MIGRATION_DUPLICATE_USERS 并停止，不自动挑选或撤销。
6. 通过 update-identity 为老用户补邮箱和 qx/st，核对 list、MCP 初始化、重发后的旧 Token 拒绝及 Owner 标记；仅使用专用测试用户验证撤销。

回滚需要停服，先保存升级后的数据库，再恢复完整升级前 SQLite 备份及旧版本镜像；不要仅切换镜像继续写新结构，也不要在运行中只复制 .sqlite 而忽略 WAL。回滚会丢失备份之后的变更，并可能恢复此前已撤销的旧 Token，需明确维护影响。
