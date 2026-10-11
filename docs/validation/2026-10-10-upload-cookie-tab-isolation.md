# 备用上传网页多标签页会话绑定修复

## 根因

备用网页以固定名称 HttpOnly Cookie 认证，Cookie 在同浏览器同站点标签页间共享。页面 B 建立会话覆盖 A 的 Cookie，A 后续请求可读到 B 的任务或退出 B，A 原会话却未释放。本地真实 HTTP 路由已复现，未操作生产数据。

## 最小修复

- 每个会话使用独立 Cookie 名：生产 `__Host-contact-upload-<sessionId>`，本地 `contact-upload-dev-<sessionId>`。保留 HttpOnly、生产 Secure、SameSite=Strict、Path=/ 与两小时有效期。
- 兑换入口返回 `session_id`，不返回 bearer。每个标签页的 sessionStorage 只保存这个不能独立认证的选择编号；刷新仍选择本标签页的会话。
- 备用网页所有文件、任务、预览、提交和退出请求通过 `X-Upload-Session` 选择对应 Cookie；服务端要求选择编号、Cookie 内编号与有效凭证一致。缺少或不匹配一律拒绝，不回退到其他会话或旧固定 Cookie。
- 退出只撤销、清除所选 Cookie 和当前标签页编号；不改其他页面 Cookie。内嵌 MCP App 仍使用独立 Bearer，不读写浏览器存储，也不清除备用网页 Cookie。
- 不改变文件校验、任务主体归属、来源 Token 撤销、同源校验、提交确认或已入库联系人；不引入配置、依赖、管理页面、数据库迁移。

## 回归覆盖

- 真实 HTTP：同一 Cookie jar 内含两个不同用户的 Cookie，请求分别返回自己的任务；退出 A 后 B 可继续，A 被拒绝。缺少选择编号、缺少对应 Cookie、改名冒用另一 Cookie 均被拒绝。
- Chromium 原始 TypeScript 解释器测试：兑换后选择编号随请求发送，刷新保留编号，退出清除编号；同一浏览器上下文内两标签页的编号独立，退出 A 不影响 B。内嵌 App 凭证与存储行为不变。
- 保留原有同源、跨源、Token 失效、提交回执、幂等与确认安全测试。

本地结果：相关六个测试文件 150 项通过、1 项 CI bundle 验收按规则跳过；类型检查及 `git diff --check` 通过。新增 HTTP 与浏览器兑换回归均先观察到旧实现失败，再执行修复。

## 部署与已知边界

发布后需重新从聊天打开入口。旧固定 Cookie 页面不能恢复，不自动迁移旧会话，也不删除联系人或取消后台任务；保留任务编号从聊天查询。浏览器清空 sessionStorage 或 Cookie、进程重启、会话到期时会安全拒绝，不能保证恢复。

独立 Cookie 受浏览器每站点 Cookie 数量限制；超量淘汰后只会失去所选会话，不会串用其他会话。复制现有标签页可能继承同一编号，属于同一会话；需要独立导入时从聊天新建入口。未在生产远端或实际 Codex MCP App 宿主验证，完整 bundle/容器构建须在远程 CI 执行。
