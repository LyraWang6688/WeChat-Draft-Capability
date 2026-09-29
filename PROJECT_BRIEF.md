# 项目说明书：飞书多维表格 × 微信公众号后台桥接项目

本文档用于项目交接、与其他 AI 协作、后续上传 GitHub 前统一上下文。

GitHub 仓库地址：

```text
https://github.com/LyraWang6688/wechat-article-pilot
```

## 0. AI 接手必读

如果其他 AI 或开发者接手本项目，请先阅读以下文档：

- `docs/LARK_CLI_INIT_CONTEXT.md`：说明飞书应用初始化和用户授权后，系统实际能拿到哪些信息，以及后续如何使用这些信息。
- `docs/TEMPLATE_SCHEMA.md`：说明「推送草稿表」的 15 个固定字段。
- `docs/WORKFLOW_FEASIBILITY.md`：说明两条 Base Workflow 的可行性和当前实现策略。
- `docs/REMOTE_SERVER_DEV.md`：说明服务器开发执行机模式。
- `docs/AI_HANDOFF.md`：说明当前项目状态、待办、风险、服务器更新命令和给下一位 AI 的交接注意事项。

关于飞书初始化和授权，核心结论是：

- `config init --new` 后，CLI 会在当前执行机器保存应用上下文，例如 `appId`、`brand`、`defaultAs`，以及由 CLI 安全保存的 `appSecret`。
- `auth login` 完成后，CLI 会在当前执行机器保存用户 token，并可通过 `auth status --json --verify` 读取当前授权用户的 `openId`、`userName`、`scope`、`tokenStatus`、`expiresAt` 等诊断信息。
- 业务系统不应读取或依赖明文 `appSecret`、`accessToken`、`refreshToken`。
- 后续 Base 创建、记录读取、状态写回、Workflow 创建都继续通过当前机器上的 `lark-cli base +...` 执行。
- P0 单用户场景可把 `auth status -> identities.user.openId` 作为默认通知人；多人协作场景建议在模板表中增加人员字段，不要只依赖 `recordModifiedUser`。

## 1. 项目定位

本项目是一个中间桥梁，用于连接：

- 飞书多维表格中的文章/草稿数据
- 微信公众号后台的草稿、素材接口

目标是让用户在飞书多维表格中维护公众号文章内容，通过自动化工作流触发后端同步，后端再调用微信公众号 API 创建或更新公众号草稿，并把同步结果回写到对应的飞书记录。

## 2. 总体链路

```text
用户配置前端
  -> 飞书初始化配置 / 模板 Base 创建 / 微信配置
  -> 飞书 Base 工作流监听记录状态
  -> 工作流向后端 Webhook 发送 record_id
  -> 后端通过 lark-cli 读取这条记录完整数据
  -> 后端调用微信公众号 API
  -> 后端通过 lark-cli 回写同步结果到原记录
  -> 飞书 Base 工作流监听写回状态并通知用户
```

## 3. 技术选型

- 前端：静态 HTML + vanilla JS，后端直接 serve。
- 后端：Node.js + TypeScript + Express。
- 飞书侧：`lark-cli`，优先使用用户身份 `--as user`。
- 微信侧：HTTP API，接口包括上传永久素材、创建草稿、更新草稿。
- 配置存储：P0 可本地内存/JSON，后续接 Supabase。
- 部署目标：先本地跑通，再部署到服务器，最终上传 GitHub。

## 4. 轻量前端三大板块

### 4.1 飞书初始化配置

目的：让外部系统具备访问用户飞书资源的前提条件。

包含三个环节：

- 创建飞书应用。
- 开立用户权限。
- 用户扫码/浏览器授权。

当前实现状态：

- 已有 `lark-cli config init --new` 引导式初始化入口。
- 已有 `lark-cli auth login --scope <P0 必需权限> --no-wait --json` split-flow 授权入口，默认申请 Base 创建、表创建、字段读取/创建/更新、视图写入、记录读写、Workflow 创建/启用所需权限。
- 已有授权完成与状态检查接口。

