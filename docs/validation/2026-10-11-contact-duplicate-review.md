# 联系人重复核对与安全合并验证

## 本次范围

- 同名也提示可能重复；只有候选雇主可唯一对应已有机构节点，且已有联系人存在指向该节点的正式 `worksFor`，才提示同名同机构。名称歧义不自动判定机构身份。
- 不自动合并。重复建议、匹配失败或截断阻止自动创建；用户仍可在聊天中明确选择合并、新建或跳过。
- 导入合并默认保留已有单值，补空值，数组追加去重；显式字段取舍仍走现有接口，新旧证据保留。
- “暂不决定”不调用提交／取消，不产生新任务状态；恢复时重新读取预览与服务端允许条件。会话到期仍遵循原规则。
- 不修改两个已入库档案的合并算法、不迁移历史档案、不引入自动身份评分。

## 已验证

解释器与 Chromium 模拟宿主测试（无本地构建）：

```sh
CONTACT_UPLOAD_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node node_modules/vitest/vitest.mjs run \
  tests/contact-identity-match.test.ts tests/contact-import.test.ts \
  tests/contact-upload-browser.test.ts tests/contact-import-lifecycle.test.ts \
  tests/contact-import-choice-limit.test.ts tests/contact-upload-app.test.ts \
  --exclude '.worktrees/**' --reporter=dot
```

64 项通过，1 项构建产物测试未执行。新增用例先复现同名漏提示、跨候选页机构未用于比较、自动创建未阻断、异常档案被误当作无重复，以及暂缓操作缺失；修改后通过。类型检查、Rust 格式／语法解析检查与 `git diff --check` 通过；格式检查不是 Rust 编译或运行测试。

## 待远程验证

仓库禁止本地 Rust 编译及页面构建。本次补充 `rust/contact-graph/tests/import_commit.rs` 真实存储测试：单值冲突不覆盖、显式替换、技能追加去重、空输入不清空、缺失字段补齐、新旧证据均保留。尚未运行，不能宣称已通过。

提交并获得推送授权后，使用现有 `.github/workflows/contact-upload-validation.yml` 验证匹配源码的 Rust 二进制、真实存储与构建后的页面。不使用旧本地二进制替代。尚未提交、推送、发布或部署，真实 Codex 宿主和线上行为未验收。
