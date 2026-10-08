# 真实简历本地与 Sealos 对照测试

## 输入与边界

前半部分保留首次对照测试的历史结果；本地二进制更新后的最终结果见“后续：CI macOS 产物更新与本地完整闭环”。

- 测试时间：2026-10-08 UTC。
- 本地源码：`611b0bc2829e68c6868cd3b5ab93e013c4d6c381`。
- 用户授权输入：`J运维简历.pdf`，336822 字节、2 页；SHA-256：`73d521210d255d22d952652ce194847bb6a1e57e1a8098916e65a4d8c0f36be2`。
- 线上 MCP：`https://oojyeijszmwy.sealosbja.site/mcp`；使用现有个人 Token，不回显凭证或简历正文。
- 未构建、未修改业务代码、未发布或部署；未确认创建正式联系人。

## 本次实测

| 环节 | 本地当前代码 | Sealos 当前部署 |
| --- | --- | --- |
| 服务连接 | 不启动本地服务，直接运行现有组件 | MCP 初始化、工具发现成功；`/healthz` HTTP 200 |
| 上传 | 分层解析使用用户原文件 | HTTP 201，file_id `8c828dcc-0de2-4377-a0d6-91e179801097` |
| 导入任务 | 完整验收入口在存储请求处被 `UNKNOWN_OPERATION` 阻断 | import_id `ci_a033db2f75524c0cb3895d8566560bb2`；约 10236 ms 后轮询到 `failed` |
| Docling 解析 | 默认普通运行入口成功；14951 ms、75 块、3612 字符、2 页 | `stage=parse`、`code=CONVERSION_FAILED`；0 候选，尚未进入模型提取 |
| Ark 提取 | 使用真实配置，104809 ms、3 次请求均 HTTP 200；75 块处理、0 块未处理 | 未进入 |
| 候选 | 1 Person、2 Organization、2 Project；人物 1 电话、1 邮箱、20 技能；`invalid_shape` 4 项、`quote_mismatch` 5 项 | 无 |
| 质量警告 | `技能补充失败或主体不明确，已保留主档案`；未人工逐字段复核 | `IMPORT_FAILED` |
| 确认、入库与回读 | 未完成；禁止本地构建，现有 Rust 二进制仍为 2026-09-29 产物，与当前协议不匹配 | 未进入；未创建正式联系人 |

本地完整入口：`ACCEPTANCE_SAMPLE=4 node --import tsx tests/run-real-contact-acceptance.ts`。随后独立运行实际 `parseLocalDocument` 与 `DocumentExtractor`，未模拟模型、未放宽默认解析准备条件、未覆盖存储接口。分层结果不能替代完整服务、生产容器或语义验收。

## 线上失败诊断

`get_contact_import` 已回读到持久化失败，version 3；核心异常链为：

```text
ParseError: main.py serve → parser.py parse
RuntimeError: base_pipeline.py execute → standard_pdf_pipeline.py _unload
              → docling_parse_backend.py unload → pdf_parser.py has_tasks
RuntimeError: base_pipeline.py execute → _build_document
              → standard_pdf_pipeline.py start → threading.py start
exit_code=null, signal=SIGKILL, root_code=CONVERSION_FAILED
```

清理期间的卸载错误可能掩盖早期异常；保留的异常链将触发点定位到工作线程创建。`SIGKILL` 也可能来自应用失败后的进程组清理，不单独证明 OOM。

## 结论

1. 这份 PDF 在本地当前普通入口能够解析和提取；不能将线上失败简单解释为文件格式不受支持。
2. 线上当前故障位于解析运行层，尚不能评价线上模型、候选映射或入库逻辑。线程/PID、内存/地址空间、应用内限制和镜像差异仍需容器证据区分；不能据此断言 Sealos 不支持此功能。
3. 首次对照时，最新普通容器修改仅在本地 main 合并，尚未推送/发布。最新本地发布标签 `v0.5.7` 对应 `782577e`，旧代码仍设置 `RLIMIT_AS` 和 `RLIMIT_NPROC=64`；本次修改移除了这两个应用内限制。MCP 通用版本 `0.1.0` 不能识别实际镜像版本，线上两容器实际摘要仍待核验，不推断线上一定运行该标签。
4. 本地另有测试基础设施问题：旧 Rust 二进制协议不匹配。需要远程构建的匹配产物或匹配镜像才能完成真实存储闭环；不能使用替身存储冒充验收成功。
5. 模型响应成功、块覆盖完整不等于内容准确或完整。9 项待核实与技能补充警告是独立质量问题，不能归入 Sealos 解析故障；本次没有自动确认它们。

## 最小下一步

先发布已通过 CI 的普通容器修改，将主服务和 Worker 同步更新为同一新版本，并核实实际 imageID。随后对同一 SHA-256 文件再次执行上传、解析、提取、预览、确认、回读。不先改 Docling、不盲目加内存、不增加平台。

若更新后仍在 `threading.start` 失败，再在失败发生时读取 Worker 的容器内存/PID额度、计数和事件，及实际解析子进程 limits；只读取 Worker broker 的 `/proc/self/limits` 不足以证明子进程没有另设限制。本机没有 Kubernetes current-context，因此本次没有读取或修改 Sealos 集群配置。

