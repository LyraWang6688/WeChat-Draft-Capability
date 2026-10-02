> **HISTORICAL ONLY — Legacy Feishu**
> 本文保留旧 Feishu 架构时期的原始记录，不代表当前架构、待办或部署指令。
> Feishu Runtime Exposure 已关闭；对应 physical implementation 已在 approved repository hygiene cleanup 中退役。本文仅保留历史背景，不作为当前架构、任务或部署指令。
> 当前唯一 Agent 入口为 [AGENTS.md](../../../AGENTS.md)，工程事实见 [Current Engineering Handoff](../../AI_HANDOFF.md)。

# 飞书 CLI 初始化与授权上下文

本文面向接手项目的 AI / 开发者，说明通过 `lark-cli` 完成飞书应用初始化和用户授权之后，系统实际能获得什么信息，以及这些信息在后续 Base、Workflow、消息通知流程中如何使用。

## 核心结论

本项目飞书侧优先使用 `lark-cli` 的用户身份能力，而不是自行持有 `app_secret` 后直接调用 OpenAPI。

初始化与授权完成后，系统可稳定依赖的信息是：

- 应用上下文：`appId`、`brand`、`defaultAs`。
- 当前授权用户：`openId`、`userName`。
- 授权状态：`scope`、`tokenStatus`、`expiresAt`、`refreshExpiresAt`、`grantedAt`、`available`、`verified`。

系统不应依赖的信息：

- 明文 `appSecret`。
- 明文 `accessToken` / `refreshToken`。
- 短期 `device_code` / `verification_url`。

## 源码依据

参考 `larksuite/cli` 官方源码：

- `cmd/config/init.go`
- `internal/auth/app_registration.go`
- `cmd/auth/login.go`
- `internal/auth/device_flow.go`
- `internal/auth/token_store.go`
- `cmd/auth/status.go`
- `internal/identitydiag/diagnostics.go`
- `cmd/auth/auth.go`

关键源码事实：

- `config init --new` 通过 app registration device flow 创建/绑定应用。
- 应用注册成功后，CLI 内部会拿到 `client_id` 和 `client_secret`。
- `config init` 输出会把 `appSecret` 打码为 `****`。
- `appSecret` 会通过 CLI 的 secret/keychain 存储机制保存，业务系统不应读取或外传明文。
- `auth login --no-wait --json` 只返回临时授权信息，例如 `verification_url`、`device_code`、`expires_in`。
- `auth login --device-code <device_code>` 完成后，CLI 会拿到用户 token，并调用 user info 接口获取 `open_id` 和 `name`。
- CLI 会将用户 token 存入本机安全存储，结构中包含 `userOpenId`、`appId`、`accessToken`、`refreshToken`、`scope`、`expiresAt`、`refreshExpiresAt`、`grantedAt`。
- `auth status --json --verify` 会组合本地配置和 token 诊断结果，返回可供业务判断的授权上下文。

## `config init --new` 后有什么

命令：

```bash
lark-cli config init --new
```

创建/绑定应用后，系统可通过后续 `auth status` 或 CLI 配置上下文确认：

```json
{
  "appId": "cli_xxx",
  "brand": "feishu",
  "defaultAs": "auto"
}
```

本项目可确认并依赖的应用上下文只有：

```text
appId
brand
defaultAs
```

CLI 内部会保存：

```text
appId
appSecret
brand
lang
profileName 可选
```

重要边界：

- `config init --new` 后，业务系统可以确认当前 CLI 绑定了哪个应用和品牌环境，但不能把明文 `appSecret` 当成可读取的业务数据。
- `appSecret` 由 CLI 安全保存，不应作为业务字段展示给前端。
- 项目后端不应把 `appSecret` 写入日志、响应体、Git 或普通配置文件。
- 如果用户手动提供已有应用的 `appSecret`，后端应通过 `--app-secret-stdin` 传给 CLI，避免出现在进程参数中。

## `auth login --no-wait --json` 后有什么

命令：

```bash
lark-cli auth login \
  --scope "base:app:create base:table:read base:table:create base:table:update base:table:delete base:field:read base:field:create base:field:update base:view:write_only base:record:read base:record:create base:record:update base:workflow:create base:workflow:update" \
  --no-wait \
  --json
```

源码确认：

- `cmd/auth/login.go` 中 `LoginOptions.Scope` 是单个 `string`，不是数组。
- 该文件中 `cmd.Flags().StringVar(&opts.Scope, "scope", "", "scopes to request (space- or comma-separated). ...")` 明确说明 `--scope` 接受空格或逗号分隔。
- 因此项目代码应把多个权限拼成一个 `--scope` 字符串传入，例如 `--scope "scope_a scope_b scope_c"`。
- 不应生成多个重复的 `--scope` 参数。

该阶段只发起授权，返回临时授权信息：

```json
{
  "verification_url": "https://...",
  "device_code": "...",
  "expires_in": 300,
  "hint": "..."
}
```

这些信息的用途：

- `verification_url`：给用户打开或生成二维码。
- `device_code`：用户完成授权后，后端用它继续完成登录。
- `expires_in`：前端提示授权链接有效期。

