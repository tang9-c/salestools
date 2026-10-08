# Sealos 五页真实简历导入验证

## 测试范围与边界

- 用户授权使用本地真实 PDF 测试远端 `https://oojyeijszmwy.sealosbja.site/mcp`，并记录发现的问题。
- 文件大小 162813 字节，5 页；SHA-256：`47f265adaa471d09b4faf1436d08a2fa214c3b66d5c2b1b1b63d5c782c4d1c50`。原文件未修改。
- 使用本地 Poppler 文本提取及全部 5 页渲染建立对照：4 段任职、1 段教育、10 个项目标题，另抽取 25 组原文技术词作为后续覆盖检查清单。此步骤不是远端 Docling 成功的证明。
- 测试客户端为本机 Node.js v22.23.1，通过真实 HTTP 和 MCP SDK 调用；未模拟上游或解析器。
- 最近发布的 `v0.5.9` 对应提交 `0921caead2f83e4a7b3835bd09710e3c520470bb`。本次没有集群访问能力，未核对实际部署的两个容器 imageID；不能断言站点已运行此版本。
- MCP 自报 `target-customer-assessment / 0.1.0`，这是协议服务元数据，不是镜像版本。
- 采用 debugging-strategies 的分层检查：上传 → 解析 → 模型提取 → 预览 → 提交 → 回读/搜索。只执行一次上传及一次导入，没有重复触发或修改远端配置。
- 本记录不保存姓名、联系方式、完整正文、原始模型响应或密钥。

## 实际结果

| 检查 | 结果 |
| --- | --- |
| MCP 连接与工具发现 | 成功，导入、预览、提交、回读、搜索工具均存在 |
| 导入前按姓名搜索 | 0 个联系人 |
| 文件上传 | HTTP 201，服务端哈希与本地一致 |
| `import_contacts` | 返回任务 ID，随后状态为 `processing` |
| 文档解析 | 失败：`stage=parse`、`code=PROCESS_EXITED` |
| 退出诊断 | `exit_code=null`、`signal=SIGKILL`、`root_code=PROCESS_EXITED` |
| 模型提取/技能补充 | 未进入，不评价本轮提取修复效果 |
| 候选预览 | `total_candidates=0`、`version=3`、`coverage_available=false` |
| 正式入库 | 未调用提交工具，没有新建或合并联系人 |
| 新 MCP 连接回读 | 仍为 `failed`，具体失败诊断保留 |
| 导入后按姓名搜索 | 仍为 0 个联系人 |
| `/healthz` | HTTP 200，JSON 响应；不代表解析子进程正常或 Worker 没有重启 |

- `file_id`：`4eb44fee-0908-4b22-8f30-2991f2d3b465`
- `import_id`：`ci_7fcee681398049f9999856160aece36f`
- 从客户端上传前计时起，约 126604 ms 首次观察到失败；首次观察到 `processing` 为 14730 ms。轮询间隔 10 秒，包含客户端准备间隔，不能当成精确解析耗时。
- 最终重新连接复核时间：`2026-10-08T09:17:30.912Z`。
- 失败结果中已处理与未处理块均为空；结合 `coverage_available=false`，表示没有可用覆盖统计，不是“全部处理完成”。

## 已发现的问题

### 1. 阻断：真实 PDF 未完成远端解析

解析进程被 `SIGKILL` 终止，没有候选，导致整个导入验收未通过。失败发生在 Ark 之前，不能归因于 JSON 解析、技能补充或联系人持久化。

### 2. 诊断仍不能区分杀进程的原因

当前返回说明进程退出方式，但未提供容器 OOM 计数、CPU 使用、实际配额或 Worker 重启情况。`SIGKILL` 本身不能证明 OOM，也不能证明内核/Sealos 能力不足。

对照当前源码的候选机制：

- `src/contacts/parser-process.ts` 默认解析墙钟上限 120000 ms，超时路径通常产生 `WORKER_TIMEOUT`。
- `python/contact_worker/runtime.py` 保留 CPU 时间上限，默认软硬限均为 120 秒；CPU 时间不是墙钟时间。
- 容器内存限制触发、外部终止等也可能出现 `SIGKILL`。

本次是 `PROCESS_EXITED` 而非 `WORKER_TIMEOUT`，需要容器事件及 cgroup 计数进一步区分，不能直接建议增加内存或取消安全限制。上述源码分析以本地版本为依据，仍需实际镜像核对。

### 3. 线上版本无法通过现有 MCP 元数据确认

MCP 版本 `0.1.0` 无法判断两个容器是否同步更新到 `v0.5.9`。此项是验证证据缺口，不等同于已证实部署错误。

