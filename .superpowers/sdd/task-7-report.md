# Task 7 实施报告

## 结果

- Commits:
  - `3d2bcbb feat: add deterministic seven-product opportunity rules`
  - `df47c0a fix: harden opportunity evidence gates`
  - `b5fac1e fix: reject negated opportunity signals`
  - `75c889d fix: bind opportunity negation to actions`
  - `5e57c5b fix: classify product signals per occurrence`
- 新增 `PRODUCT_RULES`，覆盖 Windchill、Feigenbaum QMS、Creo、CATIA、Abaqus、CST 和 SolidWorks 的固定产品词、工程方法、竞品词和阻碍词。
- 新增 `evaluateProduct` 与 `evaluateOpportunities`，仅使用 `EvidenceBundle` 和显式 `now`，按固定四档顺序返回七产品结果。
- 融资只在已有产品场景且来源归属已确认时增强预算/时机；不创建场景，不单独产生“高”。
- 招聘对七产品均纳入重要信号：365 天内直接点名产品/工程方法可建立场景和时机；竞品、泛岗位、过期招聘保守处理。
- 独立性复用契约层 `countIndependentPublishers`，仅按原始域名/发布方去重，不按 QCC/Doubao 获取通道计数。
- 综合结果依次按机会等级、直接已确认正向证据数、阻碍数、固定产品顺序选择；仅有弱/概率证据时强制返回“待核实”和 `null`。

## TDD 记录

1. 首先新增表驱动测试，聚焦运行因 `src/opportunity/evaluate-all.ts` 不存在而 RED。
2. 最小实现后补充并观测到以下真实 RED：未确认融资归属被误用、概率/弱证据聚合被误推荐、泛岗位被误作生态/时机、竞品直接证据误获 tie-break 优势、“待核实”预算/决策被误认为正向。
3. 每个 RED 均以最小规则修复并重跑 focused tests。

### 审查修复记录

1. 为审查发现的六类高估漏洞先新增 RED：否定预算/决策、泛采购解除竞品阻碍、无效替换信号、跨产品主体洗白、`productTags` 单独建场景、无关来源凑独立发布方、日期缺失/未来/边界误分类。
2. 预算和决策仅认可完整正向白名单表达，并先执行否定短语检查；“没有预算”、“并非预算充足”、“不具备独立采购权”和“并不拥有独立采购权”均会形成阻碍。
3. 替换信号仅接受目标法定主体、`confirmed`、引用归属一致、最近 365 天、明确替换/替代/迁移/重选语义；`probable`、普通采购/招标和否定语义均不能解除已确认竞品阻碍。
4. 场景必须同时命中当前产品明确词或工程方法；`productTags` 只用于路由，不能单独建立场景。
5. 主体归属门槛改为每产品计算，且 fact 与所有 `EvidenceReference` 的 scope/match 必须一致。独立发布方只从当前产品的已确认场景、已标签匹配复杂度、近期时机和有效融资引用计数；风险、普通预算和无关复杂度不计数。
6. 时间判断显式区分 `recent/expired/future/missing`；恰好 365 天仍为近期，再早 1ms 为过期，null 和未来日期使用各自缺口文案。
7. 第二轮复审先用七产品表驱动 RED 锁定“不使用/无需/已停用/未开展/暂不建设”误报，再以产品或方法命中词关联的动作结构排除否定语义；不同短句中的肯定场景仍可独立成立，否定竞品也不会形成竞品阻碍。
8. 补齐“未获预算批准、预算不充足、资金不足、不具有独立采购权、未获采购决策权”等明确否定；这些事实形成阻碍，绝不提供预算或决策正向支持。
9. 为七产品逐项验证专属集团统一平台阻碍；无日期和未来日期的正向招聘仅保留历史软件生态价值，不产生最近 365 天时机。
10. 最终复审移除产品后固定字数窗口，改为同一短句内“动作直接支配首个相关产品/方法，后续肯定动作终止否定作用域”的确定性规则；`Creo无需出差`、`CATIA不需要五年经验`、`Siemens NX无需夜班`、`停用旧系统后部署Creo` 和无关旧项目均不再误判。
11. 替换否定仅匹配“暂无迁移计划、未计划、未决定、未迁移、不替换”等完整结构；`不久后计划`、`未雨绸缪后决定`、`不得不迁移`保持肯定。预算纠正显式处理“并非没有预算”和“没有预算问题，资金充足”，避免双重否定形成 blocker。
12. 后续复审删除跨 occurrence 的动作作用域：每个产品别名和工程方法命中独立检查紧邻前置否定或后置停用动作，只对同一文本位置保留最长别名。`无需Pro/E但要求Creo` 与 `不使用旧版PLM但招聘Windchill管理员` 中的后一个别名可独立成立；`停止使用Creo`、`Creo计划停用`、`CATIA后续不再使用` 均保持否定。
13. 替换否定拆成计划、前置动作、未完成状态三类小型结构，覆盖“尚未开始迁移、并未启动替换、暂不考虑替代、迁移工作尚未完成”，且不影响既有肯定反例。

## 验证

- Focused: `tests/opportunity.test.ts` + `tests/recruitment-signals.test.ts` 共 `184 passed`。
- Full suite: `15` test files, `327 passed`。
- Typecheck: `tsc --noEmit` 退出码 `0`。
- Diff check: `git diff --check` 与提交前 `git diff --cached --check` 退出码均为 `0`。
- 禁用输出/非确定性扫描：机会模块中无分数、星级、模型调用、`Math.random` 或隐式 `new Date()`。

## 已知边界

- `EvidenceBundle` 只有 `P1/P2/non_target/unverified` 而没有结构化子行业；因此 P1/P2 只能影响目标行业门槛，不能凭空创造产品间的子行业偏好。同等证据时使用已冻结的产品顺序。
- “关键冲突”没有独立严重度字段，v0.1 用固定主体/行业/关键来源冲突词表识别，不将所有普通缺口当作致命冲突。
- 全量测试中的 Node `node:sqlite` ExperimentalWarning 来自既有 Task 2 测试，与 Task 7 无关；所有测试仍通过。
