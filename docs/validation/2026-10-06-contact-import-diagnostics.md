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