### 4. 内容质量与后半程仍未验收

姓名/电话一致性、任职与教育归属、任职日期、10 个项目去重与完整性、25 组技术词覆盖、正式关系搜索、提交幂等及入库回读均未能执行。不能用“失败状态持久化成功”代替完整导入成功。

### 5. 测试客户端一次辅助错误（非产品故障）

上传已成功后，本地 Node REPL 中 `crypto` 名称与内置对象冲突，导致哈希比较辅助代码出现一次 TypeError。随后改用独立模块变量继续使用原 `file_id`，完成哈希核对并仅提交一次导入。没有再次上传或生成重复任务；此错误不归因于 MCP 或 Sealos。

## 已验证正常的部分

- 文件上传与哈希一致性正常。
- 任务没有永久停留在 `processing`，最终进入 `failed`。
- 具体失败状态可在新 MCP 连接回读；本轮未复现失败结果无法保存。
- 未生成候选时没有误提交空联系人，前后按姓名查询均为 0。

## 下一步所需最小容器证据

在 Sealos 终端执行下列只读命令，不输出环境变量或密钥：

```bash
kubectl get pod salestools-0 -n ns-ufdahkjt -o jsonpath='{range .status.containerStatuses[*]}{.name}{" image="}{.image}{" imageID="}{.imageID}{" restarts="}{.restartCount}{" previous="}{.lastState.terminated.reason}{"\n"}{end}'
kubectl logs salestools-0 -n ns-ufdahkjt -c contact-worker --since=30m --tail=100
kubectl exec salestools-0 -n ns-ufdahkjt -c contact-worker -- sh -c 'for f in memory.max memory.current memory.peak memory.events cpu.max cpu.stat pids.max pids.current pids.events; do if [ -r "/sys/fs/cgroup/$f" ]; then printf "%s\n" "$f"; cat "/sys/fs/cgroup/$f"; fi; done'
```

计数为累计值，单次读到 `oom_kill>0` 不能单独证明与该任务对应；需结合时间或复测前后增量。未来复测也应先核对两个容器镜像版本，再只改变一个已证实有问题的条件。

本轮未进行本地构建、镜像发布、部署变更或自动修复；完整导入验收结论：失败，阻断于文档解析。

## 后续容器证据及最小修复

用户随后提供的 Sealos 只读输出确认：

- 两个容器均运行 `v0.5.9`，imageID 均为 `sha256:e2eac20951d89dc8851de5c810c9917a06ffebce80c7bda7efe87a86eebc3f44`。此前的镜像版本缺口已补齐。
- 当前 Worker 日志包含启动成功和 `PROCESS_EXITED / SIGKILL`；Worker 重启计数 1、上次原因为 Error，不能仅据此将历史重启归属于该任务。
- `memory.max=4294967296`，`memory.events` 中 `max/oom/oom_kill` 均为 0；当前 cgroup 没有内存触顶或 OOM 杀进程证据。
- `cpu.max=200000 100000`，即 2 核额度；累计 `usage_usec=121230415`，约 121.23 CPU 秒；累计 CPU 限流时间约 72 毫秒。
- `pids.max=9830`、`pids.current=9`、PID 触顶计数为 0。实际 PID 上限并非 Compose 模板的 64；本次不据此调整线上配置。

累计 CPU 消耗与应用默认 120 CPU 秒硬上限接近，且没有当前 cgroup OOM 证据，高度指向应用 CPU 限制过低。但容器累计 CPU 时间不是单个解析子进程的退出用量，仍不称为已获取直接触限证明。

用户确认执行最小修复：仅将 `python/contact_worker/runtime.py` 的默认 CPU 软硬限从 120 改为 300 CPU 秒，为 2 核、120 秒墙钟期限留裕量。不新增配置，不改 Docling、120 秒墙钟超时、文件/FD/core 限制、并发或清理机制。继承的更严格限制仍取较小值，资源探针显式指定的 1 秒上限仍有效。

验证采用 TDD：新增实际子进程 `getrlimit` 检查，修改前默认模式读到 `[120,120]`，按预期失败；修改后 Python runtime 的 3 项测试通过，覆盖默认 300、继承 90 和显式 1 秒预算，以及既有环境清理、路径校验。进程监管的 8 项解释器测试亦通过，覆盖墙钟超时、取消和清理。

未进行本地构建、提交、发布或远端重新导入。新代码需经远程 Linux/容器验证并发布后，用同一真实 PDF 复测；本次仅完成代码修复及本地解释器验证，不声称真实导入已恢复。