这些信息不应长期保存：

- `verification_url` 和 `device_code` 都是短期临时凭证。
- 每次需要重新授权时，应重新执行 `auth login --no-wait --json`。

## `auth login --device-code` 后有什么

命令：

```bash
lark-cli auth login --device-code <device_code> --json
```

授权完成后，CLI 内部会获得并保存：

```text
userOpenId
appId
accessToken
refreshToken
scope
expiresAt
refreshExpiresAt
grantedAt
```

同时，CLI 会通过 user info 接口拿到：

```text
open_id
name
```

这些信息会成为后续 `auth status --json --verify` 的用户身份诊断来源。

重要边界：

- 业务系统不需要明文读取 `accessToken` 或 `refreshToken`。
- 后端继续通过 `lark-cli base +...` 执行 Base 和 Workflow 操作即可。
- token 过期但 refresh token 有效时，CLI 会在后续用户 API 调用中尝试刷新。

## `auth status --json --verify` 可用信息

命令：

```bash
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 lark-cli auth status --json --verify
```

项目应从该命令中读取并展示：

```json
{
  "appId": "cli_xxx",
  "brand": "feishu",
  "defaultAs": "auto",
  "identity": "user",
  "verified": true,
  "identities": {
    "user": {
      "status": "ready",
      "available": true,
      "verified": true,
      "openId": "ou_xxx",
      "userName": "用户名称",
      "tokenStatus": "valid",
      "scope": "bitable:xxx ...",
      "expiresAt": "2026-xx-xxTxx:xx:xxZ",
      "refreshExpiresAt": "2026-xx-xxTxx:xx:xxZ",
      "grantedAt": "2026-xx-xxTxx:xx:xxZ"
    }
  }
}
```

本项目后续应依赖：

- `appId`：确认当前 CLI 绑定的应用。
- `brand`：确认飞书/Lark 环境。
- `identity`：确认当前有效身份是 `user`。
- `verified`：确认 token 已通过服务端验证。
- `identities.user.available`：判断是否允许进入 Base 初始化。
- `identities.user.openId`：用于“通知当前授权用户”。
- `identities.user.userName`：用于前端展示当前登录账号。
- `identities.user.scope`：用于判断 Base / Workflow 相关权限是否已授权。
- `identities.user.tokenStatus`：用于判断是否需要重新授权。

## 后续流程如何使用这些信息

### 创建模板 Base 和数据表

前置条件：

```text
identities.user.available = true
identity = user
```

后端继续调用：

```bash
lark-cli base +base-create --name "公众号文章同步工作台" --table-name "推送草稿表" --fields '<template_fields>'
```

后续需要从创建结果中提取：

```text
baseToken
tableId
baseUrl 可选
```

然后读取字段：

```bash
lark-cli base +field-list --base-token <baseToken> --table-id <tableId>
```

用于得到真实 `fieldId`，供 workflow JSON 或后续 record 操作使用。

### 创建 Workflow

前置条件：

```text
baseToken 已获得
tableId 已获得
status 字段存在
webhookUrl 已配置
```

工作流 1：

```text
ChangeRecordTrigger
  条件：新增或修改记录满足 status = ready_to_upload
HTTPClientAction
  请求后端 webhook，携带 base_token / table_id / record_id
```

工作流 2：

```text
ChangeRecordTrigger
  条件：新增或修改记录满足 status = uploaded_to_wechat / failed
LarkMessageAction
  向指定接收人发送飞书消息
```

### 通知指定人

P0 已选择方案 A：通知当前授权用户。

原因：

- 当前阶段是单用户模式。
- 一个用户对应一个飞书应用和一个模板 Base。
- Base 不共享给多人协作。
- 先把飞书侧创建 Base、创建 Workflow、Webhook、读取记录、写回状态、消息通知闭环跑通。

方案 A：通知当前授权用户。

来源：

```text
auth status -> identities.user.openId
```

适用：

- P0 单用户。
- 谁初始化系统，就通知谁。
- 当前项目已采用该方案。

Workflow 接收人可使用固定用户 OpenID：

```json
{
  "value_type": "user",
  "value": {
    "id": "ou_xxx",
    "name": "张三"
  }
}
```

注意：实际飞书工作流 UI 需要 `value.name` 才能稳定展示具体人员名称；只传 `id` 虽然可能创建成功，但 UI 中可能显示为空接收人。

方案 B：通知记录修改人。

来源：

```text
$.step_trigger.recordModifiedUser
```

适用：

- 希望“谁修改记录，通知谁”。

风险：

- 如果第二条 workflow 是后端写回 `status` 后触发，`recordModifiedUser` 可能是后端 CLI 授权用户，而不是最初把状态改成 `ready_to_upload` 的人。
- P0 不采用该方案。

方案 C：模板表增加人员字段。

建议字段：

```text
notify_user
trigger_user
```

适用：

- 多用户协作。
- 需要稳定、可控、可审计的通知接收人。

这是长期最稳方案，但会让模板表从当前 15 字段增加到 16 或 17 字段，需要产品确认。

## 权限和 scope 怎么判断

### 源码里的权限约定位置

