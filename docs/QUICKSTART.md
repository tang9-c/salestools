# salestools 快速入门

这份指南覆盖联系人本地文件上传、共享图谱，以及 Codex 客户端的 MCP 注册和原有五个工具。它假设 salestools 服务端已经部署，并且你已经拿到服务端的 HTTPS 地址和个人 Bearer Token。

## 你需要准备什么

- Codex CLI 已安装并能正常运行。
- salestools MCP 地址， `https://oojyeijszmwy.sealosbja.site/mcp`。
- 管理员为你创建的 Token。Token 明文只在创建时显示一次。
- 你的销售用户标识，例如 `sales-qx`。

MCP 注册不会替你部署服务端，也不会创建 Token。服务端地址和 Token 缺一不可。

## 在聊天中上传 PDF 或名片

联系人图谱启用后，调用 `open_contact_upload`。支持 MCP Apps 的客户端可在内嵌页面点“选择 PDF／图片”或“拍摄名片”；Codex 或不支持内嵌页面的客户端打开工具返回的短时外部链接。链接 60 秒内只能兑换一次，过期或已兑换时重新调用工具。一次会话接收一份 PDF/JPG/JPEG/PNG，最多 20 MB；手机是否能直接调用相机取决于真实宿主和浏览器，仍需实际验收。

选择文件前，页面告知：原件临时存储，提取的文字会发送给服务配置的模型，用户确认后资料写入共享联系人库。上传后先等待识别，再核对所有候选、字段、短证据、关系建议、待核实项及处理范围。仅当主体唯一、预览完整、原件无未处理文本块、匹配完整且没有重复建议时，才能点“确认导入”。完整预览及是否可确认由服务端统一返回，确认时重新检查同一规则；页面仅在服务端明确允许时启用按钮。页面不自动提交；需要人工处理时，保留 `import_id`，回到聊天调用 `get_contact_import` 核对并决定后续操作。

上传或网络失败按页面提示重试当前步骤；HTTP 上传已被服务接收时不会再次上传同一文件。版本冲突会重新加载完整预览，须重新核对并再次确认。App 刷新或关闭后，内存凭据丢失，原会话不能恢复；使用原 `import_id` 在聊天查进度，或重新调用 `open_contact_upload` 建立新会话。外部页面刷新可以尝试通过受限 HttpOnly Cookie 读取原任务，但会话失效或服务重启后也需要重开。不要把任务编号当作权限凭据。

“退出上传”立即关闭本页操作并请求撤销会话及成功回执；仅关闭页面不保证立即撤销服务端会话。退出不撤销已经写入的联系人，也不代表后台导入已取消；需要取消时在聊天中对原 `import_id` 调用 `cancel_contact_import`。服务端退出未确认时，页面明确显示该状态。成功确认后，上传、预览、新提交权限立即撤销；若成功响应丢失，原凭据、原预览版本和同一会话可重试固定最小成功回执。回执仍受原两小时期限、源 Token 启用状态、显式退出、进程重启和最多 1000 条容量淘汰影响，不能保证长期恢复。导入启动 operation 的重放另有图数据库持久化记录；页面重开后通过原 `import_id` 恢复聊天处理。

页面不会拿到个人长期 Token，App 受限 Bearer 只在内存中；外部链接不包含能直接提交的会话密钥，兑换后立即清除 URL 的交接码。原件默认放在临时目录 `salestools-contact-uploads`，必须位于 `/data` 和数据库备份范围之外。导入完成、失败、取消、未提交文件到期或服务清理时删除；原件与完整 OCR 正文不写入图谱，字段及短来源证据仍会保存。临时原件清理失败必须作为运维错误处理，不能报告为已删除。

## 解析 worker 的部署要求