注意：

- `config init --new` 不是完全静默的一键操作，更像 CLI 引导流程。
- 前端应展示引导信息，而不是承诺全自动创建应用和审批权限。

### 4.2 模板多维表格与工作流

目的：自动帮用户创建一个模板化 Base，并搭好后续同步所需的工作流。

模板 Base 至少应包含一张核心表：

```text
推送草稿表
```

模板表已支持通过后端接口创建，字段结构固定为 15 个字段：

| 字段名 | 类型 | 说明 |
|---|---|---|
| `article_id` | 自动编号 | 主键，格式 `yyyyMMdd + 3位序号` |
| `title` | 文本 | 文章标题 |
| `author` | 文本 | 作者 |
| `digest` | 文本 | 摘要 |
| `column` | 单选 | 8 个栏目选项 |
| `content_markdown` | 文本 | Markdown 正文 |
| `content_html` | 文本 | HTML 正文 |
| `cover_image_url` | URL | 封面图 URL |
| `status` | 单选 | 3 个状态选项 |
| `wechat_draft_media_id` | 文本 | 微信草稿 media_id |
| `wechat_upload_result` | 文本 | 微信接口返回结果 |
| `missing_fields` | 文本 | 必填字段缺失 |
| `warning_fields` | 文本 | 非阻断告警 |
| `created_at` | 创建时间 | 记录创建时间 |
| `updated_at` | 修改时间 | 记录更新时间 |

`column` 选项：

```text
造物笔记 / 边走边想 / 书籍推荐 / 热钱之外 / AI 简报 / 从卡点到解法 / 工具炼金术 / 概念补给站
```

`status` 选项：

```text
ready_to_upload / uploaded_to_wechat / failed
```

需要创建两个工作流：

#### 工作流 1：触发后端同步

业务目标：

- 当 `status = ready_to_upload` 时，向本项目后端发送 HTTP 请求。
- 请求体至少携带 `record_id`。
- 后端拿到 `record_id` 后再读取完整记录，不要求 workflow 把所有字段都传给后端。

可行实现：

- 触发器：`ChangeRecordTrigger`，表示新增或修改记录满足条件时触发。
- 动作：`HTTPClientAction`。
- 请求方式：`POST`。
- 请求 URL：部署后的后端 webhook 地址。
- 请求体：通过 `text + ref` 拼接 JSON，引用 `$.step_trigger.recordId`。

建议请求体：

```json
{
  "base_token": "bascnxxx",
  "table_id": "tblxxx",
  "record_id": "recxxx",
  "event": "wechat_draft_sync"
}
```

workflow JSON 中不能直接写固定 `recxxx`，应使用 ref：

```json
[
  { "value_type": "text", "value": "{\"record_id\":\"" },
  { "value_type": "ref", "value": "$.step_trigger.recordId" },
  { "value_type": "text", "value": "\"}" }
]
```

#### 工作流 2：写回状态后通知用户

业务目标：

- 当后端写回 `status = uploaded_to_wechat` 或 `status = failed` 后，飞书自动发消息通知当前授权用户。
- P0 单用户假设是一个用户一个应用一个 Base，不共享；先固定通知初始化并授权的用户，后续多人协作再迭代人员字段或记录操作人策略。

可行实现：

- 触发器：`ChangeRecordTrigger`，表示新增或修改记录满足写回状态条件时触发。
- 动作：`LarkMessageAction`。
- 消息内容引用触发记录中的标题、同步状态、错误信息、记录链接等字段。

注意：

- `LarkMessageAction.receiver` 需要明确接收人。
- 当前实现使用 `auth status -> identities.user.openId` 生成固定用户接收人。
- 接收人后续可以改为记录中的人员字段。
- 如果用记录中的人员字段，需要先确认字段 ID，并使用 `$.step_trigger.fldxxxx` 形式引用。

