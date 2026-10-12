# 联系人疑似重复线索持久化验证记录

日期：2026-10-11（America/Los_Angeles）。基准 SHA：`fb4549939e0d2b2080893ee4194047390fca7e6e`。首次本地测试对象为该基准上的未提交工作区，不能将基准 SHA 作为实现验收 SHA。用户随后授权提交并合并 main；准确实现 SHA 与远程结果见下方远程验收记录。

本地环境：Node v24.11.1、Python 3.11.14（现有链接的 venv）、Google Chrome 154.0.8037.98，执行路径 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。

## 本地允许的验证

- UI TDD RED：修改浏览器行为测试后运行上传及图谱浏览器测试，5 failed / 55 passed / 1 skipped。预期失败分别为“暂不保存”入口缺失、重复场景保存按钮文案缺失、截断警告缺失和双方详情身份提示缺失。
- GREEN：指定现有 Chrome，运行 `contact-import`、`contact-identity-match`、`contact-upload-browser`、`contact-upload-app`、`contact-search-graph-model`、`contact-search-graph-browser`、`contact-upload-session-http` 七个测试文件，180 passed / 1 skipped。跳过的是要求 CI 实际页面 bundle 的用例，不是源码浏览器测试。
- `tsc --noEmit`、五个 Rust 源文件的 `rustfmt --check --edition 2021`、`git diff --check` 均通过；无本地构建或 Rust 编译。
- 最后测试类型修正后单独复跑 HTTP：79 passed；类型与 diff 检查再次通过。
- 联系人 skill 静态元数据检查通过。独立合成情境验证覆盖授权独立保存、确认同一人走原合并工具、忽略入向线索先读取实际主体版本并附审核说明；修正了旧指引遗漏说明的问题。没有调用真实 MCP 或写联系人库，静态检查不能代替行为验收。
- 主代理最终整组复跑：11 个测试文件 238 passed / 1 CI-bundle-only skipped；包括 graph-client 部分页保留、问答／向量隔离及既有 MCP 库工具契约。`tsc --noEmit`、全部 9 个变更 Rust 源码／测试文件格式检查和 diff 检查通过。既有 Node SQLite／TypeScript ExperimentalWarning 及合成 HTTP 失败日志已记录，不视为新业务失败。

浏览器测试执行 TypeScript 解释器源码并模拟宿主/接口。验证了用户点击前无提交、有重复时仍可授权保存、暂不保存无提交/取消、双方身份提示不依赖职业线索开关、claim 原分页可继续读取、身份线索不产生图谱边或扩展节点，以及其他职业线索仍由原开关控制。

HTTP 测试保留主体、证据、覆盖、归属及版本失败断言；旧重复阻断断言改为成功回执与实际派生字段检查。实际本轮失败/截断必须传 `duplicate_match_incomplete=true`，同名/电话匹配传真实目标和理由。任务历史匹配警告保留在预览；当前重查完整成功时派生标记可为 false，不解析历史警告字符串来反推标记。

## 待验收

独立整分支静态审查未发现新增实现阻断缺陷，但结论为“尚不可合并”：下面的真实门禁未完成。两项非阻断测试补强保留待办：晚期失败时更直接断言目标／第三人线索／审计回滚，以及身份提示仅在第二页出现的渲染用例；没有以静态审查代替实际验证。

| 门禁 | 状态 |
| --- | --- |
| Rust 真实存储、事务、重启、审核、合并、native RED/GREEN | 未运行，需现有远程 CI |
| 同一 tested SHA 的完整测试、实际页面 bundle、生产容器 gate | 未运行，需提交/推送授权及现有 workflow |
| ChatGPT、Codex 外部页面、手机相机真实宿主 | 未提供验收环境与脱敏证据 |

远程 Rust 命令仍为 `cargo test --locked --manifest-path rust/contact-graph/Cargo.toml`，仅在 `.github/workflows/contact-upload-validation.yml` 的远程 runner 执行。验收时补充真实 SHA、运行链接、环境版本和实际结果；本记录不声称全部验收通过。

## 远程验收记录

已获验证分支提交／推送与合并授权；尚待执行并记录真实 CI。不会发布镜像或部署。须通过 gate 后才合并 main，真实宿主验收仍单独列为未验收。

- 首次测试 SHA：`93de9c519d7ecbe774d61dc90a52c8132e981eae`，[运行 38214529444](https://github.com/tang9-c/salestools/actions/runs/38214529444)。生产 Rust 源码编译通过；新增 `tests/search.rs` 在 `vec![b]` 移走 String 后再次借用，测试编译 E0382 失败，其他验收未执行。最小修正为断言中使用 `b.clone()`，不改业务逻辑；后续结果待记录。
- 修正测试 SHA：`34ebdac4c8950ff06d71228bf26943abcffc1229`，[运行 38215144609](https://github.com/tang9-c/salestools/actions/runs/38215144609)。Rust 源码与全部测试编译通过；审核 14 项通过，入库 47 项中 46 项通过、1 项失败，剩余 gate 因此未执行。
- 失败为既有 `merge_into_unnamed_target_still_checks_anonymous_relation_evidence`：引文只有“陈晓任职甲公司”，所选任职关系含 CEO，预期 `VALIDATION_ERROR`，实际成功写入。该用例及合并／匿名判定逻辑相对基准 `fb45499` 均未修改。合并给匿名目标补姓名后，最终 `properties` 存在 name，未进入 `unnamed_landed`，后续匿名任职角色定位校验被跳过。不是本轮重复线索字段或存储 Schema 的错误。
- 因原计划明确不调整正式字段合并和任职规则，本轮停止合并并请求确认是否扩大到这处既有校验修复。没有修改／删除失败断言，没有合并 main、发布或部署。当前 CI 不能视为通过。
- 2026-10-12 用户授权修复此处校验。最小改动在导入 merge 读取目标旧 properties 后、补入候选字段前，把匿名 Person 记入既有 `unnamed_landed`；姓名合并行为不改，后续复用原任职／教育定位校验。原失败用例保留，并补有／无职位定位依据的双路径，以及失败后旧档案、版本、实体和关系原子回滚断言。Rust GREEN 等待远程 CI，本地仅做格式与 diff 检查。
- 修复测试 SHA：`7994c6d898ad37c51c628f6fc126be9ec3c995c1`，[运行 38253652370](https://github.com/tang9-c/salestools/actions/runs/38253652370)。匿名任职校验双路径与全部 47 项入库测试通过。随后本轮新增 lifecycle 合并测试失败：逐条身份线索审计及合并主审计复用了 `audit_log.operation_id`，违反唯一约束。故完整 gate 仍未通过，main 未合并。
- 对上述本轮缺陷做最小修正：子审计 ID 按原合并 ID／claim／处理原因派生，主操作 ID 不变；子审计 JSON 保留 `merge_operation_id` 供追溯。不改表或幂等协议。现有真实 Store 测试增加主／子审计不冲突、重放不重复及故意晚期失败确实触发并回滚审计的断言，后续 CI 待记录。
