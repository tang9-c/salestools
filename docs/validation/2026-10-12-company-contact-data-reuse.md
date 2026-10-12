# 企业与联系人资料复用验收记录

记录日期 2026-10-12。此记录不表示发布、部署或整体验收通过。

## 已有远程证据

通过的早期 tested SHA 为 `03b325442d75f9c1564bc3b5ea0b517551bf199a`。[运行 38266640005](https://github.com/tang9-c/salestools/actions/runs/38266640005) 的 `native-and-browser`、`production-container` 两个 job 均为 success（2026-10-12）。该记录验证当时提交，不能覆盖之后的 Task 8 修正和 Task 9 新测试。

后续失败均保留为实际证据，不能称为通过：

| tested SHA | 运行 | 实际结果及修正 |
| --- | --- | --- |
| `83d7ad2cb5bfa84c5505866c19af1e52fdb9349b` | [38274610373](https://github.com/tang9-c/salestools/actions/runs/38274610373) | 1557 passed / 1 failed；旧浏览器断言依赖固定调用次数，改为等待具体旧响应并保留根节点隔离检查 |
| `3a710975654c3dc4b27c45e21d62bc4d42fd7ed9` | [38276109384](https://github.com/tang9-c/salestools/actions/runs/38276109384) | 1559 passed / 1 failed；新增双组织 fixture 的 readiness 错写总数 1，改为实际总数；跨组织报告检查保留 |
| `d7a8b01958316948e7076e8b9ee0953776ac984d` | [38279656077](https://github.com/tang9-c/salestools/actions/runs/38279656077) | 1571 passed / 3 failed；原生集成回答 stub 补齐成员与客户引用；两个既有字节预算回归由无 context 时省去跨库提示修正，原预算和断言保留 |

以上三个运行的 `native-and-browser` 均 failure、`production-container` 均 skipped。未模拟、跳过或把中间步骤通过当作完整 gate 通过。

最终功能 tested SHA 为 `16cb6f8e5c1478303af70a237ce9a266d6a0d1d9`，[运行 38280841844](https://github.com/tang9-c/salestools/actions/runs/38280841844) 已 completed／success，`native-and-browser`、`production-container` 两个 job 均 success（2026-10-12）。两项验证对应同一最终运行时代码 SHA。

已完成 job 的实际日志为 86 个 Vitest 文件、1577 项测试全部通过；Python 37 项及 3 个子测试通过；Rust 测试、服务与两份 MCP App 构建通过。环境为 Ubuntu 24.04、Node 24.21.0、Python 3.12.3、Rust 1.99.0、uv 0.9.26、Chrome for Testing 153.0.8010.12（Playwright chromium v1243），依赖使用锁定版本。workflow 为只读权限、临时数据库与合成文件、空 CI env，不发布或部署，不读取生产密钥。普通容器沿用非 root、只读根、cap_drop、no-new-privileges、默认 seccomp 和资源限制；不使用应用安装的 Landlock/seccomp 或 AS/NPROC。Compose 无网络不证明 Sealos 同 Pod 禁网。

`production-container` 的实际 job `114920093877` 完成生产镜像构建与真实 Compose smoke，日志结论为 `contact container smoke: container controls, real PDF and ordinary descendant cleanup passed`。未模拟或跳过真实容器验证；没有发布镜像或部署。

## 新增合成贯通场景

`tests/company-context-integration.test.ts` 在真实临时目录创建原生 `ContactGraphClient` 与图谱 SQLite；业务资料使用另一临时 SQLite 和真实 ProfileRepository、AssessmentRepository、CompanyLinkRepository。缺失原生二进制直接失败，不 fake、不 skip。原生二进制由远程 workflow 构建；本机未执行该测试或任何 native/build/full-suite。

fixture 包括一个合成企业画像、两个同企业组织节点（第一个有实际 PropertyValue、名称和代码证据自动确认，第二个通过 authenticated MCP `link_company` 人工确认）、一个人物、一个客户项目、两个已完成报告。两条 worksFor 都指向同一人物；memberOf 与 clientOrganization 使用真实原生角色／端点验证和明确成员／客户 quote。任职状态为 unknown，不声明现任。反例另外使用学校、坏代码组织、身份变化和另一主体的合成报告。没有真实简历、个人身份或生产账号。

MCP Client 通过现有 InMemoryTransport 与 buildMcpServer 实际注册通信。认证 actor 为合成 clientId，未授权调用失败；没有生产 Token。六个入口分别为 get_company_profile、search_contacts、get_contact、ask_contacts、ask_company、get_assessment_report。画像缓存和报告读取使用真实 CompanyProfileService／AssessmentService；问答使用真实 ContactAnswerService／CompanyQuestionService，只有企业问答模型返回为合成响应，其可引用材料和引用校验来自真实服务，外部 gateway 若被调用会报错。

测试断言涵盖人物／项目去重计数、两组织一致报告数、独立历史分页、实际画像和客户项目引用、数据库报告原文前后完全相同、未授权关联、稳定操作重放与参数冲突、解除抑制自动匹配、实际版本校验、身份 Hash 变化、坏代码候选、学校不作雇主、真实记录分页与 20 条截断、关闭图谱来源失败、图谱关闭配置与未知统计。另一主体报告明确验证 ask_company 拒绝，而独立 get_assessment_report 保留原读取权限。

图谱 App 的额外 Chromium 用例位于 `tests/contact-search-graph-browser.test.ts`：保留第一组织的旧报告动作，切到第二组织目录后再触发，断言不会读取不属于当前目录的报告 ID。已有 Task 8 Chromium 用例还覆盖候选隐藏画像／报告、11 条历史分页、恶意报告字符串按文本显示、并发节点切换与报告分页取消。这些为模拟 MCP 宿主的 Chromium 自动检查，不是 Codex／ChatGPT 宿主验收。

## 本地允许的检查

最终运行时代码的 8 个指定纯 TypeScript 测试文件共 116 passed；`node_modules/.bin/tsc --noEmit`、`git diff --check` 均通过。已通过且无后续运行时代码改动的检查未反复执行。原生集成、Chromium 与容器只在远程 gate 执行，本机未执行任何构建、native 或完整套件。文档参数／边界的纯文本检查仅核对内容与代码 schema，不验证运行行为。

## 真实宿主验收

| 环境 | 版本 | tested SHA | 实际结果 | 脱敏证据 |
| --- | --- | --- | --- | --- |
| Codex 实际宿主 | 未记录 | 未执行 | 未执行：尚未获得可用测试 MCP 环境；已向用户询问环境，未收到答复 | 无 |
| ChatGPT 实际宿主 | 未记录 | 未执行 | 未执行：尚未获得可用测试 MCP 环境与宿主会话 | 无 |
| 手机相机／外部页面 | 未记录 | 未执行 | 未执行：缺少真实设备与可用测试环境 | 无 |
| Chromium 模拟 MCP 宿主 | Chrome for Testing 153.0.8010.12 / Playwright chromium v1243 / Ubuntu 24.04 | 16cb6f8e5c1478303af70a237ce9a266d6a0d1d9 | 最终 native-and-browser job 通过，包含 Task 8／9 图谱用例 | 运行 38280841844 的 job 114917467218 日志；不是实际宿主证据 |

获得环境后，每个实际宿主使用脱敏合成企业执行组织搜索 → 展开 → 点击组织 → 历史翻页 → 报告阅读 → 解除后重查，逐步记录版本、tested SHA、实际结果和脱敏截图／日志路径。未执行的项目不能填通过；最终 CI 通过也不能替代实际宿主验收，因此当前功能未标记整体验收通过。


## 全分支综合修复验证（2026-10-12）

依据 final-review 的 I1–I4、M1–M2 和最终 CI fixture 失败进行限定修复。直接客户项目与人物经项目的路径分别校验；必要引文依赖贯穿条数预算、Ark 实际 body 字节预算和返回引用闭包。materials 关系查询按 50 个组织分批，整个共享材料读取 context 的 20 次页请求预算包含失败。职业引文先校验完整原文的主体、关系、冲突与否定/计划，再保留安全原文子串；原始证据及 get_contact 权限不改。

新增纯 TS／真实 Node SQLite 测试使用 51 条正式确认关联及原生协议大小约束 mock，并通过真实 CompanyContextService、CompanyQuestionService 和 CompanyAnswerClient 捕获实际 body；不将此 mock 当成原生验收。首次 10 个新增回归均失败；修复后指定 7 个纯测试文件 110 passed。正文 ref 新断言以原渲染实现验证 2 failed，再恢复修复。后续加强了电话／邮件完整问答返回和实际 SQLite 快照字节闭包，详见本地 `.superpowers/sdd/2026-10-12-company-contact-data-reuse/final-fix-report.md` 的命令和结果。

`node_modules/.bin/tsc --noEmit` 与 `git diff --check` 通过。以上为提交前工作树检查，不能替代最终 SHA 的原生／浏览器／容器 gate。browser open helper 等待 fixture 的实际匹配总数，保留 foreign-directory guard；本机未运行浏览器/native/full-suite/页面 bundle 或任何构建。最终远程结果见上节，实际宿主环境仍未提供，未声明实际宿主完成。

后续限定复审的两个问题已修正：原生集成模拟回答补齐材料真实依赖引用；同文件客户证据去重与项目成员依赖统一保留首条客户 ref，不把同源证据算作独立来源。真实共享服务的双组织／客户项目／成员回归先红后绿。远程发现的两项既有请求预算回归采用条件提示修正：无跨库材料时沿用原提示，有跨库材料时保留完整引用依赖说明。未改变 6144／2200 字节测试边界、主题数量断言、20 条材料／12 份档案／单份选定报告预算。最终指定 8 个纯测试文件 116 passed，最终完整远程结果见上节。

## 交付与保留事项

功能包括已有 Organization 与画像／评估的确认和候选关联、带审计的 `link_company`、共享查询与证据适配、六个资料入口复用、按需读取的图谱组织详情和独立历史报告分页。关联资料沿用既有认证权限，历史报告正文保持原样；数据通过关联读取，未把完整报告复制到组织节点。

执行分支为 `codex/company-contact-data-reuse`，工作目录为 `/Users/tang-codeing/.codex/worktrees/company-contact-data-reuse/salestools`。运行时代码 tested SHA 与后续仅文档提交区分记录；文档提交不会冒充已测试 SHA。原 checkout `/Users/tang-codeing/code/salestools` 的既有未提交改动保留，未自动合并或部署生产。仅本计划两个误跟踪的过程报告移出 Git 索引，物理恢复记录仍保留，其他计划记录未清理。

剩余验收为上表真实宿主环境接入和实际操作记录。提供环境后才能补齐实际版本、tested SHA、结果和脱敏证据；在此之前不标记整体验收通过。执行 worktree 与本计划恢复记录继续保留。