本记录不保存简历正文、姓名、联系方式、完整模型响应或凭证；线上失败任务保留用于诊断。

## `threading.start` 专项复核

- `v0.5.7` 的 `sandbox.enter` 明确设置 `RLIMIT_AS=3GiB`、`RLIMIT_NPROC=64`，并安装应用内 syscall 过滤。这些是已核实的旧代码行为，不是对线上实际镜像或当前限制的断言。
- 当前 `runtime.prepare` 不再设置 AS/NPROC，也不安装应用内 syscall 过滤；仍继承容器/宿主已有额度，不保证继承的额度一定充足。
- `document-worker.ts` 收到错误帧后调用 `finish(error)`，其中调用 `kill()`；`parser-process.ts` 用 `SIGKILL` 结束解析进程组。因此该失败诊断中的 SIGKILL 可由正常失败收尾产生，不能作为内核 OOM 的证据。
- 本次尝试使用已有本地 Linux arm64 镜像 `salestools:contact-upload`，只读挂载当前 Python 代码与用户文件；容器固定 4GiB、2CPU、64PID、禁网、非 root、只读根和 cap_drop。普通基线未在观察期限内完成，尚未产生可用解析结果，已手动终止并自动删除临时容器 `aadd9c18e268`。退出 137 来自本次主动终止，不是 OOM；未继续 AS/NPROC 单变量实验，也不将该实验计为通过或复现了线上故障。
- 本机 `kubectl config current-context` 返回未设置，无法获取线上镜像、解析子进程 limits、PID/内存事件。根因仍未唯一确定；需要线上容器证据，或发布已验证的新普通入口后按同一文件复测。

## 后续：CI macOS 产物更新与本地完整闭环

用户授权由 CI 编译匹配当前源码的 macOS 程序、本机下载使用。本次没有本地编译，也没有访问 Sealos。

- 新增 `.github/workflows/contact-graph-macos.yml`：macOS ARM64 runner，锁定依赖构建 release 程序并运行 Rust 测试；仅上传程序、源码 SHA 和校验和，保留 7 天。不上传简历、`.env` 或业务库。
- 独立分支 `ci/contact-graph-macos-artifact`；提交 `53deef44d5706c257130cabcba84905477d015b2`。仅推送该分支，未推送或合并远程 main，未发布镜像。该提交的 Rust 源码与本地 main `611b0bc` 相同。
- [CI 37740517927](https://github.com/tang9-c/salestools/actions/runs/37740517927) 成功：macOS ARM64 编译和 Rust 测试通过。
- 下载 artifact `contact-graph-macos-arm64-53deef44d5706c257130cabcba84905477d015b2`；程序和 source-sha.txt 校验和验证通过。程序 SHA-256：`08ad97bbcec4813443f424b67cd9eaea2eb5e54256e7ba615c25dcaac8a5fd6d`。
- 程序为 Mach-O arm64；动态库检查仅显示系统库/系统框架，无 runner Homebrew 路径依赖。
- release 程序安装至现有验收入口使用的 `rust/contact-graph/target/debug/contact-graph`；旧程序备份在 `/tmp/salestools-macos-artifact.U8I6Ad/contact-graph.pre-ci`（临时目录不保证长期保留）。
- 替换后用新临时库验证 `health`、`get_import_start` 均成功；后者返回 null，不再出现 `UNKNOWN_OPERATION`。

同一真实文件执行 `ACCEPTANCE_SAMPLE=4 node --import tsx tests/run-real-contact-acceptance.ts`，结果：

| 检查 | 本轮结果 |
| --- | --- |
| 解析与模型处理 | 75 块全部处理，0 块未处理；3 次真实 Ark 请求；预览 `ready_for_review`，无 warnings |
| 自动确认与写入 | 5 个实体写入，0 跳过：1 Person、2 Organization、2 Project |
| 人物回读 | 1 电话、1 邮箱、48 技能；1 就读关系、1 任职关系、2 正式项目参与关系 |
| 组织查找 | 2 个组织均可在正式模式和包含待核实模式命中人物 |
| 项目查找 | 2 个项目关键词均可在正式模式和包含待核实模式命中人物 |
| 自动验收 | 全部 10 项 requiredChecks 为 true，automaticChecksPassed=true |
| 内容边界 | 3 项待核实：invalid_shape 1 项、quote_mismatch 2 项；semanticAcceptance=manual_review_required |
| 脚本退出 | 2：脚本显式规定，自动检查通过但仍需人工语义复核时返回 2；不是运行失败 |

技术词自动覆盖通过；Kubernetes/K8s 按同义要求只需一个命中，本轮 Kubernetes 命中、K8s 字面未命中，不计为遗漏两个独立技能。全文、技能转述准确性及可选信息完整性仍需人工复核，不能仅凭计数声明全面语义通过。

验收使用真实 Rust 存储与实际 Docling/Ark，没有替身组件。临时库和临时上传由脚本正常清理；用户 Downloads 原文件未改动，未写正式联系人库。本轮已经解决本地过期二进制阻断，并验证本地入库、回读、关键词搜索闭环；不能据此宣布 Sealos 问题已修复。