`compose.contact-upload.yaml` 将服务与解析 broker 分为两个容器，两者共享一个必填 `SALESTOOLS_IMAGE`。**构建只在远程 CI 执行**；部署时指定已发布且验证过的完整镜像名，不分别填写两个版本。模板已固定 socket、临时卷、权限及联系人启用配置；管理员只需选择镜像版本并配置 `.env` 中的上游凭证、域名及数据库设置。解析使用单一普通容器运行方式，不依赖 Landlock、libseccomp 或应用安装的 seccomp，不提供严格/兼容双模式。

部署已有镜像时执行 `docker compose -f compose.contact-upload.yaml pull` 和 `docker compose -f compose.contact-upload.yaml up -d --no-build`，不要在部署机或本机运行 build。Worker 启动检查上传目录可读、socket 目录可写、Python 可执行，并使用镜像内合成 PDF 执行预检；通过后才监听 socket。健康检查实际请求 Worker。预检不加载 Docling 模型、不证明任意简历都能解析，资源问题仍需真实导入验证。

Sealos 已有 `salestools` StatefulSet 可使用 [最小补丁](../deploy/sealos-contact-upload.patch.yaml)，不是重新创建应用：发布包含本次启动检查的镜像后，只替换其中一处 `REPLACE_WITH_RELEASED_VERSION`，两个容器同步使用；不能直接使用旧 `v0.5.6`，其 Worker 没有新增健康接口。保留原有凭证、域名、Service 及 `/data` 持久卷。补丁固定临时卷、UID/GID、主服务的 TMPDIR 与 Worker 对应子目录，避免对 root 所有的挂载根目录 chmod。Worker 不应设置 `envFrom` 或复制主服务凭证；若现有 Worker 已有这些配置，须移除。

在 Sealos 终端将补丁保存为 `sealos-contact-upload.patch.yaml` 后执行：

```bash
kubectl patch statefulset salestools -n ns-ufdahkjt --type=strategic --patch-file=sealos-contact-upload.patch.yaml
kubectl rollout status statefulset/salestools -n ns-ufdahkjt --timeout=180s
```

补丁不删除 PVC，但滚动更新会中断当前处理任务并清空 Pod 临时原件，应用前先等正在处理的导入结束。Sealos 页面后续保存设置可能覆盖终端补丁，更新镜像后应核对两个容器及挂载。**同 Pod 共享网络；此方案不承诺 Sealos Worker 禁网。** PID 上限由节点运行时管理。补丁关闭 `automountServiceAccountToken`，Worker 不接收上游密钥、不挂载数据库或宿主 socket。它与 Compose 的无网络环境不完全等价。

Worker 启动失败只输出固定错误码和提示，不回显任意异常消息、文件路径或凭证：目录问题检查共享卷和 UID 1000；`WORKER_PYTHON_UNAVAILABLE` 检查完整镜像；`WORKER_INIT_FAILED` 检查 Python 运行时和文件权限；`WORKER_TIMEOUT` 检查资源限制。`contact_worker_ready` 只表示启动预检通过；主服务 `/healthz` 返回 200 不代表真实简历解析已通过。

