# Contact Upload MCP App Implementation Plan

**目标：** 在 ChatGPT MCP Apps 和 Codex 外部页面提供安全、单文件、预览后确认的联系人导入入口，保留现有 CLI/MCP 路径。

**技术与边界：** Node.js 24、TypeScript、Express 5、MCP SDK v2、ext-apps、Docling、Rust 图谱。复用 `/contact-files`、UploadStore 和 ContactImportService。输入只接受 PDF/JPG/JPEG/PNG，上传/启动绑定用户；会话密钥不进入聊天 URL，预览只使用文本节点，提交前再次校验版本和完整性。生产解析必须先封闭 Linux 单输入内容访问和 syscall 权限，再导入解析库。

原方案见 `2026-09-29-contact-file-upload-mcp-app.md`，原设计见 `../specs/2026-09-29-contact-upload-design.md`。本表反映 2026-09-29 修复审查后的证据；完成实现与通过实际生产/宿主验收分别记录。用户禁止所有本地构建，包括 npm build/dev、Rust 编译、容器构建及等效脚本；该规则覆盖旧方案中的本地构建步骤。

## Task 1：后端生命周期与持久化启动重放

对应原实现计划 Task 1–3（用户绑定、受限会话、HTTP 复用）。

- [x] 上传 actor 所有权、单文件 claim、失败上传重试、handoff 60 秒一次性、两小时会话、源 Token 撤销及 actor 配额。
- [x] Cookie 变更要求 exact Origin；App Bearer 跨域仅无 Cookie CORS。错误响应保持可读；个人长期 Bearer CLI 路径保留。
- [x] 提交同步 single-flight、版本/主体/匹配/完整覆盖守卫、异步预览后写前再授权。缺少原覆盖 metadata 不能伪造为空数组通过守卫。
- [x] 成功立即撤销上传/预览/新提交，只允许同原凭据、同原预览版本返回最小固定成功回执；显式退出也撤销回执。
- [x] 新增图谱只读 `get_import_start`；服务重启/原件清理后仍可按原 actor/file/operation 查询启动，禁止改变绑定或创建新任务。
- [x] 本地允许的测试和 no-emit 检查通过，最终修复轮 11 项有效 red、98 项 covering green；独立审查 Approved，无 Critical/Important。精确证据保存在隔离 worktree 的 `.superpowers/sdd/2026-09-29-contact-file-upload-mcp-app/task-1-report.md` 与 fix-3 review。
- [ ] 新 revision 原生 Rust build/tests、`get_import_start` 和 graph/CLI/MCP 集成通过远程 CI；旧本地 binary 不算证据。

限制：页面会话和成功回执仍在内存，回执最多 1000 条，受原期限、退出、Token 禁用、重启/淘汰影响。持久化的是导入启动记录，不能再写成“启动重放只在内存”。退出不能回滚已发生的数据库写入。

## Task 2：完整页面、隐私告知与恢复

对应原实现计划 Task 4（同一 bundle 用于 MCP App 与外部页）。

- [x] 一份文件、手机 capture 输入、选择前说明临时原件/模型文字/共享库确认。
- [x] 渲染全部字段、短证据、候选、关系、待核实项、处理范围；服务端聚合全部同版本分页并返回 `confirmation.allowed/reasons`，页面仅在明确允许后才能人工点击确认。使用 `textContent`，不插入 OCR/模型 HTML。
- [x] 上传/启动/读取/回执重试，版本冲突重新核对；错误码对应动作；保留 `import_id` 回聊天处理。
- [x] App 内存凭据刷新后不恢复旧会话，外部 Cookie 尝试读取原任务；显式退出、真实 SDK `ui/resource-teardown`、清除本页回调/网络能力；静默 SDK transport 消除内容日志。
- [x] Chromium DOM/XSS/实际 SDK iframe 回归 35 项通过；最终合并 covering green 91 项、no-emit/diff 通过；独立审查 Approved，无 Critical/Important。证据在 `task-2-report.md` 与 fixround1 review。
- [ ] 本 revision bundle 构建及完整浏览器/full-suite 远程 gate。
- [ ] 真实 ChatGPT MCP Apps、Codex 外部 HTTPS 页和手机拍照环境验收；等待宿主环境。

Chromium 的协议模拟宿主不是 ChatGPT/Codex 集成证明。刷新/关闭丢失 App 会话时用原 `import_id` 查询，不能声称旧 App 凭据可恢复。

## Task 3：真实单输入隔离和可控清理

对应原实现计划 Task 5（worker 与临时存储）。

