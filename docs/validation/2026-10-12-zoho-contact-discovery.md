# Zoho 联系人接入验证记录

实现分支：`feat/zoho-contact-discovery`。代码验证提交：`ec48da34249c31e4c9f32bcb2a2c3b183e653990`。

## 已验证

- 11 个定向测试文件，195/195 通过：配置、输入输出契约、服务分页/确认/截止、渲染、MCP HTTP、SDK 隔离和依赖修补。
- `npm run typecheck`、`git diff --check` 通过。
- `node scripts/patch-zoho-sdk.mjs --check` 验证锁定SDK补丁。
- `node --test scripts/validate-zoho-sdk-budget.mjs`：1/1通过，隐式重试不再越过业务预算。
- 真实SDK使用合成的本地HTTP响应，覆盖冷启动、连接/Token隔离、字段白名单、请求挂起和特殊字符；不是实际Zoho CRM验收。
- 最终反例覆盖：定时器尚未执行时工作路径检测截止仍保留已得结果；A已匹配+B待确认时复制参数可重查两组；显式只选B不报告A完成。
- 在线依赖审计仍有既有7项（2 moderate、2 high、3 critical）；新增SDK/form-data条目无已知告警。不宣称整个仓库无漏洞。

## 未验证与边界

- 尚未推送或运行远程完整CI；本地未构建原生程序、浏览器bundle或容器。
- 尚未使用真实CRM授权、对照CRM UI人数和负责人，也未验证真实宿主响应容量。
- 未合并、发布或执行真实CRM查询；不读取真实.env或凭证。
- 本轮覆盖设计第1–10节；第11节联系方式遮蔽不在本次范围。Zoho字段投影不包含联系人或负责人电话邮箱。

下一步需获得功能分支推送/现有CI运行授权，以及专用测试连接和获准查询公司的信息。凭证应在服务环境配置，不粘贴到聊天。
