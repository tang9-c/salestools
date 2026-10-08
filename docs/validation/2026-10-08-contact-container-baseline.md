# 普通容器联系人导入验证

## 范围与边界

本次按用户确认移除应用内 Landlock/seccomp，只保留一种普通容器运行方式；Docling、上游接口和图谱存储逻辑不变。容器是隔离边界，不再保证逐文件内容隔离、同 Pod 禁网或恶意进程不能另建 session。保留非 root、只读 Worker 根、默认容器 seccomp、cap_drop、no-new-privileges、凭证隔离和容器资源额度。

## 本地结果

- 仅运行解释器测试、类型及语法检查，未执行本地构建。
- 修改前解析进程/Worker 启动基线：12 项通过。
- 普通运行入口：默认路径无需测试模式；合成 PDF、Unix socket 预检与解析通过。
- 定向测试覆盖：限流窗口、同用户多 Token/MCP/页面会话共享、旧任务幂等重放不计数、其他用户独立额度、失败持久化已有链路、超时/取消/深目录清理、输入校验。
- 最终合并运行 10 个文件、132 项 Vitest 测试全通过，另 2 项 Python 测试全通过。
- Python 运行准备 2 项通过：白名单/离线/线程设置、额外 FD 关闭、继承 AS/NPROC 不变、剩余限制和符号链接拒绝。
- `tsc --noEmit`、`node --check scripts/contact-container-smoke.mjs`、`git diff --check` 通过。
- 用户授权真实 PDF：`J运维简历.pdf`，默认入口解析成功；2 页、75 块、3612 字符、12353ms。未输出正文或联系方式，未调用模型或写正式联系人库。此结果仅证明本地解析，不等于完整导入或 Sealos 验收。
- Skill 基线读取仍要求 Landlock；修改后独立读取正确识别普通容器边界、同 Pod 不禁网以及限流后原操作重试。
- Sealos YAML 解析检查通过：双容器同镜像、上传/解析磁盘卷、socket 内存卷、service-account Token 自动挂载关闭；不是集群应用结果。

## 待完成门禁

- 远程 Linux 完整 Python/Vitest/Rust/页面/生产容器验证，记录 tested SHA 和运行链接。
- 新镜像发布和双容器同步更新。
- Sealos 真实文件上传、预览、确认入库及回读；本机没有集群访问配置，不能以本地结果替代。

内存/PID 验证为真实 cgroup 额度核对，不宣称恶意资源耗尽压测已通过。
