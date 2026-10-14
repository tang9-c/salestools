# Landlock ABI 1 兼容实施计划

> **For agentic workers:** 使用 `superpowers:executing-plans` 按任务执行。构建和 Linux 容器验证只在远程环境进行。

**Goal:** 让现有联系人文档解析器在 Sealos 的 Landlock ABI 1 节点上工作，同时保留单文件隔离和既有进程限制。

**Architecture:** 继续使用现有 Landlock + seccomp 沙箱；根据实际 ABI 选择文件权限。ABI 1/2 缺少的截断限制由额外 seccomp 规则补齐，不增加另一套解析器或可关闭沙箱的配置。

**Tech Stack:** Python、ctypes、Linux Landlock、libseccomp、现有 Node Worker 和远程 CI。

**需求依据:** 用户要求兼容现有服务器；线上实测 Linux `5.15.0-112-generic`、x86_64、Landlock ABI 1，libseccomp 可加载，Worker 内存限制 4 GiB。虚构 PDF 上传返回 `503 / PREFLIGHT_FAILED`，直接预检返回 `SANDBOX_UNAVAILABLE`。

## 边界与安全要求

- 只调整现有解析沙箱、相关测试和部署说明；不修改 MCP、导入状态机、数据库、LLM 抽取和上传界面。
- ABI ≥ 3 保持原有行为；ABI 1/2 使用补偿限制；ABI 查询失败或不支持 Landlock 时继续拒绝解析。
- 保持非 root、只读根文件系统、上传卷在 Worker 中只读、capabilities 全部移除、no-new-privileges、网络系统调用限制、资源限制和后代进程清理。
- 保持原有安全测试，不删除失败用例，不用 `test-only` 验收生产解析。
- 不增加 `ALLOW_UNSAFE`、关闭沙箱开关、ABI 环境变量或新依赖。
- 核心代码只修改 `python/contact_worker/sandbox.py` 和现有 `python/tests/test_sandbox.py`；复用现有 CI，不新建兼容框架、测试平台或流水线。
- 不执行本地构建。当前仓库的无关未提交文件保持不动；提交、发布镜像和线上变更在执行时按用户授权进行。

## 已确认的问题

`python/contact_worker/sandbox.py` 中 `enter()` 将 ABI < 3 一律拒绝；规则集及 scratch 规则也固定包含 ABI 2/3 的权限位。

ABI 1 不支持 `REFER`：跨目录硬链接和重命名受默认限制，不放宽这一行为。ABI 1/2 不支持 `TRUNCATE`：仅删除权限位会留下清空文件的路径，必须补偿。

