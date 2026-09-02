# 真实企业报告质量修复实施计划

> **执行要求：** 使用 `superpowers:executing-plans` 按任务顺序执行；每个行为修改严格遵循 RED → GREEN → REFACTOR。所有命令按仓库 `AGENTS.md` 要求使用 `rtk` 前缀。

**目标：** 修复真实评估中 QCC 年报路由、融资/年报/资质响应适配、豆包直链被挤出、行业标签误作门槛和报告缺口重复五个卡点，并用“深圳市正浩创新科技股份有限公司”完成一次真实复验。

**边界：** 保持单进程、SQLite、现有数据库结构、调用预算和 12,288-byte 方舟请求上限；不新增通用规则平台、数据表、后台配置或完整 QCC 响应 Schema。

**实现原则：** QCC 采用“宽进严出”：只定位已知数据区域，把融资、年报、资质转换成长度受控的研究文本；未知字段和非关键字段缺失不失败。系统继续用现有 `MappedQccResult`、`ResearchItem` 和来源状态表达“成功有数据 / 成功空结果 / failed”，不新增持久化字段。方舟负责事实整理，确定性代码只负责证据归属、行业标签和产品机会规则。

---

## 任务 1：修复 QCC 路由和最小结构化适配

**文件：**

- 修改：`src/upstream/qcc/tool-allowlist.ts`
- 修改：`src/upstream/qcc/assessment-research.ts`
- 修改：`src/upstream/qcc/mapper.ts`
- 修改：`src/upstream/ark/payload-budget.ts`
- 修改：`tests/qcc-adapter.test.ts`
- 新增或修改脱敏夹具：`tests/fixtures/qcc-real-financing-*.json`、`tests/fixtures/qcc-annual-report.json`、`tests/fixtures/qcc-qualification.json`

### 1.1 先写失败测试

在 `tests/qcc-adapter.test.ts` 增加以下契约测试：

1. `get_annual_reports` 允许在 `company` 调用，在 `operation` 返回 `TOOL_NOT_ALLOWED`；`QccResearchCollector` 的年报计划调用 `company`。
2. 融资真实结构 `股权融资.创投融资[]` 能生成一个聚合的 QCC `ResearchItem`；内容保留上游可读融资材料，但不要求 `融资日期`、`融资轮次`、`融资金额` 或 `投资方` 存在。
3. 融资记录增加未知字段、删除任意非关键字段后仍可映射。
4. 明确空数组或明确“无融资记录”返回成功空结果与“未查到或未披露数据”gap，不抛异常。
5. 完全找不到已知融资区域时抛 `UNMAPPABLE_DATASET`；collector 将融资项标为失败、QCC 为 `partial`，其他工具结果仍保留。
6. 中文年报 `企业年报信息[]` 和资质 `资质证书信息[]` 各生成一个长度受控的聚合研究项；未知字段和非关键字段缺失不失败，空数组按成功空结果处理。
7. 文本材料长度有固定内部上限，且不包含凭据或请求元数据。

运行并确认 RED：

```bash
rtk npm test -- --run tests/qcc-adapter.test.ts
```

预期失败点：年报路由仍在 operation；融资真实嵌套结构、中文年报和中文资质无法映射。

### 1.2 最小实现

在 `tool-allowlist.ts`：

- 把 `get_annual_reports` 从 `operation` 移到 `company`。

在 `assessment-research.ts`：

- 把 `annualReportCall.server` 改为 `company`。
- 删除融资专属的“适配器契约缺口”措辞；无法定位时使用统一的“融资信息获取失败（返回数据无法读取）”。
- 保持来源级失败只使 QCC `partial`，不使整个任务失败。

在 `mapper.ts`：

- 删除 `ChineseFinancingRecordSchema` 及融资日期/轮次/金额的逐字段转换。
- 新增小型、非递归的已知区域定位助手，只接受明确路径：当前融资 `股权融资.创投融资`，兼容既有 `融资信息`；年报 `企业年报信息`；资质 `资质证书信息`。
- 使用 `z.record(z.string(), z.unknown())` 只验证容器和记录是对象；允许记录内未知字段、改名和缺字段。
- 新增长度受控的 JSON 文本序列化助手，对每个工具聚合成一个 `ResearchItem`，只保留业务材料，不保存完整响应 envelope。
- 明确空数组返回 `items: []`；无法定位已知区域才抛类型化错误。
- QCC 没有直接记录 URL 时继续生成证据级 audit gap。

在 `payload-budget.ts`：

- 删除 `financingContent()` 对 `occurredAt/typeOrRound/disclosedAmount/investors` 的再次结构化压缩。
- 融资内容与其他 demand evidence 一样按关键词窗口和字节上限压缩，不要求固定 JSON 字段。

### 1.3 验证并提交

