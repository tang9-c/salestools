# 上传页面打包错误修复

## 现场与根因

只读访问远端 `/contact-upload`，响应 HTML 包含 17 份 doctype；独立 Chromium 出现 `SyntaxError: Numeric separators are not allowed at the end of numeric literals`，文件选择器禁用，状态停在初始化，未发出会话或 import 请求。没有使用上传凭证、上传文件或修改生产联系人。

`scripts/build-contact-upload.mjs` 将整个 JavaScript bundle 用作 `String.replace` 的字符串替换值。bundle 中的 `$` 替换序列被解释，导致 HTML 模板插入 JavaScript。改为回调替换，保持脚本文本原样；不修改会话、上传、容量限制或 CSP。

## 验证

- 测试先运行原代码：`$` 前缀／后缀／匹配／美元转义四项均失败；修复后五项通过，包括关闭 script 标签的转义。测试替代 esbuild 输出与文件 I/O，执行真实打包脚本，不在本地构建。
- 既有浏览器测试使用解释器适配，不能证明打包 HTML 正常。补充真实 `web/dist/contact-upload.html` 的 Chromium 启动检查，保留 script 哈希 CSP，并验证预览请求、DOM 状态和无控制台错误。
- 本地不生成 bundle，新增 artifact 测试仅在远程 CI 强制执行；CI 明确传入 `CONTACT_UPLOAD_BUNDLE_REQUIRED=1`，不能因缺少 artifact 而跳过。
- 本地：51 项相关测试通过，真实 artifact 用例按禁止本地构建边界未执行；类型检查及 diff 检查通过。
- 远程 [CI 38029131860](https://github.com/tang9-c/salestools/actions/runs/38029131860)，tested SHA：`431c76b02f14f2fe7c07b6f35071359c158ef42e`。`native-and-browser` 成功：Rust／Python／类型检查／构建通过，68 个文件、1,316 项 Vitest 通过，实际打包页面启动用例已执行并通过，无跳过。
- 生产容器检查通过：真实镜像构建、Compose 隔离要求、PDF／资源限制／后代进程清理均成功；整个 workflow 结果为 success。CI 后仅补充本文档，不改变已验证的实现与测试。
- 此前发布 v0.5.11 的构建／容器测试未覆盖上传页面脚本执行。本修复在 `fix/upload-html-replacement` 分支，尚未合并、发布或部署；远端真实宿主复测须在部署后另行执行。

## 边界

容量 429 是独立问题，需要对应请求响应才能确认。页面 `failed` 不等于持久化 import 任务 `failed`。本次不重试或关闭用户已有会话，不改变数据流，不调整超时或增加配置平台。