官方依据：[Linux Landlock 文档](https://docs.kernel.org/userspace-api/landlock.html)。文档特别指出 `open(..., O_RDONLY | O_TRUNC)` 也可能截断文件。

## 任务 1：在现有沙箱内实现兼容

**文件：** 修改 `python/contact_worker/sandbox.py`、`python/tests/test_sandbox.py`。

**接口：** `enter()` 调用方式不变。可增加内部 `_landlock_abi(libc)` 辅助函数，供权限选择及测试使用；ABI 不由调用方或环境配置覆盖。

- [ ] 增加运行时 ABI 查询，并保留错误时拒绝启动的行为。
- [ ] 规则集、runtime/source/scratch 的允许权限全部使用当前 ABI 支持的位掩码，避免仅调整规则集而遗漏 scratch 中的不支持权限。

权限选择应遵循：

```python
supported = (1 << 15) - 1
if abi < 3:
    supported &= ~(1 << 14)  # TRUNCATE
if abi < 2:
    supported &= ~(1 << 13)  # REFER
handled = supported
# 所有 allowed_access 同样与 supported 相与。
```

- [ ] 将实际 ABI 传入内部 `_seccomp()`。ABI < 3 时，额外拒绝 `truncate` 和 `ftruncate`；这一限制同样覆盖 scratch，不能基于文件描述符编号猜测安全文件。
- [ ] ABI < 3 时，拒绝 `open/openat` 中携带 `O_TRUNC` 且访问模式为只读或 Linux 特殊模式 `3` 的组合。特殊模式不能被当作普通可写打开；普通 `O_WRONLY/O_RDWR` 打开仍由 Landlock 的 `WRITE_FILE` 控制，不笼统禁止 scratch 中的所有 `O_TRUNC` 打开。

复用现有 `Compare` 的 `MASKED_EQ`：

```python
mask = os.O_TRUNC | os.O_ACCMODE
# open flags 参数索引为 1；openat 为 2。
# 拒绝以下两种 MASKED_EQ 匹配，避免漏掉特殊访问模式 3：
# (flags & mask) == os.O_TRUNC
# (flags & mask) == (os.O_TRUNC | os.O_ACCMODE)
```

- [ ] ABI < 3 时拒绝 `openat2` 并返回 `ENOSYS`，因为现有 seccomp 无法检查指针内的打开标志；ABI ≥ 3 不新增这项限制。测试普通运行时是否正确回退。
- [ ] 系统调用规则按实际 x86_64/aarch64 架构可用性添加；必要规则安装失败继续拒绝，不吞掉 libseccomp 错误。保持现有对非原生 ABI 的限制。
- [ ] 保留普通 scratch 创建、读写、关闭、同目录重命名能力。跨目录重命名不得为了兼容而放宽。

**先验证可行性，再扩大验证范围：**

- [ ] 先在现有测试文件中增加最小补偿策略用例，证明输入不能被截断、scratch 普通写入仍可用；再实现补丁。
- [ ] 在远程构建的生产运行时中，用 ABI 1 权限掩码及完整 seccomp 补偿规则，以 hardened 模式解析一份虚构文字 PDF 和一份图片/OCR 样本。通过现有测试入口覆盖这一路径，不增加生产环境 ABI 覆盖开关。
- [ ] 两类文件均须产出非空正文及来源块。重点确认禁止 `ftruncate`、`openat2` 和跨目录操作没有破坏 Docling；此步骤失败则停止，不先扩展 CI 或同步“已支持”的文档。
- [ ] 新内核上的兼容分支验证只是可行性检查，最终仍须通过任务 3 的真正 ABI 1 节点验收。

**可行性通过后，在现有测试文件中补齐：**

- [ ] ABI 1/2/3 的权限位选择准确；无法查询 ABI 时拒绝。
- [ ] ABI 1 补偿策略下，当前只读输入、兄弟输入、其他可写 scratch 文件不能通过 `truncate`、`ftruncate` 或只读 `O_TRUNC` 被清空；测试前后内容完全一致。
- [ ] 覆盖 `open`、`openat` 中 `O_RDONLY | O_TRUNC` 与特殊访问模式 `3 | O_TRUNC`；普通 `O_WRONLY/O_RDWR` 在 scratch 中仍可用，保护目标在探针前后内容完全一致。
- [ ] 覆盖 `openat2` 路径；返回预期失败，不产生截断。
- [ ] scratch 普通创建与写入成功；输入及兄弟文件不可写、兄弟文件不可读。
- [ ] 原有网络、进程控制、资源限制、取消和清理测试继续通过。
- [ ] 在新内核中可通过 mock 内部 ABI 查询执行 ABI 1 权限策略测试；明确标注这只验证兼容分支，不代表旧内核实测。

**功能停止条件：** 如果 Docling 必须依赖被禁止的截断调用或 ABI 1 禁止的跨目录操作，记录实际失败，不直接放开调用；此时方案不能发布为已兼容，需重新评估或换节点。

## 任务 2：复用现有远程验证

**文件：** `python/tests/test_sandbox.py`。直接复用 `.github/workflows/contact-upload-validation.yml` 的现有 Python 和容器验证入口，不新增 workflow 或 job。

- [ ] 任务 1 的解析可行性和新增隔离用例通过后，运行一次现有远程 `contact-upload-validation.yml`：Rust、Python、Vitest、浏览器及生产容器门禁必须通过；只有新增修改或发现未解决的问题时才重复运行。
- [ ] 远程测试同时覆盖默认 ABI ≥ 3 路径和 ABI 1 补偿路径；不增加独立 CI 平台或常驻服务。
- [ ] 复用任务 1 的 PDF/图片解析检查作为兼容功能证据，不重复建设另一套解析评测。
- [ ] 当前生产容器门禁要求独立无网络 Worker。Sealos 同 Pod 的部署与该拓扑不同；实际 ABI 1 测试不能替代或冒充完整生产容器门禁，不为迁就平台删除门禁断言。

## 任务 3：在真正的 Sealos ABI 1 节点验收

复用当前服务和 Worker，使用虚构样本；不重建持久数据库，不导入真实个人资料。

- [ ] 记录新镜像版本、commit SHA、两个容器的实际镜像及环境，确认内核仍为实测 ABI 1。
- [ ] 保留主容器 `TMPDIR=/tmp/salestools-contact-uploads`、Worker `CONTACT_UPLOAD_DIR=/tmp/salestools-contact-uploads/salestools-contact-uploads`，防止此前目录权限问题复发。
- [ ] 在该节点执行补偿隔离的真实 Linux 探针：文件内容保护、网络/进程限制、资源限制和清理；不通过时停止文档导入验收。
- [ ] 用镜像内虚构 PDF 做 hardened 预检，须退出码 0；随后实际解析 PDF 和图片，须产出非空来源块。
- [ ] 经 HTTPS 上传虚构简历，取得真实 `file_id`；调用 `import_contacts`，保存 `import_id`，等待 `ready_for_review`。
- [ ] 核对唯一人物、字段引文、关系建议、未处理块和告警；符合现有聊天/CLI 提交条件时，用固定 `contact-import:<import_id>` operation ID 提交。
- [ ] 用 `get_contact` 和 `search_contacts` 回读已保存人物、关系及来源，确认不是仅预览成功。
- [ ] 核对上传原件和解析 scratch 已按既有规则清理；若中途失败，明确记录失败阶段和未写入范围，不反复创建任务。
- [ ] 真正 ABI 1 节点验收通过后，才同步 `docs/QUICKSTART.md`、`docs/PRD.md`、`skills/salestools-contact-management/SKILL.md` 及 `sandbox.py` 的版本要求说明：支持 ABI 1/2 的补偿路径和 ABI ≥ 3 的原生截断隔离，仍要求可用 Landlock、libseccomp 和现有运行限制。只更新相关要求及实际验证结果，不重写文档或宣称任何 Linux 环境均可运行；ABI 2 未实测时如实注明。

## 完成标准

新内核原有门禁通过；真正 ABI 1 节点的隔离探针、PDF/图片解析及一次 HTTPS 简历导入回读全部通过。只验证权限位选择、只让主服务启动或只通过新内核 CI，均不能称为 Sealos ABI 1 已兼容。

执行顺序固定为：最小补丁及检查 → Docling 解析可行性 → 补齐隔离用例并运行现有 CI → 真正 Sealos ABI 1 导入回读 → 文档同步。

执行过程中若出现现有 Node Worker 又把具体失败统一为 `PREFLIGHT_FAILED`，优先使用直接预检定位，不在本次扩展成日志平台或重构错误体系。

## 执行记录（2026-10-05，尚未验收完成）

- 开发 worktree：`/Users/tang-codeing/.codex/salestools-landlock-abi1`，分支 `fix/landlock-abi1-compatibility`，基线 `3e38eaa`。原 checkout 的无关未提交文档未改动。
- 已实现最小 ABI 权限选择及 seccomp 补偿，新增 ctypes 边界测试、真实 Linux 文件保护探针及 hardened PDF/PNG 解析检查；核心修改仍为两个文件。
- 本地 macOS 验证命令：`PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python python3 -m unittest discover -s python/tests -p test_sandbox.py -v`。当前 14 项测试中 4 项通过、10 项因真实 Linux 要求跳过，不能视为 Linux 或 Docling 验收通过；`git diff --check` 通过。
- `LegacyParsingTests` 由现有全量 pytest 收集。打包脚本默认只运行快速 `SandboxTests`，维持生产门禁现有 60 秒限制；生产镜像中的解析可行性应显式运行 `contact-sandbox-tests.py LegacyParsingTests -v`，不能声称默认门禁已执行重解析检查。
- 用户已授权提交、推送测试分支及运行 CI；代码提交 `5bb596e6ea0b2efd0fa89b203b4058ecf6906c6c` 已推送，远程运行：[37405287175](https://github.com/tang9-c/salestools/actions/runs/37405287175) 最终为 `success`，已核对 tested SHA。类型检查、Rust、服务和镜像构建、浏览器集成及现有生产容器门禁全部通过。
- 远程 Python：37 项及 41 个 subtests 通过，无跳过，包含新内核上 ABI 1 策略的 hardened PDF/PNG 可行性；Vitest：63 个文件、1263 项通过。生产容器：13 项快速沙箱测试及 hardened PDF、资源和后代进程清理门禁通过，未放宽原有容器隔离。
- 原有远程 CI 已完成，但生产镜像中的 `LegacyParsingTests` 尚未被显式调用，因此任务 1 的生产镜像 ABI 1 策略解析可行性仍未完整验收。任务 3 的真正 ABI 1 节点隔离和导入回读也未完成；未更新文档为“已支持 ABI 1”。
- 2026-10-06：用户授权合并及发布，`main` 已快进至 `5bb596e` 并推送；版本 `v0.5.3` 已发布，[发布运行 37445085512](https://github.com/tang9-c/salestools/actions/runs/37445085512) 成功，amd64/arm64 构建及烟测均通过。GHCR 的 `v0.5.3` 与 `latest` manifest 摘要为 `sha256:0237dc514e7b284b30a01abd15f16827ffdd2db81f7974e17c02bb21dbcb4873`。
- 未修改 Sealos。本机 Kubernetes 未配置 context，后续真实 ABI 1 节点验收需用户协助；版本发布不代表该节点验收已完成。
- 独立只读代码审查未发现阻止进入远程验证的代码缺陷。仍需显式验证生产镜像解析入口；runtime 授权和兄弟文件 `ftruncate` 的逐目标测试覆盖存在细节缺口，不据此宣称全部组合已验证。
