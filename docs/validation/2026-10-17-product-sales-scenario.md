# 产品销售场景专题开发验证记录

日期：2026-10-17。基线为第一阶段本地提交 `858cca47421fa769b20856ef6ec04cbe735b3882`；该 SHA 不是本次专题的 tested SHA。本次变更在隔离分支 `codex/product-sales-scenario`；用户已授权仅提交到本地 Git，未推送、未部署或开启功能。本次提交标识以 Git 历史为准，尚无远程 CI tested SHA。

## 实施与验证边界

在原三张表、六个 MCP 工具、一个 Runner/队列/Policy 内开放 `product_sales_scenario@1`。仍由 `COMPANY_RESEARCH_ENABLED` 控制，默认关闭，没有额外专题开关。通用模板方法版本仍为 `research@1`，专题为 `research-sales-scenario@1`，共同评分版本仍为 `opportunity@1`，没有改变旧评分规则。

| 项目 | 实际状态 |
| --- | --- |
| 模板及仓库 | 真实 SQLite 验证旧快照、新分支、产品范围、模板切换、逐产品目标及幂等 |
| 规划、模型与路径校验 | 合成上游；生产模型解析与实际请求装包；七产品问题、双层校验、引用与隐私 |
| Runner 与预算 | 真实 Policy/Ark transport 的受控 fetch；网络、结构和隐私混合失败共享 final 两次实际 dispatch 上限 |
| HTTP MCP 贯通 | 真实认证 HTTP、临时文件 SQLite、生产 Runner/模型/结果生成器；上游响应受控 |
| 职业图谱 | 四类现有真实 Rust Store 用例已扩展专题模型与结果链；本机仅类型检查，尚未执行 |
| 远程完整 gate | 尚未执行，包括第一阶段仍缺少的 Rust、完整 Vitest/Python、浏览器及生产容器 gate |
| 真实上游/宿主 | 尚未执行，缺少专用授权环境及实际 tested SHA |

只运行明确选择的纯解释器测试、Node24 `tsc --noEmit` 和 diff 检查。没有运行本地 build/dev、native 编译或完整测试套件。远程验证继续使用 `.github/workflows/contact-upload-validation.yml`，现有完整 Vitest 自动发现新增专题测试，原生 binary 缺失必须失败，不添加 skip/mock 替代真实容器或原生检查。

## 已覆盖的关键行为

- 通用→专题→读取/展开证据→继续→刷新→反向切换，兼容共享、互斥、幂等、取消与迟到结果拒绝。
- Creo通用→CST专题→省略模板指定Creo：继承档案当前专题模板，Creo目标按其产品基线模板不匹配而取专题默认值，证据仍取原Creo固定版本；CST版本不随Creo更新变化。
- 无待查模板切换只创建模型，不创建来源；同专题、相同目标且无变化的 continue 零新增模型/来源。读取只访问数据库，不触发上游。
- 专题 final 的网络失败、结构失败、隐私失败及重试共用最多两次实际请求；成功一次即停止，期限到达或只剩一次总额度时不能超发。
- 每次模型请求包含固定主体、逐产品目标、可见 claims 和完整依赖材料，按实际 UTF-8 body 字节计数。范围外/不可见/跨主体引用拒绝。
- 招聘、个人技能和供应商使用不推出企业替换需求；CAD场景不能仅凭产品标签支持CST场景；单个痛点词不提升状态。
- 保守路径理由校验：值得验证/反证的理由须完整引用一条可信、相关 claim 文本，并满足场景与路径前提类别检查；无法证明时降为依据不足。依据不足使用受控的中立说明，避免模型借合法引用扩写采购事实。这是有限校验，不是通用自然语言语义证明。
- 新增自由文本在模型接纳与最终快照存储边界检查邮箱/电话。HTTP 用例覆盖 rationale、prerequisites、questions、unknowns 两种敏感样本；存储、完整 structuredContent、文本和捕获日志不含该原文。检测能力限于现有 helper，不保证识别所有隐私形式。
- 实际2MiB证据组裁剪后再次校验专题claim闭包；缺失即以所有路径 insufficient 的安全结果回退，保留有效事实及评级，任务标partial。
- 三路径与关键问题优先进入4000字符以内首屏，完整结构通过原读取工具返回，按已有 version_id/claim_id 读取证据；路径变化仅进入analysis_changes。

