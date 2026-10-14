# 联系人导入与恢复

## 入口与告知

文件/名片优先 `open_contact_upload` 内嵌页面，让用户选择 PDF/图片或拍摄名片。
宿主不支持时给工具返回的短时链接；用户指定自动化或 UI 不可用且本地路径有授权时，可用鉴权的 `/contact-files` 或 `contacts:upload` CLI 取得 `file_id`，再 `import_contacts`。
文字用 `import_contacts_text({text,operation_id})`：非空、最多 20,000 字符，跳过上传和 Docling。

选文件前告知原件临时存储、提取文字送服务配置模型、确认后写共享库。
文字同样送模型，原文保存为来源；预览不返回全文。文件完成/失败/取消/到期清理原件，字段与短证据保留；不要把文件清理承诺套在文字原文上。

## 预览与保存

1. 两个导入入口只生成候选。保存 `import_id`，用 `get_contact_import` 查看状态与分页预览。仅 `ready_for_review` 能提交；failed/cancelled 不算成功。
2. 读取候选、短引文、review_items、关系建议、覆盖范围、警告及重复提示。技能为空或可选经历提取失败，不阻止有效人物保存；主体不明确或处理范围不完整须说明。
3. App 流程由用户在页面核对并点击确认；“暂不保存”只停留预览，不提交/取消，可继续核对。不能代用户点击保存或选择合并。
4. 聊天/CLI 流程明确授权保存或导入后，主体与证据明确时默认 `commit_contact_import(auto_create:true)`，无需逐字段确认。只要求提取或预览则不提交。
5. 携带当前 `preview_version`，提交 `operation_id` 固定为 `contact-import:<import_id>`。同 ID 同请求重试；版本冲突重新读取并核对，不能自动套用旧预览。

自动提交每份资料只建一个有实质内容的主体 Person，以及证据充分的 Organization/Project。
证明人、推荐人、紧急联系人不当作主体。名片姓名、公司与职位归属明确可形成正式 worksFor，日期缺失留空，不称已核实现任。
雇主 worksFor、学校 alumniOf、项目参与 memberOf、项目客户 clientOrganization 分清；其余有效建议保留 unverified。正式文件事实仍须注明来自文件、未经人工核对。

多人无法确定主体或无可提交人物时自动提交会拒绝且不部分写入，询问具体归属。
明确合并/新建/跳过或修改时用 choices/relation_choices；同份资料手工模式也不能新建两个 Person。
合并要求 target_id 与 expected_target_version；身份与字段规则见 [维护与身份核对](record-maintenance.md)。

## 恢复与停止

- 保存原操作 ID；响应丢失原样重试，不重新提取、重传已接收文件或生成新任务来猜测。原样重试是幂等回放，没有自动断点续跑。
- App 刷新/关闭不能恢复原内存凭据；有任务 ID 先查询原任务，或重开入口。外部页可尝试受限 Cookie 恢复，失效/退出/服务重启后重开。短码过期或已兑换时重开，任务 ID 本身不提供授权。
- 容量满按返回提示处理，不自动反复新建会话；限流按 retry_after_seconds 等待。成功回执丢失先查任务；回执失效不能证明未入库。
- “退出上传”撤销页面操作会话，不撤销已有写入或自动取消任务。明确要求取消才对原任务 `cancel_contact_import`。
- 用户暂缓身份判断时保留资料与线索；只预览尚未授权保存时保留任务，不擅自提交或取消。

## 完成标准

提交成功后用返回真实 ID 回读档案与关系，分别说明已保存、待核实和未处理范围。
processed_block_ids/unprocessed_block_ids 与警告不足时不称完整提取；匿名档案可按学校/公司搜索，明确授权后在原 ID 补名。
不把完整简历、OCR 原文或个人联系方式自动复制进发现结果或聊天回答。

部署和环境排错按仓库 [QUICKSTART](../../../docs/QUICKSTART.md)，不把某次运行故障写成所有导入的必要步骤。
