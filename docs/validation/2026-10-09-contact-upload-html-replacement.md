# 上传页面打包错误修复

## 现场与根因

只读访问远端 `/contact-upload`，响应 HTML 包含 17 份 doctype；独立 Chromium 出现 `SyntaxError: Numeric separators are not allowed at the end of numeric literals`，文件选择器禁用，状态停在初始化，未发出会话或 import 请求。没有使用上传凭证、上传文件或修改生产联系人。

`scripts/build-contact-upload.mjs` 将整个 JavaScript bundle 用作 `String.replace` 的字符串替换值。bundle 中的 `$` 替换序列被解释，导致 HTML 模板插入 JavaScript。改为回调替换，保持脚本文本原样；不修改会话、上传、容量限制或 CSP。

## 验证

- 测试先运行原代码：`$` 前缀／后缀／匹配／美元转义四项均失败；修复后五项通过，包括关闭 script 标签的转义。测试替代 esbuild 输出与文件 I/O，执行真实打包脚本，不在本地构建。
- 既有浏览器测试使用解释器适配，不能证明打包 HTML 正常。补充真实 `web/dist/contact-upload.html` 的 Chromium 启动检查，保留 script 哈希 CSP，并验证预览请求、DOM 状态和无控制台错误。
- 本地不生成 bundle，新增 artifact 测试仅在远程 CI 强制执行；CI 明确传入 `CONTACT_UPLOAD_BUNDLE_REQUIRED=1`，不能因缺少 artifact 而跳过。
- 远程 CI 结果待记录；此前发布 v0.5.11 的构建／容器测试未覆盖上传页面脚本执行，本修复尚未发布或部署。

## 边界

容量 429 是独立问题，需要对应请求响应才能确认。页面 `failed` 不等于持久化 import 任务 `failed`。本次不重试或关闭用户已有会话，不改变数据流，不调整超时或增加配置平台。
