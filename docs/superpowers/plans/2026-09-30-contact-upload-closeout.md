# 联系人上传最小收尾方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解决现有验证阻塞，验收已经完成的上传功能，不新增产品功能或隔离系统。

**Architecture:** 保持上传→完整预览→明确确认的现有实现；继续使用现有解析沙箱和 worker 容器。只修复已证实的 CI 运行环境问题，再运行现有测试和最小真实宿主验收。

**Tech Stack:** 现有 TypeScript、Python、Docker Compose、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-09-29-contact-upload-minimal-design.md`；其中 2026-09-30 收尾决定取代旧的“替代隔离部署必须先完成”要求。

## Global Constraints

- 禁止本地构建、native 编译、页面打包和启动包含构建的 dev；构建只在远程 CI。
- 不新增功能、依赖、服务、队列、存储、通用抽象或测试平台；不重写沙箱。
- 保留现有 Landlock/seccomp、资源限制、无网络、只读根、cap_drop 和 no-new-privileges；不得提高限制、以 root 运行解析探针、跳过安全探针或使用 test-only 来通过门禁。
- 不改上传/预览/确认协议和 CLI/MCP 行为，不改变用户确认及最终写入前的权限、版本检查。
- 只修复已复现且阻塞现有流程的问题；与本轮无关的重构不纳入。
- 使用合成 PDF/图片、临时数据库和无生产凭据的测试环境；本方案不授权生产部署、合并或操作真实联系人。
- 未运行的验收明确记为未验收；模拟宿主结果不能代替真实宿主。

## 当前基线

- 功能代码已完成，测试代码提交 `ea33e523502f29ed05ef41445cf6b2817576f07f`，后续 `f6892c8` 仅记录结果。
- 针对性回归、no-emit、两轮审查已通过；不重新执行已完成的业务改造。
- [远程运行 36667346533](https://github.com/tang9-c/salestools/actions/runs/36667346533)：类型检查、Rust 编译/测试、服务端与上传页面构建通过。
- Python 2 failed / 32 passed / 29 subtests passed；两个探针在 `os.fork()` 时出现 EAGAIN。全套 Vitest 和生产容器门禁因此未运行。
- 同 UID 进程占用与 `RLIMIT_NPROC=32` 是待核实的根因，不把环境假设直接当成已修复事实。

## 文件范围

| 文件 | 用途 |
| --- | --- |
| `.github/workflows/contact-upload-validation.yml` | 唯一预期的执行配置改动：Python 安全探针的运行身份及必要诊断 |
| `python/tests/test_sandbox.py` | 复用现有真实 Linux 探针；默认不修改测试断言 |
| `python/contact_worker/sandbox.py` | 保持现有安全实现，不属于预期修改范围 |
| `docs/QUICKSTART.md`、本方案 | 更新当前验收状态和证据 |

### Task 1：修复 Python CI 运行环境

**Interfaces:** Python 套件继续输出 JUnit XML；Linux 探针必须真实运行且零跳过。生产解析配置与业务接口不变。

- [ ] 保存失败 run 的完整日志，确认失败用例仍为 `test_foreign_prlimit_cannot_change_same_uid_sentinel` 和 `test_syscalls_and_descendants_remain_sealed`，不把其他错误归入同一原因。

```bash
rtk proxy gh run view 36667346533 --log-failed
```

- [ ] 在远程 Python 测试步骤增加最小诊断，记录 UID、同 UID 线程数和进程限额，不打印环境变量或凭据。在线程数接近/超过 32 的普通 runner UID 下复现失败，作为修复前证据。

```bash
id
ps -eLf --no-headers | awk -v account="$(id -un)" '$1 == account { count++ } END { print "same-UID threads:", count+0 }'
python/.venv/bin/python -c 'import os,resource; print("uid",os.getuid(),"nproc",resource.getrlimit(resource.RLIMIT_NPROC))'
```

以上块是远程 workflow 中的 shell 内容，不在本地执行。它不更改任何限额。

- [ ] 若诊断支持同 UID 占用根因，在现有 job 内为 Python 测试创建专用非 root 用户；使用相同依赖、代码和模型，不增加新 job 或镜像。保持全套测试，而非只挑两个失败探针。最小修改方向如下：

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$(id -gn)" contact-ci
ci_report_dir=$(mktemp -d "$RUNNER_TEMP/contact-python.XXXXXX")
sudo chown contact-ci "$ci_report_dir"
# 先确认专用用户能读取既有依赖、测试文件及离线模型；不广泛修改权限。
sudo -u contact-ci test -x "$GITHUB_WORKSPACE/python/.venv/bin/python"
sudo -u contact-ci test -r "$GITHUB_WORKSPACE/python/tests/test_sandbox.py"
sudo -u contact-ci test -r "$HF_HOME"
sudo -u contact-ci -- env -i PATH=/usr/bin:/bin \
  HOME="$ci_report_dir" PYTHONPATH="$GITHUB_WORKSPACE/python" \
  HF_HOME="$HF_HOME" XDG_CACHE_HOME="$XDG_CACHE_HOME" \
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 \
  TOKENIZERS_PARALLELISM=false \
  "$GITHUB_WORKSPACE/python/.venv/bin/python" -m pytest python/tests -q \
  --junitxml="$ci_report_dir/contact-python.xml"
```

