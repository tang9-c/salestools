# 企业与联系人资料复用验收记录

记录日期 2026-10-12。此记录不表示发布、部署或整体验收通过。

## 已有远程证据

通过的早期 tested SHA 为 `03b325442d75f9c1564bc3b5ea0b517551bf199a`。[运行 38266640005](https://github.com/tang9-c/salestools/actions/runs/38266640005) 的 `native-and-browser`、`production-container` 两个 job 均为 success（2026-10-12）。该记录验证当时提交，不能覆盖之后的 Task 8 修正和 Task 9 新测试。

随后 tested SHA `83d7ad2cb5bfa84c5505866c19af1e52fdb9349b` 的[运行 38274610373](https://github.com/tang9-c/salestools/actions/runs/38274610373) 已完成，`native-and-browser` failure，`production-container` skipped。不能称为通过。失败调查与受影响检查由控制器继续；本任务没有 dispatch 或取消 workflow。

Task 9 提交的最终 tested SHA 与完整 gate 结果待填写。必须在同一最终 SHA 上通过两个 job。CI 使用 Ubuntu 24.04、Node 24、锁定依赖及对应 Chromium；版本和日志以运行证据为准。workflow 为只读权限、临时数据库与合成文件、空 CI env，不发布或部署，不读取生产密钥。普通容器沿用非 root、只读根、cap_drop、no-new-privileges、默认 seccomp 和资源限制；不使用应用安装的 Landlock/seccomp 或 AS/NPROC。Compose 无网络不证明 Sealos 同 Pod 禁网。

## 新增合成贯通场景

`tests/company-context-integration.test.ts` 在真实临时目录创建原生 `ContactGraphClient` 与图谱 SQLite；业务资料使用另一临时 SQLite 和真实 ProfileRepository、AssessmentRepository、CompanyLinkRepository。缺失原生二进制直接失败，不 fake、不 skip。原生二进制由远程 workflow 构建；本机未执行该测试或任何 native/build/full-suite。

fixture 包括一个合成企业画像、两个同企业组织节点（第一个有实际 PropertyValue、名称和代码证据自动确认，第二个通过 authenticated MCP `link_company` 人工确认）、一个人物、一个客户项目、两个已完成报告。两条 worksFor 都指向同一人物；memberOf 与 clientOrganization 使用真实原生角色／端点验证和明确成员／客户 quote。任职状态为 unknown，不声明现任。反例另外使用学校、坏代码组织、身份变化和另一主体的合成报告。没有真实简历、个人身份或生产账号。

MCP Client 通过现有 InMemoryTransport 与 buildMcpServer 实际注册通信。认证 actor 为合成 clientId，未授权调用失败；没有生产 Token。六个入口分别为 get_company_profile、search_contacts、get_contact、ask_contacts、ask_company、get_assessment_report。画像缓存和报告读取使用真实 CompanyProfileService／AssessmentService；问答使用真实 ContactAnswerService／CompanyQuestionService，只有企业问答模型返回为合成响应，其可引用材料和引用校验来自真实服务，外部 gateway 若被调用会报错。

测试断言涵盖人物／项目去重计数、两组织一致报告数、独立历史分页、实际画像和客户项目引用、数据库报告原文前后完全相同、未授权关联、稳定操作重放与参数冲突、解除抑制自动匹配、实际版本校验、身份 Hash 变化、坏代码候选、学校不作雇主、真实记录分页与 20 条截断、关闭图谱来源失败、图谱关闭配置与未知统计。另一主体报告明确验证 ask_company 拒绝，而独立 get_assessment_report 保留原读取权限。

图谱 App 的额外 Chromium 用例位于 `tests/contact-search-graph-browser.test.ts`：保留第一组织的旧报告动作，切到第二组织目录后再触发，断言不会读取不属于当前目录的报告 ID。已有 Task 8 Chromium 用例还覆盖候选隐藏画像／报告、11 条历史分页、恶意报告字符串按文本显示、并发节点切换与报告分页取消。这些为模拟 MCP 宿主的 Chromium 自动检查，不是 Codex／ChatGPT 宿主验收。

## 本地允许的检查

Task 9 新增测试与文档的 `npm run typecheck`（tsc --noEmit）通过；`git diff --check` 结果在 task-9-report.md 记录。文档参数／边界的纯文本检查仅核对内容与代码 schema，不验证运行行为。原生集成与 Chromium 新用例的实际结果目前待远程最终 gate，不能据类型通过推断运行通过。

## 真实宿主验收

| 环境 | 版本 | tested SHA | 实际结果 | 脱敏证据 |
| --- | --- | --- | --- | --- |
| Codex 实际宿主 | 未记录 | 未执行 | 未执行：尚未获得可用测试 MCP 环境；已向用户询问环境，未收到答复 | 无 |
| ChatGPT 实际宿主 | 未记录 | 未执行 | 未执行：尚未获得可用测试 MCP 环境与宿主会话 | 无 |
| 手机相机／外部页面 | 未记录 | 未执行 | 未执行：缺少真实设备与可用测试环境 | 无 |
| Chromium 模拟 MCP 宿主 | CI 锁定版本，以 run 日志为准 | 03b325442d75f9c1564bc3b5ea0b517551bf199a | 早期完整 gate 通过；83d7ad2 后续运行失败；Task 9 新用例待最终 gate | 上述运行日志；不是实际宿主证据 |

获得环境后，每个实际宿主使用脱敏合成企业执行组织搜索 → 展开 → 点击组织 → 历史翻页 → 报告阅读 → 解除后重查，逐步记录版本、tested SHA、实际结果和脱敏截图／日志路径。未执行的项目不能填通过；最终 CI 通过也不能替代实际宿主验收，因此当前功能未标记整体验收通过。
