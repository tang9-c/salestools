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
salestools-admin token create sales-a
salestools-admin token list
salestools-admin token list --limit 100 --offset 100
salestools-admin token disable sales-a --all
```

- create 的 stdout 仅为新业务 Token；创建提示在 stderr。请保存并交给对应用户，数据库仅保留哈希，之后无法查回。
- list 输出 JSON 元数据和 nextOffset；nextOffset=null 表示没有下一页，不返回明文或哈希。分页不是数据库变更期间的快照。
- disable 必须带 --all，会禁用该用户所有启用 Token，重复操作返回 disabled=false；不删除历史记录，不承诺取消已经执行中的请求。
- 新建不会替换旧 Token；当前 Token 无有效期。不要用 create 代替轮换。

普通 MCP Token 不能访问管理API；管理员密钥也不能直接调用MCP。管理请求仅使用Bearer头、严格HTTPS、不跟随重定向、15秒超时、不重试。浏览器Origin请求被拒绝。

## 结果未知和故障

退出码：0成功，2参数/配置错误，1明确HTTP拒绝或查询失败，3写操作结果未知。

创建发生超时、网络中断、HTTP5xx或成功回执损坏时，可能已经写入数据库；CLI不会自动重试。先运行list，查看服务端 `admin_token_operation` 审计并结合时间/requestId核对。无法恢复丢失的明文，也不能单独撤销某一枚Token。若选择 `disable USER --all` 再创建，会使该用户其他Token全部失效，必须自行确认影响；CLI不会自动执行。

HTTP401：管理员摘要与本机密钥不匹配/未授权。404：管理API未启用或未部署该版本。403：Host不匹配或请求携带Origin。429：按Retry-After等待。配置读取失败：核对目录0700、文件0600、所有权，无符号链接；不要放宽权限绕过检查。

日志只包含操作、userId、固定管理员身份、requestId和结果，不记录管理员密钥、业务Token或摘要。认证失败计数饱和到121，下一分钟首次请求时输出前一窗口汇总；它是诊断指标，不是精确攻击次数。限流仅在本实例内生效。

## 管理密钥轮换

1. 将现有配置复制到权限0600的安全备份文件，保留旧摘要用于回滚。
2. 在本机把现有admin.json移到受限备份位置，再执行setup生成新密钥及摘要；不要删除唯一备份。
3. 在Sealos将主服务摘要更换为新值并完成滚动更新。期间多副本可能暂时混用新旧配置。
4. 运行token list验证；失败则恢复服务端旧摘要和本机旧配置。成功后安全保管新配置，按自身备份策略处理旧密钥。

服务器不能从摘要恢复明文。全部本机配置丢失时，通过Sealos重新配置管理员摘要即可恢复管理能力，业务Token不会因此失效。原 `node dist/cli/tokens.js` 容器CLI继续可用。

## 上线验收与回滚

先部署代码而不设置摘要：/admin返回404，原MCP行为正常；随后配置摘要，仅使用专用测试用户创建Token、验证MCP初始化、查看列表、禁用后验证新请求401。不要对现有用户做全用户禁用测试。记录tested SHA、镜像版本和脱敏结果，不能把本地测试当成线上通过。

关闭/移除摘要后滚动更新即可关闭管理API，无需数据库迁移。已创建业务Token不会自动失效；回滚前明确禁用不需要的测试用户。首次镜像构建及完整native/容器验证使用远程CI，禁止本地构建。
