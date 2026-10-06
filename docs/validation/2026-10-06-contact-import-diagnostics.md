# 简历导入第一阶段诊断

范围：恢复失败可定位性；不改变沙箱、部署结构、任务状态或确认入库规则。真实 `IMPORT_FAILED` 根因仍待诊断版本部署后重试确认。

## 使用方式

- `get_contact_import` 新增 `failure`：阶段（parse/extract/validate/persist）、白名单错误码、固定描述和可选安全诊断。历史无记录任务返回 null，不猜测历史根因。
- 按 import_id 查主容器 `contact_import` JSON 日志；按 file_id 查 `contact_import_cleanup`；worker 错误记录 `contact_worker_failed`。
- 解析诊断仅含异常类型、errno、Python 模块名/函数/行号、退出码/信号及清理错误码；模型失败可保留 HTTP 状态和安全原因码。SIGKILL 不代表已确认 OOM。
- 不记录异常消息、简历正文、模型响应、完整路径或凭据；不增加数据库表和自动重试。
- 原始失败与清理失败分别保留；日志回调故障不得阻止失败保存或任务收尾。

## 已验证与待验证

- 本地 red：原实现的两个新增阶段/失败测试均因 failure 缺失失败；修复后通过。
- 本地 green：108 项 TypeScript 相关测试、2 项纯 Python 诊断测试、类型检查与 diff 检查通过。包含 Python 子进程→stderr→Node、Unix IPC、隐私、大噪声、日志故障与旧任务兼容回归。
- 完整构建、native、真实 Linux 沙箱及容器门禁只在远程 CI 执行；结果另行记录。
- 用户更新主服务和 worker 为同一诊断镜像后，重试已授权真实简历，仅获取预览；不自动确认入库。部署前不能声称本次真实失败已经修复。

## 真实失败后的持久化修正

- 真实任务 `ci_1de0a924b5f541068d60d514eb06abd8` 的用户日志证明：解析在 6.9 秒后失败、文件已清理，但持久化状态仍为 processing。不是模型仍在运行。
- 前次补丁只增加 TS `failure`，遗漏 Rust `valid_import_data` 白名单；队列又吞掉终态保存异常。远程回归 [37485119048](https://github.com/tang9-c/salestools/actions/runs/37485119048) 在真实 Rust 存储上复现 `VALIDATION_ERROR / Import job contains unsupported data`。
- 修正允许有界安全失败元数据，不存异常消息或路径，不新增表；终态保存异常单独记录 `persist / IMPORT_STATE_WRITE_FAILED`，原始失败与清理流程仍保留。
- 回归包括真实服务→队列→Rust bridge→SQLite→重启读取，不再只依赖宽松存储 mock。Python 隐式异常链、图存储错误码及日志隐私也有回归。

## Docling 定位边界

- 已按 `python/uv.lock` 的 URL 下载只读源码包并核对 SHA256：`docling-slim 2.130.0` 为 `913043ee069eb4f107d47ebfca8bdbfbfd7ec84160a7193b7260777e3adbea19`，`docling-parse 7.22.0` 为 `b102834ec62c44d3df52ec5a125247cb776472c13cdcf9683cade8f6094af892`。未安装或执行本地原生构建。
- 精确源码对应用户日志的 `document_converter.py:868`：只有 `pipeline_started` 为 false 时才调用清理。排查重点是流水线初始化前/期间；`unload → has_tasks` 清理异常可能掩盖先前异常，不足以断定 PDF 损坏。
- `pdf_parser.py:1668` 的 `has_tasks` 会在首次调用时启动原生工作线程。线程创建/资源问题属于候选原因，尚不是已验证根因。
- 原诊断仅追踪 `__cause__`；现补充 `__context__`，仍最多四层、每层四帧，只保留安全程序元数据。
- Node 收到解析错误后会主动终止进程组，因此此处 SIGKILL 不能单独作为 OOM 证据。未调整沙箱、资源限制或替换 Docling 后端。
- 必须部署本次修正并重试同一真实简历，才能获取被遮住的初始化异常并确认底层原因；不将合成 PDF 的 CI 通过描述为真实简历导入成功。