- [x] 临时原件放在 `/data` 与备份之外，上传/socket 使用 tmpfs；无服务数据库/上游密钥挂载到 worker。
- [x] Python launcher 先运行 Landlock ABI≥3 和 libseccomp，再导入解析库；只读当前输入及镜像资源、私有 scratch 可写；关闭额外 FD、清空继承环境，拒绝 socket/网络、FD/进程/namespace/信号逃逸。
- [x] 监督器在成功、错误、超时、取消后杀死整组后代；有界物理目录清理处理 600 层目录、000 权限和 symlink，失败返回 `SCRATCH_CLEANUP_FAILED`。
- [x] 已修复合法 SI_QUEUE 排队信号攻击、深目录 ENAMETOOLONG、独立可信测试入口 test-only 环境兼容；生产模式仍 fail closed。
- [x] 本地 process/worker focused 14 项 green；独立入口有效 red 3 项、covering green 11 项；no-emit/语法/diff 通过。独立审查 Approved，无 Critical/Important。证据在 `task-3-report.md` 和 fix-2 review。
- [ ] 真实 Linux 内核探针零跳过、生产 worker 镜像正常 hardened PDF、CPU/内存/期限/取消/600层 scratch 清理通过远程 CI。

macOS 上 Linux probe 跳过不能算隔离通过。部署必须保留 network none、只读根、cap_drop ALL、no-new-privileges、非 root、init、CPU/内存/PID 限额；不得降级 `test-only` 或关闭控制。

## Task 4：远程验证与交付文档

- [x] 专用 `contact-upload-validation.yml`：PR、`codex/contact-upload-*` push、dispatch；contents read、不保留 checkout 凭据、不发布/部署、不接触生产 env/密钥。
- [x] Ubuntu runner 的 Node24/锁定 uv/Python/libclang/Rust；Rust debug binary/tests、server/tests/web no-emit、页面/server bundle、完整 Python/Vitest/匹配版本 Chromium。
- [x] 独立串行生产镜像 job；Compose 空临时 env 文件；声明和实际运行控制断言，原样 hardened smoke 命令包括 Linux 零 skip/合法信号 control/正常 PDF/资源/后代/深目录清理。
- [x] Docker context 只允许 smoke 所需的一个合成 PDF fixture 穿过 tests 排除；不引入其他测试或私密原件。
- [x] QUICKSTART、skill、AGENTS 更新：原件/模型/共享库告知、恢复/退出/回执限制、内核要求、CLI 使用远程构建产物、真实宿主证据表。
- [x] 本 Task 4 YAML 解析、13 个 shell 块语法、Node smoke 语法和 diff 检查通过；Actions 40 位 SHA 和只读 workflow 结构已核验。
- [ ] 最终独立 diff 审查（包含安全/旧 CLI/MCP 路径/unrelated edits）。
- [ ] 控制代理提交并推送新隔离特性分支；只触发验证 workflow，不打 tag、不触发发布。
- [ ] 远程 tested SHA 的两个 job 全绿；补 run URL、测试计数和零 skip probe 日志。

## 整体审查补充修复（待复审与远程证据）

- I1：补充拒绝非零 PID `prlimit64`（自身 glibc/Python 资源操作保持 `pid=0`），`fcntl` signal owner/选择与 `O_ASYNC`、等价 owner/FIOASYNC ioctl。按内核 32 位参数比较，覆盖高位绕过；保留普通 FD 操作。新增同 UID 哨兵的未加固正向 control 和 hardened EPERM/资源不变/无信号断言，含匿名管道及可信标准 FD socketpair。
- I2：兑换接口在 JSON 解析前设置 no-store，并走泛化 JSON 错误处理；不授予 App Bearer CORS。畸形/超额请求在 production 错误路径不记录 payload，正常单次兑换和 exact Origin 不变。
- I3：首次远程 run `36661267650` workflow validation 失败，未创建 job。三个 job.env 的 runner.temp 路径改在各 job 首个 runner step 使用 `$RUNNER_TEMP` 写 `$GITHUB_ENV`；两个脚本已在含空格临时路径实际执行，15 个 shell 块语法通过。
- 本轮本地 HTTP/session/App 72 项通过、no-emit 通过，seccomp 规则边界有 red→green。macOS 2 项通过/8 项 Linux skip **不是内核通过证据**；最终增量复审、新 tested SHA 的远程两个 job、hardened PDF 及真实宿主门禁保持待验。精确证据见 scratch `final-fix-report.md`。

## 发布前验收记录

| 门禁 | 状态 | 要保存的证据 |
| --- | --- | --- |
| 本地针对性/no-emit 与独立实现审查 | 已通过 Task 1–3 | scratch task reports + review reports |
| 本 revision 远程 native/full-suite/bundle | 待运行 | CI run URL、tested SHA、日志/计数 |
| 本 revision hardened Linux/生产镜像/PDF/resource | 待运行 | 同一 SHA、零 skip、实际控制断言、安全日志 |
| ChatGPT 实际 App | 待环境 | 日期/revision/客户端版本/脱敏截图，退出/teardown/重开/确认 |
| Codex 实际外部页 | 待环境 | OS/浏览器版本、短码/Cookie/刷新/回执/聊天恢复 |
| 手机实际相机 | 待环境 | 系统/宿主版本、权限/取消/上传/预览结果 |

真实宿主清单与远程 API 操作见 `docs/QUICKSTART.md`。所有 CI 数据为合成文件/临时数据库，模型请求由测试 stub；OCR 模型资源下载用于真实解析。没有本 revision 的 CI 与宿主证据前，不称“部署验证通过”或“公开上传就绪”。