- [ ] 保留既有 JUnit 零跳过检查，由专用用户读取其所有的私有报告目录，避免扩大目录权限。记录实际非 root UID，确认安全探针的父进程、哨兵和被测子进程仍为相同 UID；不能通过把它们拆成不同 UID 绕过测试目的。
- [ ] 推送现有功能分支，运行既有远程 workflow。必须看到两个探针和完整 Python 套件通过；若同 UID 假设被证据否定，先定位实际原因，不继续叠加 workaround。
- [ ] 对 workflow 差异做一次范围审查：生产代码、限额和安全断言均不变。提交最小修复，记录 tested SHA、命令和 run URL。

**完成标准：** 原失败探针及全套 Python 在非 root、真实 Linux、原有限制下通过，JUnit 无跳过。没有新增产品代码。

### Task 2：跑通原有远程门禁

**Files:** 复用 `.github/workflows/contact-upload-validation.yml`、`compose.contact-upload.yaml` 和现有 smoke/test；结果写回本方案。

**Interfaces:** 使用 Task 1 修复后的同一 tested SHA；两个既有 job 全部通过，无跳过安全探针。

- [ ] 复用 Task 1 已触发的完整 run，不因阶段已通过而重复启动构建。
- [ ] 检查原有类型检查、Rust 测试、服务端/页面构建、Python、完整 Vitest 均通过。
- [ ] 检查原有 production-sandbox job 通过：真实内核限制、正常 PDF、资源限制、取消和清理；不新增一套验证工具。
- [ ] 若失败，仅修复该 run 已证明的阻塞；先有失败证据，再做最小修复并跑受影响 gate。与功能无关的改善延后。
- [ ] 在本方案和 QUICKSTART 记录 tested SHA、run URL、实际结果及剩余验收，不用旧 SHA 的结果证明新代码。

```bash
rtk proxy gh run view RUN_ID --json headSha,status,conclusion,jobs,url
rtk proxy git diff --check
```

`RUN_ID` 使用 Task 1 实际触发的 run 编号，不创建额外测试服务。

**完成标准：** 既有完整 workflow 为 success。若安全验证证明当前隔离不满足要求，记录具体缺陷再讨论替换；“维护起来复杂”本身不触发重写。

### Task 3：一次最小真实宿主验收

**Files:** 本方案记录；不创建验收平台或新增自动化框架。

**Interfaces:** Task 2 通过的 tested SHA；用户提供或授权的非生产 HTTPS 测试环境。缺少环境时只标记未验收，不自行使用生产地址。

- [ ] 记录部署 SHA、服务版本、ChatGPT/Codex/手机浏览器版本；测试环境使用合成资料与临时联系人库。
- [ ] ChatGPT MCP App：选择一份合成 PDF，上传→看到完整预览→明确点击确认→查询到一次导入结果；在点击前确认未入库。
- [ ] Codex 外部页面：完成同一流程，刷新页面后按既有 Cookie 行为恢复或给出重开提示，不能重复入库。
- [ ] 手机：检查拍摄名片能否提供图片并完成同一流程；若该宿主不支持 capture，记录限制及已有选择图片入口，不宣称拍照支持已经通过。
- [ ] 每个宿主保留一份脱敏结果，记录成功或实际失败；只修复真实阻塞，不扩展相机兼容功能。

**完成标准：** 三个已约定入口均有实际环境/SHA/结果证据；不支持的能力明确限定，不通过删除验收来宣称支持。验收通过只表示具备后续发布决策依据，不自动合并或部署。

## 停止条件与最终交付

现有功能保持稳定、完整 CI 通过、约定宿主完成上述验收后停止开发。交付修复提交、验证链接及验收记录即可；不新增替代隔离项目、平台建设或重构阶段。

## 方案状态

2026-09-30：正在执行。CI 环境修复已完成实现与独立任务审查，最终 SHA 完整远程门禁待运行；真实宿主因尚未提供非生产环境信息待验收。没有修改业务代码、安全限制或执行本地构建。

### CI 根因与修复记录

普通 runner UID1001 的线程数在两次诊断分别为50、46，两个原探针均在原定 `RLIMIT_NPROC=32` 下复现 fork EAGAIN。专用 UID999 下父进程、哨兵、被测进程及 fork 后代保持相同 UID，沙箱上限仍为32；[run36690331691](https://github.com/tang9-c/salestools/actions/runs/36690331691) 的 Python 本体33项/30子测试通过，但报告读取权限导致步骤失败，后续门禁未运行。最终修复由同一 UID 读取私有报告，保留零跳过断言。

为避免新增依赖，测试用户复用既有 runner 主组以穿过750的 home 目录；代价是可信 CI harness 继承该组已有读取/遍历权限。生产 UID/GID、Landlock、seccomp 与限额不变，CI 无生产凭据。一次临时 ACL 尝试已取消并从最终配置移除。最终 workflow 相对收尾前仅 +22/-3，无新增依赖或测试平台。
