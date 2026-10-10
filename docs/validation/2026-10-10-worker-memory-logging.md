# Worker OOM 诊断日志

## 本轮改动

Node 解析进程管理器在启动、Python 阶段切换、退出时记录 JSON，并在子进程运行期间每 5 秒采样一次。包含 UTC 时间、operation、文件 UUID、PID、阶段、耗时、Node RSS、直接 Python 子进程的 RSS/HWM，以及 cgroup v2 memory.current/peak/max 和 memory.events 的 OOM 计数。缺失的内核计数省略，不伪装为零。退出及管道关闭时清理定时器。

Python 阶段包括预检、Docling 导入、DocumentConverter 构造、convert 调用及文本块生成。阶段标记使用原始 stderr，不受转换器的 stdout/stderr 重定向影响；父进程只转发固定白名单阶段，不转发原始库日志、异常文本、文档正文或路径。

注意：converter_initialized 仅表示 DocumentConverter 构造完成，不证明所有模型已加载；延迟模型加载和页内 OCR/布局/表格推理仍包含在 conversion_started 到 conversion_completed 之间。本轮没有对第三方内部方法打补丁。

## 使用

部署包含改动的新镜像后，保留原资源配置，仅运行一个导入任务：

```sh
kubectl logs -n ns-ufdahkjt salestools-0 -c contact-worker --timestamps -f
```

发生重启后读取前一个容器：

```sh
kubectl logs -n ns-ufdahkjt salestools-0 -c contact-worker --previous --timestamps --tail=500
```

用 file_id 与主服务 contact_import 日志关联；preflight 和 parse 是不同 operation，不应把预检计为重复解析。cgroup 计数及 memory.peak 为容器范围累计数据，不是某个任务的独占峰值；Python RSS 不包含其后代进程，容器内存还包含文件缓存等。SIGKILL 无法保证输出最终日志，使用最后一次采样及 Kubernetes 的退出记录结合判断。5 秒间隔也可能错过短暂峰值。

## 验证与边界

- 20 个定向 TypeScript 测试通过，包含阶段标记转发、未知标记拒绝、计数读取、退出/取消/超时与清理路径。
- 5 个 Python 诊断测试通过，包含 stderr 重定向下的阶段输出和日志输出失败不影响处理。
- tsc --noEmit 与 git diff --check 通过。
- 未执行本地构建、完整 Docling 解析或部署；Linux cgroup 实际采样与真实 PDF 的新日志仍需远程验证。
