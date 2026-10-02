> **HISTORICAL ONLY — Legacy Feishu**
> 本文保留旧 Feishu 架构时期的原始记录，不代表当前架构、待办或部署指令。
> Feishu Runtime Exposure 已关闭；对应 physical implementation 已在 approved repository hygiene cleanup 中退役。本文仅保留历史背景，不作为当前架构、任务或部署指令。
> 当前唯一 Agent 入口为 [AGENTS.md](../../../AGENTS.md)，工程事实见 [Current Engineering Handoff](../../AI_HANDOFF.md)。

# Workflow 可行性依据

本文档说明为什么本项目需要的两个飞书多维表格 Workflow 可以通过 `lark-cli base +workflow-*` 实现。

## 依据来源

- `lark-base-workflow-schema.md`：定义 Workflow `steps` 的单一事实来源，包括 Trigger、Action、Branch、System 的类型和字段。
- `lark-base-workflow-guide.md`：给出 `ButtonTrigger -> HTTPClientAction`、`LarkMessageAction` 等完整组合示例。
- `larksuite/cli` GitHub 源码：
  - `shortcuts/base/workflow_create.go` 声明 `+workflow-create`，通过 `POST /open-apis/base/v3/bases/:base_token/workflows` 创建工作流。
  - `shortcuts/base/workflow_enable.go` 声明 `+workflow-enable`，通过 `PATCH /open-apis/base/v3/bases/:base_token/workflows/:workflow_id/enable` 启用工作流。
  - `shortcuts/base/workflow_disable.go` 声明 `+workflow-disable`，通过 `PATCH /open-apis/base/v3/bases/:base_token/workflows/:workflow_id/disable` 禁用工作流。

## 目标工作流 1：状态触发后端同步

业务需求：

```text
当 推送草稿表.status = ready_to_upload 时，向后端 webhook 发送 HTTP 请求，携带 record_id。
```

可用节点：

- `ChangeRecordTrigger`：新增或修改记录满足条件时触发，适合本项目“新增或者修改的记录满足条件时”的需求。
- `HTTPClientAction`：向后端发送 HTTP 请求，支持 `method`、`url`、`headers`、`raw_body`。

推荐组合：

```text
ChangeRecordTrigger -> HTTPClientAction
```

推荐触发条件：

```json
{
  "table_name": "推送草稿表",
  "trigger_control_list": [],
  "condition_list": [
    {
      "conjunction": "and",
      "conditions": [
        {
          "field_name": "status",
          "operator": "is",
          "value": [{ "value_type": "option", "value": { "name": "ready_to_upload" } }]
        }
      ]
    }
  ]
}
```

推荐 HTTP body 拼接方式：

```json
[
  { "value_type": "text", "value": "{\"event\":\"wechat_draft_sync\",\"record_id\":\"" },
  { "value_type": "ref", "value": "$.step_trigger.recordId" },
  { "value_type": "text", "value": "\"}" }
]
```

后端收到 `record_id` 后，再结合配置中的 `base_token`、`table_id` 调用：

```bash
lark-cli base +record-get --base-token "<base_token>" --table-id "<table_id>" --record-id "<record_id>" --format json
```

## 目标工作流 2：状态写回后通知用户

业务需求：

```text
后端把 status 写回 uploaded_to_wechat 或 failed 后，飞书消息通知当前授权用户。
```

可用节点：

- `ChangeRecordTrigger`：新增或修改记录满足写回状态条件时触发。
- `LarkMessageAction`：发送飞书消息，支持 `receiver`、`title`、`content`、`btn_list`。

推荐组合：

```text
ChangeRecordTrigger -> LarkMessageAction
```

推荐监听条件：

```json
{
  "table_name": "推送草稿表",
  "trigger_control_list": [],
  "condition_list": [
    {
      "conjunction": "and",
      "conditions": [
        {
          "field_name": "status",
          "operator": "containsAny",
          "value": [
            { "value_type": "option", "value": { "name": "uploaded_to_wechat" } },
            { "value_type": "option", "value": { "name": "failed" } }
          ]
        }
      ]
    }
  ]
}
```

当前实现用同一条通知工作流覆盖 `uploaded_to_wechat` 和 `failed` 两种写回状态。

接收人规则：

```text
当前授权用户
```

当前实现固定使用 `auth status -> identities.user.openId` 作为 `LarkMessageAction.receiver`。P0 假设是单用户、单应用、单 Base，不共享，因此先保证闭环跑通。

当前阶段补充策略：

- 飞书初始化/授权后，可通过 `lark-cli auth status --json --verify` 获取当前授权用户的 `openId`、`userName`、`scope`、`tokenStatus`。
- 源码依据：`cmd/auth/status.go` 调用 `identitydiag.Diagnose(...)` 输出 user identity 信息；`internal/auth/verify.go` 会调用 `/authen/v1/user_info` 验证用户 token。
- 因此配置阶段可以知道“当前授权用户是谁”，并把该用户作为通知人。
- 多人场景后续建议增加人员字段，不在 P0 阶段处理。

## 仍需实测确认

- `ChangeRecordTrigger.condition_list.value` 对单选字段是否必须使用 `value_type=option`。
- `$.step_trigger.recordId` 在实际工作流中的输出路径是否稳定。
- `LarkMessageAction` 已收敛为官方 guide 的最小可识别结构：固定用户 `receiver`、`title`、纯文本 `content`、`btn_list: []`，避免动态按钮或未知引用导致飞书 UI 显示「未知操作」。
- 后端写回 `status` 是否会再次触发工作流 1；需要通过条件设计避免循环。
- 飞书工作流调用本地后端时必须使用公网可访问 URL，本地阶段需要 ngrok/frp/公网测试服务。

## 当前开发策略

- 模板 Base 和「推送草稿表」已支持通过接口自动创建。
- 工作流已支持通过接口生成、创建并启用。
- 当前优先在真实飞书环境中验证 `ChangeRecordTrigger`、`HTTPClientAction.raw_body` 和 `LarkMessageAction.receiver` 的实际返回与触发行为。
