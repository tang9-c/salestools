# 解析器重复资源约束调整

## 变更范围

按用户确认的第 1 项执行，不更换 Docling、不修改 Landlock/seccomp、不合并容器。

- 默认不再设置固定 `RLIMIT_AS=3Gi` 或 `RLIMIT_NPROC=64`；继承的软/硬限制保持原样，不提高宿主已有额度。
- 保留既有显式 `memory_bytes` 参数用于资源探针；正常 launcher 不传该参数。CPU、FD、文件大小、core dump、并发、期限和进程组清理机制未取消。
- Sealos 上传与解析临时卷使用磁盘型 `emptyDir`，各保留 1Gi 上限；socket 仍为 1Mi 内存卷。补丁显式设置 `medium: ""`，避免战略合并保留旧的 `Memory` 值。
- Worker 4Gi/2 CPU 模板额度，以及 Compose/CI 的容器级 64 PID 限制不变。未测出更低资源配置，不宣称减少了 Docling 的实际物理内存需求。
- Compose/CI 原有 tmpfs 与严格隔离门禁保持不变。磁盘型 Sealos 临时卷仍需真实部署验证，不能声称与 Compose 挂载完全等价。

## 本地验证（2026-10-08 UTC）

- 先加入继承资源限额的回归测试。旧代码在尝试重设限额时失败，修改后通过。该测试使用独立子进程的真实 `setrlimit`；仅在 macOS 替代不可用的内核接口，在 Linux 则执行真实沙箱。
- 5 项 Python 定向测试通过：继承限额、ABI 权限掩码、旧 ABI seccomp 补偿、进程控制过滤、平台失败关闭。
- 4 个 Vitest 文件、18 项测试通过：真实合成 PDF、Worker IPC、启动、取消/超时及后代和 scratch 清理。
- `npm run typecheck`、Python AST 语法检查、Sealos YAML 解析和配置断言、`git diff --check` 通过。
- 用户授权的 `J运维简历.pdf` 本地 Docling 解析成功：14674 ms，2 页、75 文本块、3612 字符。使用既有 macOS `test-only` 入口，不能作为新 Linux 沙箱限额的真实验收，也未重新调用模型或执行入库。

## 尚未验证与交付边界

未本地构建、未发布镜像、未改线上配置、未提交或推送。既有无关未提交文件保持原样。

远程 Linux CI 尚未运行本次未提交修改；不能以降低 CI 容器额度或关闭沙箱换取通过。发布后还需在 Sealos 同时更新两个容器并应用临时卷补丁，再使用同一份简历核对解析与完整入库。当前只完成资源约束调整，未证明此前 `threading.start` 失败已被修复。

容器限额是新的主要资源边界。Sealos 的有效 PID 上限仍需核验，不能宣称继承的 `RLIMIT_NPROC` 一定有限；不建议以无资源约束的普通进程方式运行 Worker。磁盘临时卷需要节点临时磁盘空间，Pod 删除不等于介质安全擦除，原件不应进入 PVC 或备份。
