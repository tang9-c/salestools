# 联系人搜索图谱 App 验证记录

## 真实宿主复测与入口辨识修正（2026-10-11）

- 远端：`https://oojyeijszmwy.sealosbja.site/mcp`。在当前聊天调用 `search_contacts({query:"云杉智造",mode:"keyword",limit:10,offset:0})`，返回一个 Organization；用户未看到图谱入口。不能据此宣称真实宿主验收通过。
- 独立 MCP Client 只读检查：`tools/list` 返回标准 `ui.resourceUri` 和兼容 `ui/resourceUri`，均指向 `ui://salestools/contact-search-graph.html`；`resources/read` 成功，MIME 为 `text/html;profile=mcp-app`。图谱和导入 HTML 约为 603 KB 和 601 KB，没有证据支持页面大小是原因。
- 用户确认导入 App 可在聊天内嵌显示。不能用“客户端完全不支持 MCP App”或全局开关解释两个工具的差异。复测后桌面日志没有记录新的 App 创建或加载事件；这是展示链路待排查的线索，不是缓存问题的确证。
- 最小代码调整仅为图谱工具添加中文标题和展开说明；不增加 opener、HTTP 页面、结果字段或新配置。标题改善辨识度，不保证解决宿主未触发展示的问题。
- 契约测试改为从 `tools/list` 的实际绑定 URI 读取资源，并检查标准与兼容绑定一致、标题可辨识及搜索 JSON 不变。它覆盖服务端发现链路，仍不替代真实宿主的入口创建。
- 浏览器测试自动创建 iframe，验证的是打开后的运行，不能证明真实聊天会创建入口。后续必须刷新 Salestools 连接或由用户重启客户端后，在真实聊天重新查询并看到可展开入口；记录客户端版本、实际部署镜像/SHA，再用有职业关系的节点验证展开和一跳加载。
- 若刷新后仍无入口，保留为未通过，继续排查宿主发现/调用到展示的边界，不以测试通过或重新发布镜像代替验收。
- 本次未提交修改的本地验证：排除 `.worktrees/**` 后，工具契约、HTTP 资源发现、图模型及无构建浏览器回归共 4 文件 / 30 项通过；`tsc --noEmit` 和 `git diff --check` 通过。首次浏览器运行因缺少 Playwright 默认浏览器失败，指定本机已有 Chrome 后通过，未下载浏览器或执行构建。真实聊天入口仍未通过验收，本次没有提交、发布或部署。

### 本地真实宿主连接准备

- 已在用户级 Codex 配置添加独立的 `salestools-local` STDIO 连接，不覆盖远端 `salestools`。它通过 Node/tsx 解释执行 `tmp/local-contact-graph-mcp.ts`，使用当前修改后的生产工具注册、ContactSearch 和 ContactLibraryService；没有本地构建。临时脚本不属于正式功能或发布产物。
- 验证边界：图谱 HTML 复用现有远端 bundle（本次没有改动页面源码）；底层资料通过现有 MCP 只读获取，并非完整离线应用。本地不启用 Docling、Rust 存储、企业研究或上游分析；远端不创建或修改联系人。临时适配器拒绝全部写入操作，Codex 配置仅启用 `search_contacts` / `get_contact`。凭据由本机 `.env` 读取，不写入脚本、Codex 配置或验证记录。
- 独立真实 STDIO 客户端已完成初始化、工具发现（含新中文标题）、绑定资源读取、云杉智造检索及档案回读；“林知远”亦可命中，但没有正式关系。只读检查找到“井冈山大学”有两条 `alumniOf` 关系，后续应使用该关键词验收关联展示。
- 当前聊天的动态工具目录未出现 `salestools-local`，没有可用的工具刷新操作。需用户重启桌面客户端以重新加载配置，再在本聊天明确使用本地连接搜索“井冈山大学”，检查入口、展开及关联节点。配置成功和独立客户端通过不等于图谱已在聊天显示，此项仍待验收。

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
