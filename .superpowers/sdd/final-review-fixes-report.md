# Final Review Fixes Report

## 状态

已实现最终审查中的 3 项 Critical/Important 修复和文档 Minor：

- Ark 输入仍最多 4 条，但改为字段感知、UTF-8 字节受限的确定性压缩；成功 QCC 融资占专用最高优先槽，需求/技术证据按 QCC 与搜索来源公平选择，profile 仅作 fallback。
- 招聘、采购/招投标/数字化采购、扩产/融资动态搜索由严格 schema 强制 `TimeRange=OneYear`；非时效查询禁止该字段。
- `ResearchItem.url` 与 `EvidenceReference.url` 改为 nullable；搜索仍强制真实 HTTP(S) URL，QCC 无直接 URL 时为 `null` 并产生来源链接 gap，目录页不渲染、不计覆盖。
- README/plan 记录 2026-08-30 用户批准的 Task 11 本地 HTTP 一次性例外，以及未覆盖 TLS、反向代理、生产 Host/Origin 的边界；生产 HTTPS 要求不变。
- 真实验收记录中的旧 `关键结论链接覆盖=true` 已标记为“需重跑”；本轮没有真实上游调用，也没有伪造新的通过结果。

## TDD 记录

### RED 1 — Ark 字段感知容量

```text
rtk npm test -- --run tests/ark-adapter.test.ts
```

结果：8 failed / 18 passed。失败分别证明旧实现会让 profile 挤掉融资、正文全部变 `null`、100 字后的技术事实和直接采购措辞消失、标题被截断、没有 UTF-8 上限常量、无融资 fallback 被 QCC 单源占满。

### GREEN 1 — Ark 容量与验证

```text
rtk npm test -- --run tests/ark-adapter.test.ts tests/evidence-validator.test.ts
rtk npm run typecheck
```

结果：57 passed；typecheck 退出码 0。compact `ResearchBundle` 上限为 6,656 UTF-8 bytes，完整请求上限为 12,288 bytes。

### RED 2 — Search 动态时间范围

```text
rtk npm test -- --run tests/doubao-search.test.ts
```

结果：2 failed / 30 passed。失败证明采购与扩产/融资缺少 `OneYear`，严格 schema 也错误接受动态查询无时间范围。

### GREEN 2 — Search schema 与计划

```text
rtk npm test -- --run tests/doubao-search.test.ts
rtk npm run typecheck
```

结果：32 passed；typecheck 退出码 0。

### RED 3 — QCC nullable 直链与覆盖

```text
rtk npm test -- --run tests/contracts.test.ts tests/qcc-adapter.test.ts tests/report.test.ts
```

结果：7 failed / 118 passed。失败证明冻结契约拒绝 null、mapper 构造 QCC 目录 URL、报告无法渲染 unavailable 状态，且不存在真实直链覆盖统计。

### GREEN 3 — nullable provenance、报告与 coverage

```text
rtk npm test -- --run tests/contracts.test.ts tests/qcc-adapter.test.ts tests/report.test.ts tests/ark-adapter.test.ts tests/evidence-validator.test.ts tests/doubao-search.test.ts
rtk npm run typecheck
```

结果：214 passed；typecheck 退出码 0。后续压缩重构聚焦复验 151 passed，typecheck 退出码 0。

## 行为边界

- Ark 选择顺序确定：有融资时为融资专槽，然后搜索/QCC/搜索；无融资时为 QCC/搜索/QCC/搜索。各来源内部按采购、招聘、技术、支持证据排序。
- 标题、URL、evidence ID、主体字段和 provenance 不截断。超限时从最低优先项开始缩减正文，再缩减摘要，最后丢最低优先项；可信 gaps 原样保留并追加容量 gap。
- QCC 只保留上游记录显式提供的真实直链；企业官网字段不会被冒充为 QCC 记录直链，也不会猜测公司详情页。
- 链接覆盖要求所有关键事实、最近融资和推荐产品依据都存在真实直链；空集合不按真值处理。

## 验证

最终 fresh verification：

```text
rtk npm test -- --run tests/ark-adapter.test.ts tests/evidence-validator.test.ts tests/doubao-search.test.ts tests/contracts.test.ts tests/qcc-adapter.test.ts tests/report.test.ts
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
```

结果：focused 6 files / 214 tests passed；full 22 files / 543 tests passed；typecheck、build 和 diff check 均退出码 0。Node 24 仍输出既有 `node:sqlite` ExperimentalWarning，不影响退出码。

禁用项扫描无匹配（`rg` 退出码 1）。全仓 secret pattern 扫描只命中 `tests/auth.test.ts` 中显式 `test-*` 夹具和计划文档里的扫描命令本身；对 `src README.md .env.example docs/validation` 的 production-scope 扫描无匹配（`rg` 退出码 1）。`agent.qcc.com/data` 扫描只命中拒绝行为测试、禁止说明和计划的 QCC 工具目录参考，不存在生产回退。

## Concerns

- 6,656/12,288 bytes 是基于已记录的真实网关 4 条约 9.6KB/229s 成功结果采用的保守工程上限，不是上游公开 SLA；若网关容量变化，应通过新的脱敏 probe 和回归测试调整常量。
- 当前 Task 11 结果仍需按 nullable 直链和新 Ark 选择语义真实重跑。生产 TLS、反向代理和 Host/Origin 验证也仍未由那次本地 HTTP 例外覆盖。
- 本轮按要求没有调用真实 QCC、豆包搜索或 Ark。
