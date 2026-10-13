# Zoho 联系人接入验证记录

实现分支：`feat/zoho-contact-discovery`，已快进合并到本地 `main`。远程CI验证提交：`e74f315be0e817db4f0e874ce07f5032d320cb34`。

## 已验证

- 11 个定向测试文件，195/195 通过：配置、输入输出契约、服务分页/确认/截止、渲染、MCP HTTP、SDK 隔离和依赖修补。
- `npm run typecheck`、`git diff --check` 通过。
- `node scripts/patch-zoho-sdk.mjs --check` 验证锁定SDK补丁。
- `node --test scripts/validate-zoho-sdk-budget.mjs`：1/1通过，隐式重试不再越过业务预算。
- 真实SDK使用合成的本地HTTP响应，覆盖冷启动、连接/Token隔离、字段白名单、请求挂起和特殊字符；不是实际Zoho CRM验收。
- 最终反例覆盖：定时器尚未执行时工作路径检测截止仍保留已得结果；A已匹配+B待确认时复制参数可重查两组；显式只选B不报告A完成。
- 在线依赖审计仍有既有7项（2 moderate、2 high、3 critical）；新增SDK/form-data条目无已知告警。不宣称整个仓库无漏洞。

## 未验证与边界

- 功能分支已推送，远程完整CI已通过；本地未构建原生程序、浏览器bundle或容器。
- 尚未使用真实CRM授权、对照CRM UI人数和负责人，也未验证真实宿主响应容量。
- 已合并到本地main，未推送main、发布或执行真实CRM查询；不读取真实.env或凭证。
- 本轮覆盖设计第1–10节；第11节联系方式遮蔽不在本次范围。Zoho字段投影不包含联系人或负责人电话邮箱。

## 远程CI结果（2026-10-13）

- 首次CI失败：只读SDK测试以contact-ci运行，尝试chmod runner所有的安装目录，导致EPERM。已修正为校验外部所有者目录不可写；仅修改当前用户拥有的测试目录权限，不放宽非root要求，不跳过只读验证。
- [重跑CI](https://github.com/tang9-c/salestools/actions/runs/38402477884)：两个job均success；93个Vitest文件、1653项测试通过；Python 37项及3个subtests通过；Rust测试、服务端与两个App构建均通过。
- production-container完成生产镜像构建、真实PDF、普通容器隔离与后代进程清理检查；未发布镜像。
- main以快进方式包含被测试的代码提交，后续提交仅更新验收文档。原有未提交README修改已恢复，旧版未跟踪设计/计划备份到 `/Users/tang-codeing/code/salestools-zoho-premerge.vxpggs/`。

下一步仍需专用测试连接和获准查询公司的信息。凭证应在服务环境配置，不粘贴到聊天。