### 4.3 微信公众号配置

目的：让后端具备调用微信公众号后台 API 的凭证。

前端需要收集：

- 微信公众号 AppID
- 微信公众号 AppSecret / AppKey

后端需要实现：

- 保存配置。
- 获取并缓存 `access_token`。
- 校验凭证是否有效。

安全要求：

- 微信密钥不能返回前端。
- 不应写入 Git。
- 生产环境应存入 Supabase 或服务端安全配置。

## 5. 后端核心模块

### 5.1 LarkCliRunner

职责：

- 统一执行 `lark-cli` 子进程。
- 处理 stdout、stderr、退出码、超时。
- 支持向 stdin 写入 secret。
- 对 JSON 输出做统一解析。

### 5.2 LarkSharedService

职责：

- 飞书 CLI 版本检查。
- 飞书配置初始化。
- 用户授权发起和完成。
- 授权状态检查。
- 后续扩展 profile 隔离。

### 5.3 LarkBaseService

职责：

- 解析 Base URL。
- 创建 Base / 创建表 / 创建字段。
- 创建 workflow / 启用 workflow。
- 读取字段结构。
- 通过 `record_id` 获取完整记录。
- 写回同步状态。

关键 CLI 命令：

```bash
lark-cli base +url-resolve --url "<url>" --format json --as user
lark-cli base +table-create --base-token "<base_token>" --name "推送草稿数据表" --fields @fields.json --as user
lark-cli base +field-list --base-token "<base_token>" --table-id "<table_id>" --as user
lark-cli base +record-get --base-token "<base_token>" --table-id "<table_id>" --record-id "<record_id>" --format json --as user
lark-cli base +record-upsert --base-token "<base_token>" --table-id "<table_id>" --record-id "<record_id>" --json @patch.json --as user
lark-cli base +workflow-create --base-token "<base_token>" --json @workflow.json --as user
lark-cli base +workflow-enable --base-token "<base_token>" --workflow-id "<workflow_id>" --as user
```

### 5.4 WechatService

职责：

- 获取并缓存微信公众号 `access_token`。
- 上传永久素材。
- 创建草稿。
- 更新草稿。

微信侧接口：

- `cgi-bin/token`
- `cgi-bin/material/add_material`
- `cgi-bin/draft/add`
- `cgi-bin/draft/update`

### 5.5 SyncArticleService

职责：

- 接收 `record_id`。
- 读取飞书记录完整数据。
- 根据字段映射组装微信草稿 payload。
- 上传封面等素材。
- 调用微信创建/更新草稿接口。
- 回写同步状态、草稿 ID、错误信息、最后同步时间。

## 6. Workflow 可行性结论

根据 `lark-base` workflow schema，目前两个目标工作流都可以通过 `lark-cli base +workflow-create` 创建。

### 6.1 工作流 1 可行

需求：

```text
字段满足条件 -> HTTP 请求后端 -> 携带 record_id
```

可用节点：

- `ChangeRecordTrigger`：新增或修改记录满足条件时触发。
- `HTTPClientAction`：向后端发送 HTTP 请求。

关键字段：

- `ChangeRecordTrigger.data.condition_list`
- `HTTPClientAction.data.method`
- `HTTPClientAction.data.url`
- `HTTPClientAction.data.headers`
- `HTTPClientAction.data.raw_body`
- `$.step_trigger.recordId`

### 6.2 工作流 2 可行

需求：

```text
写回状态更新 -> 发送飞书消息给当前授权用户
```

可用节点：

- `ChangeRecordTrigger`：新增或修改记录满足写回状态条件时触发。
- `LarkMessageAction`：发送飞书消息。

关键字段：

- `ChangeRecordTrigger.data.condition_list`
- `LarkMessageAction.data.receiver`
- `LarkMessageAction.data.title`
- `LarkMessageAction.data.content`
- `LarkMessageAction.data.btn_list`