```bash
rtk npm test -- --run tests/qcc-adapter.test.ts tests/ark-adapter.test.ts
rtk npm run typecheck
rtk git diff --check
rtk git add src/upstream/qcc src/upstream/ark/payload-budget.ts tests/qcc-adapter.test.ts tests/fixtures
rtk git commit -m "fix: tolerate qcc research response changes"
```

---

## 任务 2：在方舟证据预算中保留豆包直链

**文件：**

- 修改：`src/upstream/ark/payload-budget.ts`
- 修改：`tests/ark-adapter.test.ts`

### 2.1 先写失败测试

构造 QCC-heavy 的 `ResearchBundle`：四类证据都有大量 QCC 项，同时存在主体为 `confirmed`、带真实 URL 的豆包候选。测试断言：

- 压缩结果至少包含一条合格豆包直链；
- 四类已可容纳的预留覆盖不下降；
- 最终完整请求不超过传入字节上限；
- 多次运行选择顺序一致；
- 没有固定 4 条或固定 N 条限制；容量充足时仍可选入更多证据。

另加反例：没有合格豆包证据、豆包主体为 `unverified`，或加入豆包会破坏已证明可容纳的类别预留时，不强行加入。

```bash
rtk npm test -- --run tests/ark-adapter.test.ts
```

预期 RED：当前 Stage B 按 QCC-first 顺序填充，豆包直链被挤出。

### 2.2 最小实现

在 `compactResearchBundleForArk()` 的 Stage B 中：

1. 完成类别 reservation 并恢复正常内容；
2. 如果当前集合没有 `source === 'doubao_search'`、`url !== null` 且 `entityMatch` 为 `confirmed|probable` 的项，先尝试加入一条；
3. 豆包优先级固定为 `official_products → engineering → software_ecosystem → recruitment → quality → procurement → expansion_financing`；
4. 复用 `fitCandidate()` 测量完整序列化请求，不删除已预留类别；
5. 再进入现有普通填充循环。

不要新增证据条数配置或第二套容量算法。

### 2.3 验证并提交

```bash
rtk npm test -- --run tests/ark-adapter.test.ts
rtk npm run typecheck
rtk git diff --check
rtk git add src/upstream/ark/payload-budget.ts tests/ark-adapter.test.ts
rtk git commit -m "fix: preserve linked search evidence for ark"
```

---

## 任务 3：确定性补充行业标签，并解除产品门槛

**文件：**

- 新增：`src/industry/classify-industry.ts`
- 新增：`tests/industry-classification.test.ts`
- 修改：`src/orchestration/assessment-runner.ts`
- 修改：`src/opportunity/evaluate-product.ts`
- 修改：`tests/assessment-runner.test.ts`
- 修改：`tests/opportunity.test.ts`

### 3.1 先写行业分类失败测试

为纯函数 `supplementIndustryClassification(evidence)` 写测试：

- 方舟为 `unverified`，确认法定主体的 direct/supporting 事实包含“移动储能”“便携式电源”等批准关键词时，补为 P1，并返回实际 evidence IDs。
- 弱事实、`probable/unverified` 主体、集团/品牌范围、无引用证据、未知 evidence ID 均不能分类。
- 同时命中 P1 和 P2 时保持 `unverified`。
- 方舟已经给出 P1/P2/non_target 时保持原值。
- 规则只包含通用行业词，不出现企业名称、品牌或信用代码。

```bash
rtk npm test -- --run tests/industry-classification.test.ts
```

预期 RED：模块尚不存在。

### 3.2 实现最小分类器并接入

- 定义已批准目标行业关键词表，v0.1 首先覆盖设计文档列出的新能源装备词。
- 只读取 `industry/product_scene/manufacturing` 事实，并同时校验事实和引用证据的主体归属。
- 返回新的 `EvidenceBundle`，不原地修改方舟结果。
- 在 `AssessmentRunner` 中，于方舟结果验证完成后、`opportunityEvaluator` 之前调用该函数；后续 report、audit 都使用补充后的 evidence。

### 3.3 先写机会规则失败测试

在 `tests/opportunity.test.ts` 使用完全相同的产品事实，分别传入 P1、P2、non_target、unverified，断言产品机会等级相同。另测：

- 只有行业标签、没有产品场景时，不能得到“中”或“高”；
- `unverified` 不再自动产生“行业尚未核实”并强制所有产品“待核实”；
- 主体冲突和全部正向证据未确认仍保持现有硬门槛。

```bash
rtk npm test -- --run tests/opportunity.test.ts tests/assessment-runner.test.ts
```

预期 RED：`evaluate-product.ts` 仍以 `industryClassification === 'unverified'` 作为全局门槛。

### 3.4 修改机会逻辑

- 从首个 `if` 删除行业 `unverified` 条件及对应 gap。
- 将最终行业分支改为纯证据分支：场景不足则“低”或“待核实”只由主体可信度、正向证据强度、复杂度和阻碍决定。
- 不允许行业标签独立产生等级；若只剩行业事实，没有具体产品场景，保持“低”或“待核实”的既有证据语义。

