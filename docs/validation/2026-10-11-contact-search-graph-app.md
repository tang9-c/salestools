# 联系人搜索图谱 App 验证记录

日期：2026-10-11。结论：开发实现与本地无构建验证通过；远程 CI、生产镜像与真实宿主尚未验收。

## 版本与边界

- 分支：`feat/contact-search-graph`。
- 工作区：`/Users/tang-codeing/code/salestools/.worktrees/contact-search-graph`。
- 基准 SHA：`75005bf7e85298a6972fcfb799a100685bf3cd9b`，本次修改尚未提交；这不是包含新实现的 tested SHA。
- 本地环境：macOS arm64；Node `v24.11.1`；Chrome `154.0.8037.98`。
- 运行对象：原始 TypeScript 通过解释器去除类型，在真实 Chrome iframe 中使用已安装的真实 MCP Apps SDK；仅宿主响应与服务存储边界采用合成返回。未打包，不替代 CI 真实 bundle、Rust 存储或 Codex 宿主验收。
- 生产代码与 gate 文件指纹（按文件路径与内容依次 SHA-256）：`bfbd07e9359a6055abcfd34c19eee2126e46dabcf9a9d89833c43841ffb5f13e`。覆盖 web 三文件、MCP 三注册文件、index、两个脚本和现有 CI workflow；不含测试、文档或凭证。
- 未调用远端生产 MCP，未新增/修改共享库联系人，未提交、推送、合并、发布或部署。主工作区既有改动未触碰。

## 已验证

| 范围 | 结果 |
| --- | --- |
| 图模型 | 同名不同 ID、方向、五种职业关系、正式/待核实 ID 分离、家庭关系排除、超过20条累计及非递归端点补读 |
| MCP | 有/无 App 注册、原文本 JSON 与 structuredContent、资源 CSP、get_contact App 可调用且不重新开图；HTTP 有效凭据可读，缺少/无效凭据拒绝，无新 HTTP 查询入口 |
| 自动加载 | 无需点击读取全部一跳分页；50个命中根均读取、共享邻居只补一次名称、不遍历其关系；逐页显示及完成进度 |
| 故障与生命周期 | SDK30秒超时、停止/继续、失败游标重试、found:false、异常分页和不前进游标；新查询等待旧调用结束，旧响应不覆盖新图 |
| 交互 | 搜索上一页/下一页保留过滤条件；失败保留旧图；选中详情不清图，快速重新选中已加载节点时旧详情不能覆盖它 |
| 证据/安全 | 关系引文按 subject_kind/subject_id 对齐；无源页不等于无证据；source_url 可显式经宿主打开并失败回退为可复制文本；姓名不当作 HTML；家庭及联系方式证据不混入展示，无数据日志 |
| 兼容 | 原上传 App 的无构建浏览器回归、MCP 工具/端到端回归与双页面脚本替换/转义逻辑 |

最终本地命令：

```sh
CONTACT_UPLOAD_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  node node_modules/vitest/vitest.mjs run \
  tests/contact-search-graph-model.test.ts tests/contact-search-tools.test.ts \
  tests/contact-search-graph-app.test.ts tests/contact-search-graph-browser.test.ts \
  tests/contact-upload-build.test.ts tests/contact-upload-app.test.ts \
  tests/contact-upload-browser.test.ts tests/mcp-tools.test.ts tests/mcp-e2e.test.ts \
  --reporter=dot
node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

结果：9个测试文件通过，85项通过、1项跳过；跳过的是原上传 App 仅在 `CONTACT_UPLOAD_BUNDLE_REQUIRED=1` 下运行的真实 bundle 验收。图谱浏览器测试的18项均通过，CI 设置该变量后直接读取真正的图谱产物并执行相同场景，缺少 bundle 必须失败。类型和 diff 检查通过；Node 的 SQLite/类型去除实验性提示不是失败。联系人 skill 的现有验证器通过，未将语法检查声称为独立代理行为验证。

## 仍待验收

1. 提交、推送获授权后，执行现有 `contact-upload-validation.yml`：完整类型/构建/Vitest、Rust/Python 原生回归、两个 bundle 的真实 SDK/CSP 场景及生产容器 smoke。未执行本机构建。
2. 部署另行授权后，以实际镜像版本和包含实现的 tested SHA，在当前 Codex 中展开 `search_contacts` App，验证云杉智造自动关系加载、显式待核实虚线、详情/来源和搜索分页。此远程案例是合成记录，不是现实人员验证。
3. ChatGPT 宿主独立记录结果，目前未测。不能把 Chrome 的模拟宿主结果称为这些宿主可用。

## 已知取舍

- 只自动读取当前搜索页的职业范围一跳；不递归、不查全库。默认10个命中，最多50个；无一跳条数硬截断，关联多时加载和画布可能较慢，用户可停止/继续，并通过节点列表或缩放查看。
- 待核实项只有原查询显式开启才读取；既有接口不返回其他主体指向它的入向 claim。UI 只显示职业相关内容不等于服务端完整响应已脱敏。
- 当前工作区的 node_modules 是为无构建测试复用依赖创建的符号链接，不应加入提交。