## 使用与回退

已有档案使用同一工具切换模板；没有档案可使用 initial，但须先通过画像确认主体并显式选择产品。

```json
{"mode":"continue","dossier_id":"<档案ID>","base_version_id":"<当前版本ID>","operation_id":"sales-creo-001","template_id":"product_sales_scenario","products":["creo"]}
```

同模板可省略 template_id/products 继承；切换必须显式 products。模板版本由服务端固定，不由客户端提供。读取专题或证据不会启动研究。

存储 `schema_version=1` 新增严格模板结果分支，不新增SQL表。原第一阶段程序不支持专题模板，回退不能将专题按通用成果误读。维护前备份一致的业务 SQLite/WAL 及图谱库；停止接收并按生命周期排空/中止任务。回退时保持研究写入口关闭，使用兼容程序或经确认的完整备份恢复方案，不删除专题版本来绕过兼容检查。

已获仅本地提交授权，未获推送、部署或启用授权。完成远程 gate 后仍须在专用环境使用至少CAD、CAE、流程管理三类客户样本，核对引用、路径前提、来源归属、耗时与调用数；另记录真实ChatGPT/Codex外部页/手机相机宿主版本、tested SHA、实际结果和脱敏证据。合成HTTP与Chromium模拟不能替代真实验收。

## 实际命令与结果

执行过程记录在本地 `.superpowers/executing-plans/2026-10-17-product-sales-scenario/progress.md`。最终实际结果如下；未运行的 gate 不填通过。

实际环境：macOS 26.1、Node v24.19.0、Vitest v3.2.7。最后一次明确选择20个相关纯测试文件，共279项通过（专题43项、原研究236项），exit0；随后Node24类型检查与diff检查均exit0。该集合不包含native、页面bundle、项目完整套件或容器检查。

```sh
/Users/tang-codeing/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run tests/company-sales-scenario-contracts.test.ts tests/company-sales-scenario-e2e.test.ts tests/company-sales-scenario-model.test.ts tests/company-sales-scenario-planner.test.ts tests/company-sales-scenario-repository.test.ts tests/company-sales-scenario-results.test.ts tests/company-sales-scenario-runner.test.ts tests/company-sales-scenario-tools.test.ts tests/company-research-contracts.test.ts tests/company-research-repository.test.ts tests/company-research-planner-model.test.ts tests/company-research-budget.test.ts tests/company-research-runner.test.ts tests/company-research-results.test.ts tests/company-research-tools.test.ts tests/company-research-lifecycle.test.ts tests/company-research-e2e.test.ts tests/company-research-evidence.test.ts tests/company-research-graph.test.ts tests/company-research-sources.test.ts --exclude .worktrees/** --maxWorkers=1 --minWorkers=1
/Users/tang-codeing/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit --pretty false
git diff --check
```

补充的时间正例使用服务端评估时间：近30天内有可信发布时间、原文明确描述现状且无过去时／旧年份／失效限定的资料，可以支持有条件的探索路径；claim的historical标记与原证据日期不变。未知、过期、个人技能、供应商或招聘证据不借此提升。这是专题v1的保守探索门槛，不修改通用事实适配或opportunity@1评级，也不等同于上线效果保证。

执行计划中的本地开发项已完成；远程native/full/container以及授权真实样本和宿主项仍未完成。按用户后续授权将本专题提交到本地隔离分支，提交前再次执行 Node24 类型检查和 diff 检查，均 exit0；不推送、不合并或部署。
