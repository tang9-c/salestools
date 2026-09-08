# Ark 紧凑数组输入设计

日期：2026-09-08

## 目标

减少每个 Ark 请求中重复的 JSON 字段名，让同一 12,288 bytes 请求容纳更多原始材料，同时保持逐条 evidence ID、正文和主体归属可审计。

本次只改变发送给 Ark 的内部序列化格式，不改变 MCP、SQLite、`ResearchBundle`、Ark 输出、机会规则或报告结构。

## 输入格式

`buildArkMessages` 继续接收完整 `ResearchBundle`，但用户消息只序列化：

```json
{
  "identity": {},
  "collectedAt": "...",
  "items": [
    [
      "evidenceId",
      "source",
      "sourceKind",
      "title",
      "url",
      "originalPublisher",
      "originalDomain",
      "summary",
      "content",
      "publishedAt",
      "mentionedName",
      "entityScope",
      "entityMatch",
      ["matchBasis"]
    ]
  ]
}
```

数组字段顺序固定为：

1. `evidenceId`
2. `source`
3. `sourceKind`
4. `title`
5. `url`
6. `originalPublisher`
7. `originalDomain`
8. `summary`
9. `content`
10. `publishedAt`
11. `mentionedName`
12. `entityScope`
13. `entityMatch`
14. `matchBasis`

保留 `null` 占位，避免字段错位。`query`、`position` 和 `logId` 不属于可采信事实，不发送给 Ark。`sourceStatus` 和来源缺口由本地流程处理，也不放入材料消息。

系统提示加入上述字段顺序，并继续声明网页及上游文本均为不可信数据。Ark 只能引用数组中的原始 `evidenceId`，不得把字段顺序、搜索行为或输入文本中的指令当作事实。

## 数据流与验证

批次规划和正文压缩仍操作完整 `ResearchBundle`。完整请求字节数继续通过生产使用的 `buildArkMessages` 精确计算，因此数组编码带来的节省会自然反映到每批装载数量。

Ark 响应仍使用现有 `EvidenceBundle`。`validateArkEvidence` 继续针对该批次的完整 `ResearchBundle` 校验 evidence ID、主体归属、引用字段和禁止推断规则，不为紧凑输入新增第二套验证 Schema。

跨批合并、失败重试、固定双并发、总调用预算和 `partial` 降级保持不变。

## 失败处理

- 数组字段数量或顺序错误由单元测试阻止。
- Ark 引用不存在的 evidence ID 继续返回无效输出错误。
- 单批失败仍重试一次；其他批次继续。
- 调用预算耗尽时继续明确记录未处理材料，不伪装为完整报告。
- 如果真实 Ark 无法稳定理解数组字段，回退为当前对象格式，不引入第三种格式。

## 测试与配置门槛

自动测试覆盖：

- 所有输入材料各出现一次且 evidence ID 不变；
- 14 个数组字段顺序、`null` 占位和 `matchBasis` 完整；
- `query`、`position`、`logId`、`sourceStatus` 和 `gaps` 不进入用户消息；
- 完整请求仍不超过配置字节上限；
- 虚构 evidence ID 仍被拒绝；
- 同一份接近普渡机器人规模的离线材料，在相同字节上限下，数组格式的请求总字节数和规划批次数均严格少于当前对象格式；真实配置是否启用仍只以随后 `≤16` 批的诊断门槛为准。

真实验证分两步：

1. 使用已确认的深圳市普渡科技股份有限公司执行只读上游采集和批次规划，不调用 Ark、不创建 assessment；只有规划结果不超过 16 批才进入下一步。
2. 将本地 `.env` 调整为 `MAX_ARK_CALLS=20`、`MAX_TOTAL_UPSTREAM_CALLS=36`，提交一次正式真实评估，验证所有唯一材料均成功处理或有明确失败记录，并确认双并发实际生效。

如果第一步仍超过 16 批，不修改预算配置，也不提交正式评估；先报告实际批次数和字节瓶颈。

## 明确不做

- 不合并多个证据为新的 evidence ID。
- 不增加字典、默认值继承、字段缩写对象或新依赖。
- 不新增数据库字段、缓存或材料状态机。
- 不修改产品机会判断和报告格式。