### 6.3 需要实测的点

- workflow 创建时，`condition_list` 对单选字段是否必须用 `value_type=option`，还是文本字段可用 `text`。
- `HTTPClientAction.raw_body` 中 `$.step_trigger.recordId` 的实际输出是否稳定。
- `LarkMessageAction` 暂用最小可识别结构：固定授权用户 `{ id: openId, name: userName }`、纯文本内容、空按钮列表；动态记录链接按钮后续确认 schema 后再加回。
- 后端回写状态后是否会触发第二个工作流，以及是否需要避免循环触发。

## 7. 仍需确认的信息

已确认：

- 模板表字段清单：见 `docs/TEMPLATE_SCHEMA.md`。
- 触发字段：`status`。
- 触发条件：`status = ready_to_upload`。
- 写回字段：`status`。
- 写回值：成功 `uploaded_to_wechat`，失败 `failed`。
- 飞书消息通知接收人规则：P0 固定通知当前授权用户。
- 微信侧：当前阶段先不考虑。

仍需确认：

- 本地联调用的公网 webhook 地址：本地可先用 ngrok / frp / 公网测试服务。
- 服务器部署后的正式 webhook 域名。
- Workflow 中固定用户接收人的实际 value 结构仍需在真实 Base 中实测；多人协作阶段再考虑增加人员字段作为通知接收人。
- `ChangeRecordTrigger.condition_list` 对单选字段 `status` 的实际 value 结构，需要在真实 Base 中实测。

## 8. 下一步代码修改路线

### 阶段 1：飞书侧后端能力补齐

- 给 `LarkBaseService` 增加 `getRecord`。
- 给 `LarkBaseService` 增加 `createTable` / `listTables` / `getTable`。
- 给 `LarkBaseService` 增加 `createWorkflow` / `enableWorkflow`。
- 调整 `record-list` 强制 JSON 解析并返回 `raw`。
- 大 JSON 参数改为临时文件方式：`--json @file.json`，避免 Windows shell 转义问题。

### 阶段 2：模板创建

- 新增 `TemplateBaseService`。
- 定义 `push-draft-table.schema.ts`。
- 定义 `workflow-sync-request.template.ts`。
- 定义 `workflow-status-notify.template.ts`。
- 新增接口 `POST /api/templates/wechat-draft/setup`。

### 阶段 3：Webhook 与同步编排

- 新增接口 `POST /api/webhooks/feishu/base-record-sync`。
- 新增 `SyncArticleService`。
- 后端收到 `record_id` 后调用 `record-get` 读取完整数据。
- 先模拟微信侧返回，完成状态回写闭环。

### 阶段 4：微信 API 接入

- 新增 `WechatService`。
- 接入 `access_token` 获取和缓存。
- 接入永久素材上传。
- 接入草稿新增。
- 接入草稿更新。

### 阶段 5：产品化

- 接入 Supabase 保存配置。
- 支持多用户 profile 隔离。
- 增加前端状态面板。
- 增加 GitHub README、环境变量说明、部署说明。

## 9. 当前项目状态

已完成：

- Express + TypeScript 后端骨架。
- 静态前端页面。
- `lark-cli` 子进程执行器。
- 飞书初始化配置接口。
- 飞书用户授权接口。
- Base URL 解析接口。
- 字段读取接口。
- 记录列表读取接口。
- 单条记录 `record-get` 接口。
- 记录 upsert 写回接口。
- 模板表自动创建接口。
- webhook 接口。
- GitHub Content Hub → 微信草稿的 Publisher API（`POST /api/publisher/drafts`），含 Bearer 鉴权、`article_id + source_commit` 幂等持久化（独立 `PublisherStateStore` 边界）、GitHub 内容拉取（`GithubContentService`）、内容校验与稳定 Error Contract。
- GitHub/微信依赖边界的 vitest 测试（`src/routes/publisher.routes.test.ts`）。
- GitHub README、环境变量说明、部署说明初版。