- Linux x86_64 或 aarch64，使用容器运行时默认 seccomp，无特殊内核 ABI 要求。CI 使用 cgroup v2 核对实际 CPU/内存/PID 限额。
- 保持 worker 的 `network_mode: none`、只读根文件系统、非 root `node` 用户、`cap_drop: [ALL]`、`no-new-privileges`、`init: true`。不得用 privileged、增加 capability 或关闭过滤器让验证通过。
- Worker 初始验证额度是 4 GiB 内存、2 CPU；Compose 使用 64 PID，Sealos 节点上限另行核验。这不是已测出的最低配置。不再主动设置 AS/NPROC，避免限制模型虚拟地址空间或同 UID 线程数；内存/PID 由容器管理。解析器保留 CPU 120 秒、128 FD、单文件 256 MiB、禁止 core dump，不提高继承的更低限制。预检墙钟 30 秒、解析 120 秒，并在结束、错误、超时或取消后杀死普通子进程组；不承诺阻止恶意进程另建 session 逃逸。
- Sealos 上传和 Worker `/tmp` 各使用 1 GiB **磁盘** emptyDir，socket 使用 1 MiB 内存卷。补丁显式设置 `medium: ""`，避免战略合并保留旧 Memory 值。Compose 仍使用 tmpfs，内存开销需计入额度。原件不放入 `/data`、持久卷或备份；基础镜像 `/data` 空匿名卷不能替换为应用数据库卷。
- 解析器只接收白名单环境、离线模型路径和线程控制，关闭额外 FD；不继承上游凭证。安全边界是独立容器，不再承诺单文件内容隔离或同 UID broker 防篡改。Worker 能读取共享上传目录中的其他原件；MCP/HTTP 任务归属检查仍生效，这不是内核级隔离。
- 认证后的同一用户（多个 Token/上传会话共用）上传尝试和新导入分别每 60 秒最多 5 次。HTTP 返回 429、`Retry-After` 和 `retry_after_seconds`；MCP 返回 `CONTACT_RATE_LIMITED` 工具错误。已存在任务用原 operation_id 重试不计数；限流不删除已上传文件，等待后重试。计数仅单实例内存保存，重启清零，不是多副本配额平台。

该轻量计数不提供精确计费保证：首次任务尚未持久化时同时发出的请求仍可能各计一次；已有持久化任务的重放则不计数。无需为此额外建立请求锁或串行提交队列。

## 远程验证与真实宿主验收

