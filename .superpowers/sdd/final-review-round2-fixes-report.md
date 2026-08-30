# 第二轮全量复审修复报告

## 范围与安全边界

- 本轮只修复第二轮全量复审的 3 个 Important：融资专槽排序、长正文的强证据多窗口摘录、行业分类依据的直链覆盖。
- 全程未启动真实评估、未调用 QCC、豆包搜索或 Ark 上游。
- 用户已有 `.env.example` 修改未触碰、未暂存、未覆盖。

## TDD 记录

### 1. 融资专槽

RED：先加入“旧融资在前、新融资在后”和“全部无日期”回归。旧实现在 `publishedAt` 逆序输入时仍选择第一条，focused 结果为 1 failed / 27 passed。

GREEN：融资候选按有效 `publishedAt` 降序稳定选择；有日期排在无日期之前，同日期保持来源顺序，全部无日期时保留第一条。融资专槽不再用其他融资记录回填；省略其他记录时加入可信 gap，明确未选不代表不存在。融资 focused 结果为 28 passed。

### 2. 强证据多窗口摘录

RED：先把泛化“招聘/岗位/采购公告”放在开头，把真实 Windchill、Abaqus、非线性有限元和“拟采购 Windchill”放在 1000 字符以后。旧首命中摘录丢失尾部事实，结果为 2 failed / 28 passed。

GREEN：按证据类别与关键词强度扫描全文，产品词、采购披露/动作和工程技能高于泛化招聘/岗位/公告；选择最多 4 个互不重叠窗口并拼接，保持 6,656-byte compact bundle、12,288-byte 完整请求和最多 4 条证据的限制。初次 GREEN 为 Ark/validator 61 passed。

随后将 Windchill、Abaqus、非线性有限元拆成三个相互分离的强窗口，暴露出固定长度贪心拼接会让前两个窗口耗尽第三个窗口预算：4 个 focused 文件结果为 1 failed / 86 passed。根因修复为按剩余窗口数公平预留 UTF-8 配额，保留强度排序但不允许前序窗口独占预算；强化后的 Ark 文件为 30 passed。

### 3. 行业分类依据链接覆盖

RED：新增“行业分类只有 QCC null URL、推荐产品有直链”的回归。严格 `ReportModel` 拒绝并丢失 `industryEvidenceIds`，结果为 2 failed / 24 passed。

GREEN：`ReportModel` 必须保留 `industryEvidenceIds`；行业依据在未被事实行覆盖时单独进入关键证据表，null URL 显示“来源链接不可用”；链接覆盖同时检查行业分类、关键事实、最近融资和推荐产品依据。随后补充“非 `unverified` 分类没有任何行业依据 ID”断言，再观察到 1 failed / 11 passed，并修正为空依据直接返回 `false`。contracts/report 最终结果为 26 passed。

## 文档同步

- 设计与实施计划明确了融资日期/null 稳定排序、历史/其他融资省略 gap、多窗口评分和公平 UTF-8 配额。
- `ReportModel` 契约加入 `industryEvidenceIds`，链接覆盖定义纳入行业分类依据。
- 既有真实验收中的链接覆盖仍为“需重跑”。本轮没有把旧结果改为通过，也没有执行真实上游重跑。

## Fresh verification

```text
rtk npm test -- --run tests/ark-adapter.test.ts tests/evidence-validator.test.ts tests/contracts.test.ts tests/report.test.ts
rtk npm run typecheck
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git diff --check
```

结果：focused 4 files / 87 tests passed；full 22 files / 548 tests passed；两次 typecheck、build 和 diff check 均退出码 0。Node 24 仍仅输出既有 `node:sqlite` ExperimentalWarning。

禁用项扫描无匹配（`rg` 退出码 1）。production-scope secret pattern 扫描无匹配（`rg` 退出码 1）；tracked-files 扫描只命中 `tests/auth.test.ts` 的显式 `test-*` 夹具与计划文档中的扫描命令。`src` 中 `https://agent.qcc.com/data` 无匹配。

## Concerns

- 6,656/12,288 bytes 仍是基于已记录真实 probe 的保守网关工程上限，不是上游公开 SLA；容量变化后应使用新的脱敏 probe 调整并复验。
- Task 11 必须按新的 nullable 行业依据覆盖与 Ark 选择/摘录语义重新执行，才能更新真实验收结果；本轮未执行真实上游调用。
- 本地 HTTP 例外仍不覆盖生产 TLS、反向代理、生产 Host 与生产 Origin。