`larksuite/cli` 的权限约定主要写在各个 shortcut 源文件里的 `common.Shortcut` 配置中：

```go
Scopes: []string{"..."}
UserScopes: []string{"..."}
BotScopes: []string{"..."}
AuthTypes: []string{"user", "bot"}
```

本项目相关源码位置：

- `shortcuts/base/base_create.go`
- `shortcuts/base/table_create.go`
- `shortcuts/base/field_list.go`
- `shortcuts/base/record_get.go`
- `shortcuts/base/record_upsert.go`
- `shortcuts/base/workflow_create.go`
- `shortcuts/base/workflow_enable.go`
- `internal/auth/paths.go`
- `internal/auth/verify.go`
- `cmd/auth/status.go`
- `internal/identitydiag/diagnostics.go`

### 本项目 P0 用户身份所需权限

当前主流程不再绑定已有 Base，而是创建模板 Base。因此 P0 必需权限按实际调用命令整理如下：

| 功能 | CLI 命令 | 源码文件 | 用户权限 |
|---|---|---|---|
| 创建模板 Base 和初始表 | `base +base-create` | `shortcuts/base/base_create.go` | `base:app:create`, `base:table:read`, `base:table:create`, `base:table:update`, `base:table:delete` |
| 创建表，占位兼容旧接口 | `base +table-create` | `shortcuts/base/table_create.go` | `base:table:create`, `base:field:read`, `base:field:create`, `base:field:update`, `base:view:write_only` |
| 读取字段 | `base +field-list` | `shortcuts/base/field_list.go` | `base:field:read` |
| 读取单条记录 | `base +record-get` | `shortcuts/base/record_get.go` | `base:record:read` |
| 写回状态 | `base +record-upsert` | `shortcuts/base/record_upsert.go` | `base:record:create`, `base:record:update` |
| 创建工作流 | `base +workflow-create` | `shortcuts/base/workflow_create.go` | `base:workflow:create` |
| 启用工作流 | `base +workflow-enable` | `shortcuts/base/workflow_enable.go` | `base:workflow:update` |

如果后续恢复“绑定已有 Base 链接”能力，还需要按 `+url-resolve` 对应源码补充 URL 解析相关权限；当前 P0 主流程不依赖它。

### user info 是否需要额外权限

`auth status --json --verify` 会走用户 token 服务端校验：

- `cmd/auth/status.go` 调用 `identitydiag.Diagnose(...)`。
- `internal/auth/verify.go` 调用 `/open-apis/authen/v1/user_info`。
- `internal/auth/paths.go` 定义 `PathUserInfoV1 = "/open-apis/authen/v1/user_info"`。

结论：

- CLI 在完成 `auth login` 后，会用用户 token 调用 user info 来确认 token 可用并得到用户信息。
- 从项目实现角度，我们不直接调用 user info OpenAPI，而是读取 `lark-cli auth status --json --verify` 返回的 `openId/userName`。
- 飞书官方文档显示 `/open-apis/authen/v1/user_info` 的 Required scopes 为 `None`。
- user info 返回中的邮箱、手机号、工号等敏感字段需要额外字段权限；本项目只依赖 `open_id/name`，不需要额外通讯录权限。
- 当前 P0 前端第一板块第二个 Todo “用户授权”默认提交上述 Base/Workflow 必需 scope，而不是笼统使用 `--domain all`。

### 运行时判断路径

1. 看 `auth status --json --verify` 的 `identities.user.scope`。
2. 调用目标 CLI 命令。
3. 如果权限不足，读取错误中的：

```text
permission_violations
console_url
hint
```

恢复方式：

```bash
lark-cli auth login --scope "<missing_scope>" --no-wait --json
```

或按业务域：

```bash
lark-cli auth login --domain docs --no-wait --json
```

本项目 P0 当前使用明确 scope 清单：

```bash
lark-cli auth login --scope "<P0 必需权限，可重复传入>" --no-wait --json
```

如果真实运行时发现仍有缺失权限，以 CLI 错误中的 `permission_violations` 为准增量补充。`--domain all` 只作为排查阶段的兜底方案，不作为当前前端默认授权策略。

## 对 AI 的实现提醒

- 不要把飞书账号跨设备登录误解为 `lark-cli` 授权跨设备同步。
- 谁运行后端，谁的机器上就必须安装并配置 `lark-cli`。
- 当前服务器执行机模式下，`lark-cli` 配置、app secret、用户 token 都在服务器环境里。
- 不要要求用户手动把 `appSecret` 明文复制给前端，除非用户选择绑定已有应用；即使绑定已有应用，也必须走 `stdin`，不要放命令行参数。
- 前端应把 `auth status` 中的 `openId/userName/scope/tokenStatus` 展示为“当前登录账号”和“授权状态”。
- 多维表格初始化前必须确认 `identities.user.available = true`。
- Workflow 通知接收人策略必须明确：当前授权用户、记录修改人、还是表内人员字段。
- 如果是单用户 P0，优先使用当前授权用户 `openId`。
- 如果是多用户，优先增加人员字段，不要只依赖 `recordModifiedUser`。
