# 真实导入失败：证据与排查记录

日期：2026-10-01。来源：用户提供的六次线上导入记录；尚未取得原始 HTTP 响应、部署 SHA、准确测试时间或容器日志。本文不把用户报告中的推断当作已验证根因。

## 已报告的现象

- 多次 PDF 上传取得 file_id，后续导入未达到 ready_for_review。
- 前几次任务为 failed、version=3、warnings=[]，候选与处理块列表为空。
- 换 ASCII 文件名后仍失败；合成极简 PDF 也失败。
- 后几次出现 processing，随后 MCP 返回 no healthy upstream；search_contacts 同样受影响。
- 尚无成功确认入库证据。上传成功只证明上传接口接受文件，不能证明联系人已入库或文件被永久保存。

## 代码核查发现

### 1. 重启恢复遗漏失败原因：确定的诊断缺口

`rust/contact-graph/src/import_recovery.rs` 的 recover_import_jobs 只将 queued/processing 改为 failed 并递增 version，没有更新 data 中的 warnings。正常状态顺序 queued(v1)→processing(v2)→重启恢复 failed(v3)，可以产生用户报告的 failed(v3)/warnings=[]。

`src/index.ts` 在服务启动时调用此恢复逻辑。相对地，`src/contacts/import-service.ts` 的普通任务失败路径写入 warnings:[IMPORT_FAILED/IMPORT_TIMEOUT/IMPORT_CANCELLED]。

结论：代码确定存在“重启恢复失败无原因码”的诊断缺口；这次线上失败是否走了该路径，仍须部署与重启日志确认。不能仅因状态吻合宣称已证明发生 OOM 或重启。

### 2. 中文文件名：已报告乱码，尚未证明导入因果

上传接口使用 Busboy，未配置 defParamCharset。上传存储把文件写入以 file_id 为名的临时路径；解析器接收此路径和 MIME 对应类型，不使用中文文件名作为磁盘路径。文件名仍进入来源元数据和后续提取，因此乱码应单独核对原始 multipart 头与响应。

ASCII 文件名重试仍失败，削弱了“乱码是唯一根因”的假设；不能用改名掩盖服务故障。

### 3. no healthy upstream：可用性故障，原因未定

记录表明故障范围超过单次导入。该字符串未出现在应用源码中，不能直接归因于模型、OCR 或索引服务。优先核对入口网关、应用 Pod 的重启次数/退出码/探针事件，以及 worker 的资源与退出记录。

### 4. 既有 CI 修复与线上版本必须区分

GitHub Actions run 36704210079，tested SHA d965bdbd2b73683b7585077e50b531fb2127f65f，两个 job 均 success，包括完整 Vitest、真实硬化 HTTP 导入与生产容器解析门禁。已知修复包括解析线程上限与精确运行时只读许可。

链接：https://github.com/tang9-c/salestools/actions/runs/36704210079

这只能证明该提交在 CI 环境通过，不能证明线上部署包含该修复或线上资源/内核/模型配置相同。

## 下一步：单次、可关联的排查

1. 获取测试准确时间/时区、部署 SHA 与镜像摘要；保留一条 failed 任务的脱敏原始响应。
2. 按时间关联入口网关、应用与 worker 日志，以及重启/OOM/探针事件。日志不包含凭证或简历正文。
3. 若确认服务重启，先定位重启原因，再判断任务 failed 是否来自启动恢复；若未重启，核对部署版本与状态写入路径。
4. 仅在授权的非生产环境使用一份合成 PDF 复现，不重复上传真实简历，不部署临时诊断到生产。
5. 证据确定后才提交最小修复：恢复原因码与实际故障分别处理，不新增诊断平台，不放宽隔离来取得通过结果。

以上为最初只读排查记录；当时未构建、未修改业务代码、未请求线上接口、未部署。随后用户授权的修复与验证见下文。

## 修复执行约束

用户已授权执行修复。复用现有隔离 worktree、功能分支及远程 CI；禁止本地构建、native 编译、容器构建。使用 debugging-strategies、TDD、subagent-driven-development 和 ponytail 的最小修复流程。不改沙箱、资源上限、上传鉴权、确认入库行为，不新增依赖或重试平台，不操作线上资料或部署。

### Task 1：修复可证实的诊断和文件名缺陷

- [x] 先补充原重启恢复测试：queued/processing 恢复 failed 时携带 `IMPORT_INTERRUPTED`，版本仅增一次；重放保持幂等，ready/committed/已 failed/cancelled 不受影响，保留已有 payload 与合法 warnings 数组。
- [x] 在远程既有 workflow 看到 Rust 原代码因缺少上述原因码而失败，再做最小生产修复。未在本地 cargo test/build 或使用旧 binary 证明新 Rust 源码通过。
- [x] 使用原上传接口及合成内容复现中文 multipart 文件名乱码，采用既有 Busboy 的 UTF-8 参数解码能力修复，保留 filename* 标准行为、ASCII 名称、路径剥离及上传安全检查。本地解释器测试不触发 native 编译或页面打包。
- [x] 根因已确定的缺陷之外未添加诊断体系，不把 no healthy upstream 的线上根因写成已修复。
- [x] 先前临时诊断已删除；提交最小修复，范围审查后普通 push 至原功能分支。完整原 workflow 为 success，tested SHA、run URL 与实际结果如下。
- [x] 更新本文修复状态；部署版本与真实宿主验收仍须用户提供环境证据。

完成标准：两个复现测试有 red/green 证据，最小补丁审查通过，远程完整 gate 成功；线上可用性故障仍按实际证据单独报告。

## 修复结果

2026-10-01：代码修复及远程验证完成，尚未部署线上。

- 有效 Rust red：[run 36958868966](https://github.com/tang9-c/salestools/actions/runs/36958868966)，SHA `c05ff0b8c25234513f46dede30d7e8be5c670e9f`。原恢复测试因实际 warnings=[]、期望 IMPORT_INTERRUPTED 而失败。初版测试 payload 使用了不支持字段，已纠正为合法 payload 后取得此有效失败证据。
- 中文文件名 red：原真实上传接口对原始 UTF-8 中文及路径中的中文解码错误；ASCII 与 filename* 用例通过。修复后上传测试文件完整 13 项通过，未本地构建。
- 最终 tested SHA：`34c5965395c1ced9b90898ec98d498af2620c354`；[完整 run 36959619511](https://github.com/tang9-c/salestools/actions/runs/36959619511) 两个 job 均 success。Rust 原套件与新增恢复边界回归通过；Python 33 项、30 子测试且零跳过；Vitest 62 文件、1261 项通过；类型检查、服务端/页面构建、生产镜像及 hardened PDF/资源/清理门禁通过。编译和打包均在远程 runner。
- 业务仅修改 `rust/contact-graph/src/import_recovery.rs` 和 `src/mcp/http-app.ts`，另外两份测试覆盖回归。范围审查、修复复审和最终审查通过，最终无未解决代码问题。
- 实施裁决：旧数据的非数组 warnings 按当前 get() 已有语义规范为 [] 再追加原因码，避免整批恢复事务失败。代价是丢弃无效 warning 字段内容；合法数组与其他 payload 不丢失。字符串、对象、数值、布尔、null 和数组均有恢复回归覆盖。
- 保留原功能分支与 worktree，不合并、不部署。线上 no healthy upstream 的具体根因仍待部署 SHA、准确测试时间、应用/worker 日志及重启/OOM/探针事件；本轮代码通过不等于线上故障已解决。