### 3.5 验证并提交

```bash
rtk npm test -- --run tests/industry-classification.test.ts tests/opportunity.test.ts tests/assessment-runner.test.ts
rtk npm run typecheck
rtk git diff --check
rtk git add src/industry src/orchestration/assessment-runner.ts src/opportunity/evaluate-product.ts tests/industry-classification.test.ts tests/opportunity.test.ts tests/assessment-runner.test.ts
rtk git commit -m "fix: make industry classification advisory"
```

---

## 任务 4：聚合 QCC 无链接缺口

**文件：**

- 修改：`src/report/build-report-model.ts`
- 修改：`tests/report.test.ts`

### 4.1 先写失败测试

构造包含数百条 `qccUnavailableLinkAuditGap(id)` 的 EvidenceBundle，断言：

- `model.gaps` 只出现一条 `企查查有 N 条证据未提供直接来源链接`；
- 原始 EvidenceBundle 不被修改；
- 聚合 audit gap 不进入 `nextVerificationActions`；
- rating/enhancement gap 仍正常进入相应报告区域和核实动作；
- 有 URL 的事实仍渲染真实链接，无 URL 的事实仍显示“来源链接不可用”。

```bash
rtk npm test -- --run tests/report.test.ts
```

预期 RED：逐条 gap 被保留，并全部再次生成核实动作。

### 4.2 最小实现

在 `buildReportModel()`：

- 在展示模型构造阶段统计 `isQccUnavailableLinkAuditGap()`；删除逐条展示项并追加一条计数摘要。
- 对聚合后的 gap 调用已有 `classifyReportGap()`；`nextVerificationActions` 只接收 `rating|enhancement`，忽略 `audit`。
- 不修改 EvidenceBundle、数据库 Schema 或证据引用渲染。

### 4.3 验证并提交

```bash
rtk npm test -- --run tests/report.test.ts
rtk npm run typecheck
rtk git diff --check
rtk git add src/report/build-report-model.ts tests/report.test.ts
rtk git commit -m "fix: aggregate qcc link audit gaps"
```

---

## 任务 5：核心闭环回归验证

**文件：**

- 仅在发现由本方案引入的回归时修改对应测试或实现；不得顺手扩展功能。

执行：

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
rtk git status --short
```

验收：

- 全量测试通过；
- TypeScript 类型检查和生产构建通过；
- 无未解释的快照变化；
- 没有新增数据库迁移、公开配置、服务或依赖；
- `git diff` 只包含本设计范围内改动。

若为回归修复产生改动，使用独立提交：

```bash
rtk git add <实际修改文件>
rtk git commit -m "test: close real assessment regressions"
```

---

## 任务 6：真实本地 HTTP 复验

**前置条件：** 使用已配置的真实 `.env`，仅查询已获授权的“深圳市正浩创新科技股份有限公司”；使用临时 SQLite，严禁把凭据、完整 QCC 响应、网页正文或方舟完整输出写入仓库或日志。

### 6.1 启动隔离实例

- 使用临时目录中的 SQLite 路径启动应用。
- 通过本地 HTTP `/mcp` 调用 `resolve_company`，核对法定名称和信用代码。
- 提交一次新评估；如果工具契约支持 `force_refresh`，只使用一次。
- 轮询至 `completed` 或 `failed`，不重复提交。

### 6.2 记录安全验收数据

只记录以下派生指标：

- 每个 QCC 工具的 `completed/failed` 与安全错误码；
- QCC、豆包、方舟来源状态；
- 原始、入选、排除证据数和四类覆盖；
- 入选豆包直链数量；
- 行业标签、行业证据 IDs 和主体归属；
- 七产品机会与推荐产品；
- 报告直接链接数量、QCC 聚合 gap 数量、报告长度；
- 方舟请求字节数和总耗时。

真实验收必须满足：

- 年报调用路由为 company，不再出现工具不存在；
- 融资、年报、资质的格式变化不会因非关键字段缺失导致整项失败；
- 存在合格且可容纳的豆包链接时至少一条进入方舟输入；
- 行业不再把七产品全部强制为“待核实”；
- QCC 无直链只显示一条计数摘要；
- 任何“高/中/低/待核实”和推荐结果都必须与证据一致，不要求强行给出推荐。

### 6.3 保存结果和最终验证

把不含敏感数据的验收摘要追加到设计文档的“真实端到端复验”结果小节；不得提交临时 SQLite 或原始响应。

```bash
rtk git status --short
rtk git diff --check
rtk git add docs/superpowers/specs/2026-09-02-real-e2e-quality-fix-design.md
rtk git commit -m "docs: record real assessment verification"
```

完成前再次执行：

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git status --short
```

