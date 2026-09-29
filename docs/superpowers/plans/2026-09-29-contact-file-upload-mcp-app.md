# 联系人文件上传入口方案

**目标：** 用户在聊天中选择 PDF 或拍摄名片，查看抽取预览，并明确确认后导入共享联系人库。

**技术路线：** ChatGPT 使用 MCP App 内嵌界面；Codex 使用同一服务提供的外部网页。页面直接向 Salestools HTTP 接口上传文件，并复用现有联系人导入服务。

**技术栈：** Node.js 24、TypeScript、MCP SDK v2、`@modelcontextprotocol/ext-apps`、Express、现有 `UploadStore` 与 `ContactImportService`。

## 已确定的产品决策

- 首版一次处理一份 PDF、JPG、JPEG 或 PNG；支持移动端拍摄名片，拍照不可用时仍可选择图片文件。
- 上传成功后自动启动抽取，页面展示处理状态、所有候选、短证据、待核实项和警告。
- 只有用户点击“确认入库”，才调用现有 `auto_create` 提交逻辑。上传成功或预览完成均不等于已入库。
- 若提示可能重复、主体不明确或没有可提交主体，页面暂停一键提交，显示 `import_id`，让用户回聊天核对；首版不在页面处理合并。
- ChatGPT 内嵌体验是首版验收目标。Codex 通过外部网页完成相同流程；Codex 聊天内渲染 MCP App 不作为首版验收条件。

## 实现安排

### 1. 上传界面与会话

注册一个打开上传界面的 MCP 工具，关联 `ui://` HTML 资源，同时在普通工具结果中返回短期外部链接，供不渲染 MCP App 的客户端使用。内嵌页面通过仅供 App 调用的工具，为当前 MCP 用户创建单文件导入会话。两种入口共用页面逻辑，均不接触长期 MCP Bearer Token。

外部链接只携带有效期 60 秒、原子兑换一次的交接码；兑换后服务器新建 `Secure; HttpOnly; SameSite=Strict` 会话 Cookie，清除地址栏片段，并对所有修改请求严格校验 Origin。不要把可读取预览或提交的会话凭证放入聊天记录、链接、`localStorage` 或 `sessionStorage`。内嵌页面的会话凭证只保存在当前页面内存中，通过 App 专用工具取得，不写入模型可见结果或浏览器持久存储。

会话绑定用户及来源 MCP Token 的指纹，服务端仅保存随机凭证的哈希；每次操作确认来源 Token 仍有效。会话为单文件、2 小时固定有效期，确认入库或主动退出后立即撤销，进程重启即失效。页面会话本身允许上传一次成功文件；服务端在接收请求体前原子占用上传位置，失败后可在有效期内重试，不另造一层可反复领取的上传票据。会话仅能访问绑定的 `file_id` 与 `import_id`；长队列导致页面过期时，用户凭已有 `import_id` 在聊天中继续。

### 2. 上传与导入接口

复用 `/contact-files` 的流式接收、格式检查、大小限制及临时文件清理。受限页面会话只可在该接口上传一份文件；原有个人 Bearer Token 上传方式继续可用。为临时文件记录所属用户，在任何导入任务写入前校验 `file_id` 归属，阻止跨用户导入；文件 ID、会话 ID 与导入 ID 都不能单独作为授权依据。

新增受会话保护的网页接口，分别执行：用绑定的 `file_id` 启动导入、分页读取绑定任务的状态与预览、按预览版本确认提交。接口调用现有 `ContactImportService`，不复制抽取或入库逻辑。导入启动与提交使用稳定的 `operation_id`，响应丢失时可安全重试。版本冲突时要求页面刷新预览。服务端在提交时重新检查重复建议、匹配失败／截断、主体数量和任务状态；不依赖页面按钮状态作授权或业务校验。

内嵌页面向上传域名发请求所需的 `connectDomains` 写入 MCP App 资源的 CSP。仅对使用受限会话 Bearer 凭证的内嵌页面接口开放无 Cookie 的跨域访问；CORS 不被当作身份验证。保持现有 MCP 与个人 Token 上传的 Origin 限制。外部页面只用同源 Cookie 接口，不加载第三方资源，并设置 `Referrer-Policy: no-referrer`、`Cache-Control: no-store`、禁止被其他页面嵌入的 CSP 与严格的脚本策略。所有来自文件、OCR 和模型的预览字段按纯文本渲染，不拼接 HTML。

上传临时目录从可备份的 `/data` 卷移到独立、限额的临时存储，仍使用随机文件名和最小文件权限。现有 PDF／图片解析进程与主服务共享凭证和数据卷是独立的既存风险；对外扩大上传使用范围前须单独完成解析隔离：只读访问单份临时文件及模型资源，无数据库卷、无服务端密钥、无出站网络，并限制 CPU、内存、运行时间及子进程。解析子进程不得继承完整的 `process.env`。首版限制每用户活跃会话数，复用现有文件大小、全局容量和队列上限；观察到滥用时再加细粒度速率限制。

### 3. 页面状态与文档

页面明确区分“待上传”“抽取中”“待确认”“已入库”“失败”，展示容量满额、文件不支持、会话过期和上传中断等可恢复错误。提交前展示可能重复的提醒；只有预览完整且满足单主体自动提交条件时启用确认按钮，服务端仍独立执行同样的提交门槛。页面说明原件临时保存、抽取文本会发送至已配置的模型、正式档案写入共享库。页面与 API 日志不得记录凭证、原文或完整预览。

更新联系人 Skill 和快速入门：优先打开内嵌界面；宿主不支持时给出外部网页链接；保留 CLI 路径。Docker 构建需打包 MCP App 页面资源。

## 验收

- 自动化验证单文件会话过期、第二份上传被拒、失败上传可重试、跨用户 `file_id`、文件限制、断线清理、导入失败、预览版本冲突和提交幂等。
- 验证交接码被重复兑换、会话过期／撤销、来源 Token 被禁用、跨会话读取或提交、伪造 Origin、直接调用提交接口及并发抢占单文件位置均被拒绝；响应和日志不泄露凭证或个人资料。
- 用含 HTML／脚本片段的文件名、OCR 文本和模型结果测试预览渲染；验证恶意或高资源消耗文件无法读取主数据库／密钥，且解析超额会被终止。
- 验证可能重复、多个主体及无可提交主体时页面不执行一键入库，并能向用户提供 `import_id` 供聊天继续处理。
- 在 ChatGPT 实测内嵌选文件、移动端拍照、上传、预览与确认；在 Codex 实测外部网页完成相同流程。
- 回归现有 CLI 上传、MCP 导入以及处理后原件删除行为。

## 依据与边界

- [MCP Apps Quickstart](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/quickstart.md)：工具与 `ui://` 资源关联，页面可调用服务端工具。
- [MCP Apps 文件操作说明](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/migrate_from_openai_apps.md#file-operations-not-yet-in-mcp-apps)：协议尚无内建上传 API，文件仍需发送到 Salestools HTTP 接口。
- [OpenAI MCP 服务与 UI 快速入门](https://developers.openai.com/plugins/build/app-quickstart)：官方文档说明 ChatGPT 内嵌 UI；Codex 内嵌支持不能作为已确认能力。
- [OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)：避免在 Web Storage 保存会话凭证，使用安全 Cookie、超时和 `no-store`。
- [OWASP 文件上传](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)：文件校验之外仍需隔离解析器、最小权限与资源限制。
