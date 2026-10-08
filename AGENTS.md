# 项目规则

## 禁止本地构建

- 禁止在本地执行任何构建操作，包括 `npm run build`、`cargo build`、`docker build`、`docker compose build`，以及通过其他命令或脚本触发的等效构建。
- 构建及容器构建验证必须在远程 CI 环境中进行，不得为验证改动而在本机启动构建。
- 只有用户明确撤销此限制后，才可恢复本地构建。

## 联系人上传验证

- `npm run dev` 内部会打包上传页面，同样属于禁止的本地构建；禁止本地启动构建脚本、native 编译或容器构建。
- 本地可执行不产出构建物的类型、语法、diff 检查和解释器测试。native/full-suite/页面 bundle/生产容器 gate 使用 `.github/workflows/contact-upload-validation.yml` 的远程 Ubuntu runner。
- 新验证 workflow 仅只读权限，不发布镜像或部署，不读取生产环境/密钥；使用合成文件、临时数据库、空 CI env 文件。
- 按用户确认的普通容器边界，不依赖 Landlock 或应用安装的 seccomp，不设置 AS/NPROC；保留非 root、只读根、cap_drop、no-new-privileges、默认容器 seccomp 和容器资源限制。真实容器验证不得模拟或跳过；Compose 无网络不代表 Sealos 同 Pod 禁网。
- ChatGPT、Codex 外部页、手机相机的真实宿主验收必须有环境版本、tested SHA、实际结果和脱敏证据；Chromium 模拟宿主通过不能替代。
