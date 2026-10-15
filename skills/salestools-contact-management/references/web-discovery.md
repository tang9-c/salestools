# 网页发现与快照分页

使用当前部署声明的 `discover_contacts`；本地新增参数不证明远端已支持。先澄清目标公司的简称、品牌、集团或同名主体歧义，保留原文公司分组，不能把集团、子公司和客户人员自动算入目标企业。

## 人物和证据

网页发现覆盖公开职业人物，包括普通工程师、行政/运营人员、专家及无明确职位的人物，不限五类负责人、三家公司或每家十人。`title:null` 表示职位未知，不补造职位。新版观察保留 `evidence_quote`、`source_url`、`published_at` 和 `affiliation_status`：

- `employment_evidence` 表示原文支持任职归属，不证明当前在职或人工核实。
- `unverified` 表示归属待核实，例如仅出现于专利发明人名单；不能据此断言员工身份。明确属于外部机构的嘉宾、客户人员应排除。

不同来源的同名观察、网页与 Zoho 结果均不自动合并。历史证据说明过去快照曾见，不证明离职；旧格式缺少归属字段时称旧规则资料，不能猜测其属于哪种新版状态。结果不返回电话、邮箱等直接联系方式。

## 固定快照分页

首次传 `query`、`source:"web"`（用户明确两源时 `"all"`）及需要的 `region_hint`。网页参数为 `web_offset`（默认 0，非负安全整数）、`web_limit`（默认 50，1–100）、`web_snapshot_id`（正安全整数）。

保存返回的 `web_page.snapshot_id`。续页保持相同 query、region_hint，把 `web_page.next_offset` 作为 `web_offset`，把首次 ID 作为 `web_snapshot_id`；直到 next_offset 为 null。仅翻网页时使用 `source:"web"`，包括首次为 all 的情况；首次为 web 时继续 web。offset>0 必须带 ID。不要为了翻页重新发现或换用最新 ID：即使并发产生新快照，网页侧仍读取原快照及其之前的历史投影，不调用网页搜索或抽取。绑定 ID 的第 0 页也只重读网页快照。

例如 source=all 的快照 7 首页返回 offset=0、limit=50、total=63、next_offset=50，只翻网页的下一页用相同 query/region_hint，`source:"web", web_snapshot_id:7, web_offset:50, web_limit:50`；不能改用并发生成的快照 8。63 是当前及历史观察总条数，可能重复涉及同一人，不是 63 名员工。

ID 不存在、查询或地域不匹配、参数无效时说明分页失败；需要重新开始发现时去掉旧 ID、从 offset=0 发起，不能把两次快照拼成一份完整结果。缓存键规范化查询与地域，简称和全称不会自动合并。

`source:"all"` 中网页独立分页，不截断或表示 Zoho 完整性；每次调用 all 仍实时查询 Zoho，绑定网页 ID 不锁定 Zoho，也不保证整体零上游调用。用户明确需要同时刷新 Zoho 时才续用 all；只翻网页则切换 web。网页失败时保留 Zoho 区域及警告，不能将整体返回当作网页成功。`source:"zoho"` 拒绝显式传入任何 web_* 分页参数。

## 缓存和覆盖

无 ID 的新查询只复用 30 天内的新版（coverage.version=2）缓存；旧格式即使未满 30 天也尝试增强刷新，刷新失败时可回退旧资料并警告。固定 ID 可以读取超过 30 天的快照，但只能称历史资料，采集时间不更新，也不自动刷新。

根据 `web_coverage` 的 total_pages、total_chunks、processed_chunks、pending_pages、complete 以及 warnings 报告实际处理范围。complete 只说明本次取得材料的处理情况，不表示全网覆盖或全体员工；旧格式 coverage 可能为 null。区分分页未读完与材料未处理完，空结果不证明无人。公众号正文不可读、图片名单、搜索未覆盖、预算/超时都可能造成遗漏。

## 入图与展示

系统在已启用图谱时异步同步快照；发现响应或分页完成不证明已经入图。单快照超过既有 256 KiB 帧等失败可使 Node 快照可读而图谱未同步，按警告说明并回读确认。

新版明确任职形成正式 worksFor 时 employment_status 仍为 unknown，空职位不写 jobTitle/roleName；归属待核实保留人物侧 claims，不产生正式任职边。用库内搜索找到真实人物 ID，再 get_contact 分页核对该人物的来源、线索或正式关系；不能要求机构侧反查全部待核实人物。人工审核沿用维护参考，不因重复发现自动确认或重开线索。

需要图谱展示时复用 search_contacts 的已有联系人图谱 App，说明它展示库内检索范围，不等于本次网页全部观察。discover_contacts 本身没有新增 App；异步未完成时不能用库内暂未命中断言网页资料不存在。