未完成：

- workflow 自动创建。
- 微信 API 接入。
- 配置持久化。

## 11. Publisher API 增量说明

新增模块（不影响飞书链路）：

- `src/services/githubContent.service.ts`：GitHub Content Hub Adapter，按 `articles/{year}/{article_id}/` 读取 `meta.json / content.html / assets.json / cover`，使用服务器端 `GITHUB_CONTENT_TOKEN`（Fine-grained PAT，Contents Read-only），拉取时以 `source_commit` 精确锁定版本。
- `src/services/publisherStorage.service.ts`：幂等状态存储，独立 `PublisherStateStore` 接口 + 本地 JSON 文件实现（原子写），后续可替换为 SQLite / 数据库。
- `src/services/publisher.service.ts`：Publisher 编排（校验 → 幂等 → 拉取 → 上传素材 → 建草稿 → 持久化），复用现有 `WechatService`。
- `src/middleware/publisherAuth.ts` + `src/routes/publisher.routes.ts`：`POST /api/publisher/drafts`，Bearer `PUBLISHER_WEBHOOK_TOKEN` 鉴权。

关键约定：

- 微信凭证走服务器端 `WECHAT_APP_ID / WECHAT_APP_SECRET`，不依赖 `baseToken / tableId`。
- 不允许自动正式发布/群发；上传草稿 ≠ 发布，正式发布由 Lyra 人工完成。
- 日志与返回体绝不包含任何 Secret；失败错误带 `code / message / retryable`。
- 幂等：`article_id + source_commit`；同一键的并发请求在单进程内合并（in-flight 去重），只允许一个微信草稿创建流程执行，后续请求等待并复用首个结果（多副本部署需迁移共享存储 + 分布式锁）。
- Fail-closed：第一次调用微信前先持久化 `status = processing`（reserve 写入失败 → `STATE_SAVE_FAILED` 500 retryable=true，尚未调用微信、不锁键、可安全重试）；微信阶段失败或草稿已创建但成功状态未持久化 → 状态停留 processing，后续请求返回 `DELIVERY_OUTCOME_UNKNOWN`（409，retryable=false，不再调用微信），需人工确认，绝不自动重试。
- 状态存储初始化：首次访问创建唯一加载过程，并发调用共享等待同一初始化；状态文件损坏时持续 fail-closed（拒绝所有上传），不退化为空状态运行，避免丢失幂等账本；不允许 partial recovery——任一记录语义无效（article_id/source_commit 非空、status 三态、uploaded_at 非空、uploaded_to_wechat 必含 media_id）即整体加载失败。
- 白名单：仅允许读取 `PUBLISHER_ALLOWED_REPOSITORIES`（MVP 默认 `LyraWang6688/yaai-content-hub`），不信任 `request.repository`。
- 内容校验：`meta.schema_version == 1`、`meta.status == ready_to_upload`、`assets.schema_version == 1`、封面必需（`cover.required` 不可为 `false`）。

## 10. 给其他 AI 的注意事项

- 不要把这个项目理解为普通公众号编辑器，它的核心是 Base 驱动的同步桥。
- 飞书侧不要直接写 OpenAPI SDK，当前约定是通过 `lark-cli` 调用。
- `record-upsert` 的 JSON 是顶层字段映射，不要包一层 `fields`。
- `record-list` / `record-get` 默认输出 markdown，程序解析必须传 `--format json`。
- workflow 的复杂点在 `steps`，创建前必须参考 `lark-base-workflow-guide.md` 和 `lark-base-workflow-schema.md`。
- 删除表、删字段、删记录、字段更新都是高风险操作，不要默认开放给前端。
- 先跑通飞书侧闭环，再接微信侧 HTTP API。