历史旧沙箱门禁在提交 `d965bdbd2b73683b7585077e50b531fb2127f65f` [运行 36704210079](https://github.com/tang9-c/salestools/actions/runs/36704210079) 通过，但不能作为本次普通容器版本的验收。新版本须完成以下远程门禁及真实导入。ChatGPT、Codex 外部浏览器与手机相机的真实宿主验收仍需分别记录，不能由 Chromium 模拟替代。

`.github/workflows/contact-upload-validation.yml` 在 PR、`codex/contact-upload-*` 分支 push 或手动 dispatch 时运行，只读仓库，不发布镜像、不部署、不读取生产凭据。在 Ubuntu 安装锁定依赖，编译/测试 Rust、检查类型、打包页面、运行完整 Python/Vitest/Chromium，再构建生产 Worker 镜像，验证实际容器控制、真实 PDF、CPU/期限/取消及深目录清理。旧 Landlock 拒绝探针已删除，不用跳过或测试模式伪装通过。内存/PID 核验是 cgroup 配置检查，不宣称完成恶意资源耗尽压测。

在已推送的特性分支上查看或重跑远程门禁（本地只调用 GitHub API，不构建）：

```bash
rtk proxy gh run list --repo tang9-c/salestools --workflow contact-upload-validation.yml --branch codex/contact-upload-你的分支
rtk proxy gh workflow run contact-upload-validation.yml --repo tang9-c/salestools --ref codex/contact-upload-你的分支
rtk proxy gh run watch <run-id> --repo tang9-c/salestools --exit-status
```

新 workflow 首次尚未进入默认分支时，dispatch 可能不可用；特性分支 push 会自动运行。CI 用空的临时 `SALESTOOLS_ENV_FILE` 满足 Compose 的全配置解析，无需 `.env` 或 `production.env`。以下命令仅用于远程 Linux CI runner，在该 runner 构建镜像后执行：

```bash
: > "$RUNNER_TEMP/contact-upload-ci.env"
export SALESTOOLS_ENV_FILE="$RUNNER_TEMP/contact-upload-ci.env"
docker compose -f compose.contact-upload.yaml run --rm --no-deps contact-worker node /usr/local/bin/contact-container-smoke.mjs
```

真实宿主验收使用合成文件和一次性库，为每项记录日期、revision、客户端/OS/浏览器版本、结果、脱敏截图或日志位置。尚未提供环境，下面均未验收：

- [ ] ChatGPT MCP Apps：打开页面、文件选择、完整预览、人工确认、失效/退出、真实 `ui/resource-teardown`；证据：待填写。
- [ ] Codex 外部 HTTPS 页：短码过期/重放、Cookie 同源限制、刷新、确认回执重试及聊天恢复；证据：待填写。
- [ ] 手机真实相机：系统/客户端版本、拍照权限、取消拍摄、JPG/PNG 上传及可读预览；证据：待填写。
- [ ] 各宿主 XSS 文本、失败重试、版本冲突、未处理块/重复建议阻止确认及返回 `import_id`；证据：待填写。
- [x] 远程 CI：提交 `d965bdbd2b73683b7585077e50b531fb2127f65f` 的[运行 36704210079](https://github.com/tang9-c/salestools/actions/runs/36704210079) 两个 job 全绿；Python JUnit 零跳过，原失败的 HTTP/MCP 用例通过。

## 批量上传本地联系人文件

联系人导入功能启用后，可在本仓库目录运行上传 CLI。它只接受本地 PDF、JPG、JPEG、PNG 文件，每个文件最多 20 MB。使用远程 CI 已构建的 CLI 产物或镜像，设置完整上传地址与个人 Token，再依次列出文件路径。本项目禁止本地构建；不要运行 `npm run build` 或 `npm run dev`（后者也会打包页面）：

```bash
export CONTACT_UPLOAD_URL='https://你的服务域名/contact-files'
export CONTACT_UPLOAD_TOKEN='粘贴管理员提供的 Token'
npm run contacts:upload -- ./简历.pdf ./名片.png
```

CLI 逐个上传并输出 JSON：`accepted` 列出已接收的本地路径和 `file_id`，`unuploaded` 列出失败文件及尚未尝试的文件。容量满额时以非零状态结束；请记录已接收的 `file_id`，待服务端释放名额后自行重试 `unuploaded` 中的路径。上传不会自动发起联系人抽取、等待名额或续传。Token 只从 `CONTACT_UPLOAD_TOKEN` 环境变量读取，不要作为命令行参数传入。

直接粘贴文字时，调用 `import_contacts_text({text:"林知远，云杉测试科技有限公司研发经理，邮箱 lin@example.com。",operation_id:"自己生成并保持不变的操作编号"})`。最多 20,000 个 UTF-16 代码单元，不需要文件或上传会话，也不调用 Docling；输入会发送给服务配置的模型。返回 `import_id` 后，仍通过 `get_contact_import` 查看候选，由用户确认后调用 `commit_contact_import`。原文保存在导入任务中，字段和关系标记为用户文字来源并保留短引文；不等于外部核实。需要修改输入文字时使用新操作编号；相同请求重试不重复抽取。

上传成功后，在启用了 `CONTACT_GRAPH_ENABLED=true` 的服务中，使用返回的 `file_id` 调用 `import_contacts`，并自定一个以后重试仍保持不变的 `operation_id`。再用 `get_contact_import` 查看状态、候选和短证据。单主体简历到达 `ready_for_review` 后，可调用 `commit_contact_import({import_id,preview_version,operation_id:"contact-import:<import_id>",auto_create:true})`：服务创建一个有证据、可提交的主体 `Person`，以及有定位证据的组织、项目节点；明确的任职、就读、项目参与和项目客户关系会以文件证据自动入图，弱建议保存为 `unverified` 线索。项目客户不会被当作雇主。证明人、推荐人或紧急联系人不作为主体抽取或自动建档；多个仍可提交、无法判定主体的人物或没有可提交主体时，自动模式拒绝且不部分写入。需要合并、跳过或修正字段时仍可使用 `choices` 和 `relation_choices` 手工提交，但同一文件不能选择创建两个 `Person`。系统不会因号码相同而自动合并；响应丢失时用相同提交请求重试。不准备提交时可用 `cancel_contact_import`。

导入结果应同时报告已保存的档案／关系、待核实线索和未处理范围（`processed_block_ids`、`unprocessed_block_ids` 及警告）。Docling 负责读出正文，LLM 负责跨块归属和语义归纳；来源引文能定位并不代表已经人工核实。没有姓名的有效简历可保存匿名档案，随后用 `save_contact` 在原 ID 补姓名。求职意向不作现任，在读不代表毕业。

综合查找学校、公司或项目客户时使用 `search_contacts` 的 `include_unverified:true`，按 `match_status` 标记弱结果；默认正式查询和问答语义不变。用 `get_contact({entity_id,claim_offset,claim_limit})` 核对并按返回分页继续读；项目客户的 claims 可能分别属于 Person 和 Project。确认／拒绝用 `review_contact_claim`（确认须审核说明），错误正式字段用 `save_contact` 配合当前版本及真实修正证据。无须导入前逐项人工审核。相同 operation_id 重试不会重新抽取，未处理内容没有自动断点续跑；新操作会提示重复文件，不自动合并。


无真实姓名和手机号的简历也可入库：匿名候选须有已定位的技能等实质字段证据，或有来源明确、归属于该主体的就读／任职关系。满足条件且只有一个实质人物时，可用同一 `auto_create:true` 模式创建匿名 `Person`，不要填写“未知姓名”等占位 `name`。未确认的任职／就读线索可用 `search_contacts({query:"公司名",mode:"keyword",include_unverified:true})` 或学校名查找，结果标为 `unverified`；已确认关系可用普通 `search_contacts` 查找。结果的 `name` 为 `null`，`display_name` 由稳定 ID 派生。用 `get_contact` 查看资料、证据及线索；确认真实姓名后用 `save_contact` 在同一 `entity_id` 补录。只看到孤立机构名，既没有人物实质字段证据、也没有明确归属的就读／任职关系时，自动模式不创建空白人物。不同简历不会自动合并，原件及完整 OCR 文本不会持久化到图谱。

预览将已定位字段放在 `properties`，缺证据、求职意向或归属不明的线索放在 `review_items`；弱关系带 `uncertain=true` 和原因。一个字段待核实不会阻断其他有证据字段。自动提交后，定位明确的关系写为正式边，其他有效建议写为来源实体的 `unverified_claims`；`confirmed` 只表示图谱事实，不代表人工核对。用 `search_contacts({query:"客户公司名",mode:"keyword"})` 可沿“人物 → 项目 → 客户组织”查人，结果带 `matched_project_id`；项目参与或客户关系有待核实的一跳时，使用 `include_unverified:true` 才会命中，并显示 `claim_ids`。`organization_id` 仍只过滤任职／就读，不按客户过滤。可用 `get_contact` 依次查看人物与项目的关系、短证据和待核实线索，用 `review_contact_claim` 确认或拒绝；`ask_contacts` 不会把项目客户当成雇主。原件与完整 OCR 正文不会写入图谱。

默认搜索与 `ask_contacts` 只使用正式图谱事实。需要寻找尚未核实的线索时，显式调用 `search_contacts({query:"学校或技能关键词",mode:"keyword",include_unverified:true})`，检查每条结果的 `match_status` 和 `claim_id`；`confirmed` 表示正式图谱命中，不一定经过人工审核。待核实查询不支持 semantic／hybrid，也不会进入语义向量。用 `get_contact({entity_id:"…",claim_offset:0,claim_limit:20})` 独立分页查看 `unverified_claims` 的值、原因和短来源。

核对后调用 `review_contact_claim`，提供 `claim_id`、`action:"confirm"` 或 `"reject"`、稳定的 `operation_id`、当前人物的 `expected_entity_version`。确认必须附 1–500 字符的 `confirmation_note`；必要时提供 `corrected_value`，未关联机构的关系还须提供已创建机构的 `target_id`。确认会生成手工审核证据，不冒充原文件引文；拒绝仅改变线索状态。每次审核后重新读取版本，重试同一次操作时保留原参数与 `operation_id`。两段任职须分别审核并保留独立关系。同一文件仍出现多个可提交人物片段时，先核对身份再用 `merge_contacts` 明确选择保留字段；待核实线索会随人物合并转到保留的档案，随后仍需逐条审核。

图谱中查人使用 `search_contacts`（姓名、关键词、组织、职位、技能，可分页）；查看完整档案和证据使用 `get_contact`；问配偶、亲子或任职等问题使用 `ask_contacts`，同名或证据不足会要求澄清或拒答。`discover_contacts` 保持原有公开网页搜索与快照语义，不是共享图谱查询。语义/混合检索只有在服务端另配 `ARK_EMBEDDING_API_URL`、`ARK_EMBEDDING_MODEL`、`ARK_EMBEDDING_CREDENTIAL` 后可用；未配置时选 `mode=keyword`。失败索引可用 `retry_contact_index` 指定 `entity_id` 和稳定的 `operation_id` 重试。

发布前的质量评测会上传 12 份虚构样本并创建联系人，因此只在使用**一次性数据库**的隔离测试服务上运行。给评测进程设置 `CONTACT_EVAL_MCP_URL`（以 `/mcp` 结尾）、`CONTACT_EVAL_UPLOAD_URL`（同源、以 `/contact-files` 结尾）和 `CONTACT_EVAL_TOKEN`，并提供 `CONTACT_EVAL_DEPLOY_REVISION`、`CONTACT_EVAL_DOCLING_VERSION`、`CONTACT_EVAL_OCR_VERSION` 以记录版本；模型元数据读取 `ARK_API_URL`、`ARK_MODEL`、`ARK_EMBEDDING_API_URL`、`ARK_EMBEDDING_MODEL`，也可使用对应的 `CONTACT_EVAL_*` 覆盖项。运行 `npm run contacts:evaluate`，查看 `docs/validation/contact-management-quality.md`；退出码 0 表示全部门槛通过，1 表示已验证失败，2 表示配置不完整。评测端无需读取或打印模型凭据；服务端的模型凭据请只保存在其本地环境中。

## 1. 在终端保存 Token

在当前终端会话中设置环境变量：

```bash
export SALESTOOLS_MCP_URL='https://oojyeijszmwy.sealosbja.site/mcp'
export SALESTOOLS_MCP_TOKEN='粘贴管理员提供的 Token'
```

不要把 Token 写入 Git、聊天记录、截图或提交到配置文件。关闭终端后，如果环境变量没有持久化，需要重新设置。

## 2. 在 Codex 注册 salestools

```bash
codex mcp add salestools \
  --url "$SALESTOOLS_MCP_URL" \
  --bearer-token-env-var SALESTOOLS_MCP_TOKEN
```

检查注册结果：

```bash
codex mcp list
```

如果已经存在同名配置，先查看配置；确认需要替换时再删除并重新添加：

```bash
codex mcp get salestools
codex mcp remove salestools
codex mcp add salestools \
  --url "$SALESTOOLS_MCP_URL" \
  --bearer-token-env-var SALESTOOLS_MCP_TOKEN
```

重新打开 Codex 会话，使新的 MCP 配置生效。向 Codex 发送“列出 salestools 可用工具”，应能看到：

```text
get_company_profile
discover_contacts
submit_assessment
get_assessment_status
get_assessment_report
```

若管理员开启共享图谱，还应看到 `search_contacts`、`get_contact`、`ask_contacts`、`import_contacts`、`get_contact_import` 和 `commit_contact_import` 等联系人工具。看不到时先让管理员检查 `CONTACT_GRAPH_ENABLED` 与独立图谱库路径；这不影响上列原有工具。

## 3. 先查企业基础画像

在 Codex 中输入自然语言请求：

> 请使用 salestools 查询“深圳市海明润超硬材料股份有限公司”的基本情况，地域提示为“深圳”。

Codex 应调用 `get_company_profile`，输入等价于：

```json
{
  "query": "深圳市海明润超硬材料股份有限公司",
  "region_hint": "深圳"
}
```

重点查看：

- `candidates`：候选法定主体、统一社会信用代码和匹配依据。
- `basic_profile`：行业、地区、企业类型、规模线索和经营风险摘要。
- `source_status`：企查查来源是否成功。

只有一个明确匹配主体时，继续确认 `legal_name` 和 `credit_code`。如果有多个候选，不要让 Codex 自动选择，先人工确认法定主体。

## 4. 查询关键岗位人员

确认要研究的企业后，在 Codex 中输入：

> 请使用 salestools 查询这家企业公开网页中的关键岗位人员，地域提示为“深圳”，并列出当前联系人和历史联系人。

Codex 应调用 `discover_contacts`，输入等价于：

```json
{
  "query": "深圳市海明润超硬材料股份有限公司",
  "region_hint": "深圳"
}
```

结果包括企业负责人、研发/技术、数字化/IT、采购和质量负责人，以及可追溯的来源 URL 和发布日期。`historical_contacts` 只是历史任职证据，不代表此人已经离职或当前仍在任。

本工具不返回邮箱、电话等直接联系方式；没有明确职位的专利发明人或招投标联系人不会列出。查询同一企业关键词和地域时，30 天内会复用缓存，不会重复查询上游；不同地域或简称不会自动合并。

## 5. 提交正式销售评估

只有在你确认法定名称和统一社会信用代码，并且明确需要正式评估时，才向 Codex 输入：

> 我已确认法定主体为“深圳市海明润超硬材料股份有限公司”，统一社会信用代码为“这里填已核实的 18 位代码”。请使用 salestools 提交正式销售评估。

Codex 应调用 `submit_assessment`，输入等价于：

```json
{
  "legal_name": "深圳市海明润超硬材料股份有限公司",
  "credit_code": "已核实的18位统一社会信用代码",
  "force_refresh": false
}
```

记录返回的 `assessment_id`。常见返回状态：

- `processing`：任务已提交，等待资料采集和整理。
- `completed`：命中 30 天内的已完成报告，通常会带 `cache_hit: true`。

新任务返回的 `estimated_minutes` 为 `5-40`，这是按真实 Ark 分批耗时给出的宽区间，不是 SLA，也不包含前方其他任务的排队时间。

如果只是想读取已有报告，不要反复提交同一任务。

## 6. 轮询评估状态

当上一步返回 `status: "processing"` 时，向 Codex 输入：

> 请使用 salestools 查询评估任务 `<assessment_id>` 的状态。

Codex 应调用 `get_assessment_status`：

```json
{
  "assessment_id": "上一步返回的 UUID"
}
```

间隔一段时间再查询，直到状态变为 `completed` 或 `failed`。不要修改或猜测 `assessment_id`。

## 7. 读取销售评估报告

状态变为 `completed` 后，向 Codex 输入：

> 请使用 salestools 读取评估任务 `<assessment_id>` 的完整报告，并先告诉我推荐产品、综合机会、来源状态和需要销售核实的问题。

Codex 应调用 `get_assessment_report`：

```json
{
  "assessment_id": "上一步返回的 UUID"
}
```

阅读报告时按这个顺序使用：

1. 看客户摘要和推荐产品。
2. 看七项产品机会及其证据、阻碍和缺口。
3. 查看“销售建议”中的首轮访谈问题。
4. 核对关键证据的来源和采集时间。
5. 将 `待核实`、预算、需求和决策权问题带入下一次客户沟通。

“机会”是公开证据支持的跟进判断，“置信度”是证据支持程度；两者都不是成交概率。报告中的“未发现”也不等于客户没有需求。

## 一次完整使用路径

```text
Codex 注册 MCP
      ↓
get_company_profile：确认企业主体
      ↓ 人工确认 legal_name + credit_code
discover_contacts：准备关键岗位线索
      ↓ 明确要求正式评估
submit_assessment：提交异步任务
      ↓ status = processing
get_assessment_status：轮询
      ↓ status = completed
get_assessment_report：读取报告并准备拜访
```

## 文档导入的抽取预算

文档导入单独配置请求大小，不影响公开网页抽取与问答的 `ARK_REQUEST_MAX_BYTES`（默认 12,288 字节）：

```ini
CONTACT_EXTRACT_REQUEST_MAX_BYTES=32000
CONTACT_EXTRACT_MAX_BATCHES=8
CONTACT_EXTRACT_MAX_MODEL_CALLS=16
```

`CONTACT_EXTRACT_REQUEST_MAX_BYTES` 允许 6,144–64,000 字节，限制完整 JSON 请求，默认 32,000 字节。正文放得下时一次提交全部原块，随后由同一模型各进行最多一次项目清单和技能专注补充；补充也遵守相同字节上限，计入既有总调用预算，不重试。项目补充只接受当前文件可定位的项目名称和参与证据，保留主档案中的其他信息；技能补充只接受可定位的技能证据。主体不明确、正文未完整处理、全文超出补充上限、调用额度不足或模型失败时会告警，已成功提取的档案保留。块处理完成不等于语义覆盖完整，应检查导入预览中的告警与待核实项。

## 常见问题

### 方舟为什么显示 `partial`？

正式评估会把去重后的全部证据拆成多个受字节上限保护的方舟请求。单批失败或总调用预算耗尽时，已成功批次仍会生成报告，但来源状态显示 `ark=partial`，审计缺口会列出失败批次或未处理数量。

部署侧相关配置为：

```ini
ARK_REQUEST_MAX_BYTES=12288
MAX_ARK_CALLS=16
MAX_TOTAL_UPSTREAM_CALLS=32
```

`MAX_ARK_CALLS` 计算实际请求尝试次数，不是批次数；一次失败后的重试还会消耗一次。材料数量较多时，应确保 Ark 和总调用预算足够，否则超出预算的批次会明确标记为未处理。

### Codex 看不到 salestools 工具

确认 `codex mcp list` 中存在 `salestools`，然后检查环境变量仍在当前终端：

```bash
test -n "$SALESTOOLS_MCP_URL" && echo 'URL 已设置'
test -n "$SALESTOOLS_MCP_TOKEN" && echo 'Token 已设置'
```

设置变量后重新打开 Codex 会话。

### 返回 401 或 403

通常是 Token 缺失、已禁用或复制错误。重新设置正确 Token；不要把 Token 放进 URL 或工具参数中。

### 返回 404 或连接失败

检查 URL 是否包含正确的 `/mcp` 路径，生产环境必须使用 HTTPS，并确认网络可以访问该域名。

### 正式评估一直是 processing

使用原始 `assessment_id` 调用 `get_assessment_status`。任务完成前不要重复提交；如果最终为 `failed`，根据返回信息稍后重新提交。

### 找不到联系人

先查看 `warnings` 和 `collected_at`。空结果可能表示公开网页没有满足证据要求的人员，也可能表示资料覆盖不足；不要把空数组理解为企业没有相关岗位。

## 工具速查表

| 工具 | 什么时候使用 | 关键输入 |
| --- | --- | --- |
| `get_company_profile` | 初步了解企业或确认主体 | `query`、可选 `region_hint` |
| `discover_contacts` | 查公开关键岗位姓名和职位 | `query`、可选 `region_hint` |
| `submit_assessment` | 主体确认后启动正式评估 | `legal_name`、`credit_code`、可选 `force_refresh` |
| `get_assessment_status` | 查询异步任务是否完成 | `assessment_id` |
| `get_assessment_report` | 读取完成报告或失败状态 | `assessment_id` |
