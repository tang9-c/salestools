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
- 完整远程 GREEN：[37486503634](https://github.com/tang9-c/salestools/actions/runs/37486503634)，tested code SHA `0829d2379d849cd3d077cfbcd593761cb9bf2912`。Rust 全量通过，TypeScript 1277 项/65 文件通过，Python 40 项及 41 子测试通过；生产容器真实 Linux 沙箱门禁通过，无发布或部署。
- 此次真实 Rust bridge 持久化测试使用合成上传元数据和确定性的外部解析失败，不等于真实简历解析成功。旧挂起任务由现有启动恢复逻辑标记 `IMPORT_INTERRUPTED`，不伪造历史解析诊断。

## Docling 定位边界

- 已按 `python/uv.lock` 的 URL 下载只读源码包并核对 SHA256：`docling-slim 2.130.0` 为 `913043ee069eb4f107d47ebfca8bdbfbfd7ec84160a7193b7260777e3adbea19`，`docling-parse 7.22.0` 为 `b102834ec62c44d3df52ec5a125247cb776472c13cdcf9683cade8f6094af892`。未安装或执行本地原生构建。
- 精确源码对应用户日志的 `document_converter.py:868`：只有 `pipeline_started` 为 false 时才调用清理。排查重点是流水线初始化前/期间；`unload → has_tasks` 清理异常可能掩盖先前异常，不足以断定 PDF 损坏。
- `pdf_parser.py:1668` 的 `has_tasks` 会在首次调用时启动原生工作线程。线程创建/资源问题属于候选原因，尚不是已验证根因。
- 原诊断仅追踪 `__cause__`；现补充 `__context__`，仍最多四层、每层四帧，只保留安全程序元数据。
- Node 收到解析错误后会主动终止进程组，因此此处 SIGKILL 不能单独作为 OOM 证据。未调整沙箱、资源限制或替换 Docling 后端。
- 必须部署本次修正并重试同一真实简历，才能获取被遮住的初始化异常并确认底层原因；不将合成 PDF 的 CI 通过描述为真实简历导入成功。

## 2026-10-07 真实简历复测

- 站点：`https://oojyeijszmwy.sealosbja.site`。健康检查 200，MCP 初始化成功，实际工具为 `import_contacts` 与 `get_contact_import`。服务自报版本仍为 `0.1.0`，不能据此确认两个容器镜像标签；本次未读取 Kubernetes 镜像配置。
- 文件：用户指定的 PDF，162813 字节、5 页、未加密。只上传与读取预览，未调用 `commit_contact_import`，未输出简历全文或凭据。
- 上传 201，耗时 1264ms。file_id：`8b3bdcc9-3cd5-4d2e-86bd-9be805a62252`。
- import_id：`ci_1ab304e32e6d43a19563b4af199f81e4`；operation_id：`real-resume-test:9141ebe4-7f08-4366-884f-f26fee981a68`。
- 2026-10-07 12:56:28 UTC 提交；12:56:38 UTC 观察到 `failed / version=3`，候选为 0。约 10 秒是轮询观察耗时，不是精确解析耗时。12:57:35 UTC 再次读取仍为相同失败终态，失败持久化已在真实服务链路验证。
- 安全失败信息：`stage=parse / code=CONVERSION_FAILED`，保存了四层异常；原先被清理异常遮住的链路现在可见：`_init_models → layout_object_detection_model.__init__ → transformers_engine.initialize → core_model_loading.spawn_materialize → ThreadPoolExecutor.submit → _adjust_thread_count → threading.start`。
- 结论：真实导入仍未通过；布局模型加载时在线程启动路径发生异常。具体为何无法启动线程（线程/进程额度、虚拟内存、容器限制等）仍需运行环境证据，不能单凭该栈断定 OOM，也不能归因为简历文本或采购模型。
- 未修改业务代码、部署、沙箱或资源限制。后续优先核对 worker 的加载并发及资源约束，而不是更换平台或放宽沙箱。
