# 档案维护与身份核对

## 写入规则

查看不授权修改。明确请求保存/修改/合并/归档/恢复后，先 get_contact 读取真实 ID、版本、证据和原值，再使用对应写工具。
operation_id 稳定，响应丢失保持相同 ID 与完整请求；版本冲突重新读取，不猜版本。归档不是永久删除，恢复需要明确请求。

## 可能重复

- 同名、同名同机构或联系方式匹配仅是可能同一人；授权保存有效资料可独立建档，不阻断、不自动合并。
- 导入与 Zoho 同步可在现有线索中长期保存 possible_duplicate；查看任一端可见。它不成为正式边，也不参与职业搜索、问答或向量；原件清理不使线索到期。
- 匹配失败/截断须说核对不完整，不能说没有重复。记录名称是发现时快照；相同理由不证明身份。已处理线索不自动重新打开，不承诺回填历史库。
- 确认同一人并授权合并：读取双方版本，用 merge_contacts，成功后回读存续档案与线索。不能用 review_contact_claim(action=confirm) 建“同一人”边；解决指定对象不代表其他提示已排除。
- 确认不同人或明确忽略：读线索实际 subject_id 的当前版本，即使用户当前查看另一端；用 review_contact_claim(action=reject)，附稳定 operation_id、expected_entity_version 和 1–500 字 confirmation_note。说明是确认不同人还是仅忽略；暂缓不授权拒绝。

## 其他待核实线索

按分页读取完整 claim，核对实际主体、目标、原文及版本，再 review_contact_claim。
确认需 1–500 字说明；目标未正确定位时先提供正确 target_id。弱引文不能当人工确认。
$experience 等未定位经历不能直接确认成 Person 属性；应核对具体经历后在授权范围内写正确关系，并明确处理旧线索。
学校上的旧 properties.major 错误 claim 同样不能直接确认或自动迁移。

## 字段归属

| 信息 | 保存位置与解释 |
| --- | --- |
| 个人姓名、联系方式、技能 | Person；技能缺失不阻止有效人物保存。 |
| 爱好、婚姻、籍贯、即时通讯 | Person.extensions；婚姻字段与 spouse 关系不互推。 |
| 学校/公司自身资料 | Organization；不把人物的专业或职位写成机构属性。 |
| 专业、教育层次、就读时间 | 对应 alumniOf.properties.major/educationLevel/startDate/endDate；本科不证明毕业/学位。 |
| 任职岗位/时间、项目角色/时间 | 对应 worksFor/memberOf；jobTitle 本身不证明某公司任职。 |

可疑教育/任职信息保留在 Person 指向相应机构的待核实关系，不挂成学校/公司事实。
联系方式和敏感关系只按证据或明确确认保存，不从姓名、公司、照片推断。
未知字段按实际工具 Schema 和仓库 [数据契约](../../../docs/superpowers/specs/contact-data-contract.md) 核对，不凭 skill 猜测。
