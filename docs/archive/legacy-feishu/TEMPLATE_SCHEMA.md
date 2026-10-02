> **HISTORICAL ONLY — Legacy Feishu**
> 本文保留旧 Feishu 架构时期的原始记录，不代表当前架构、待办或部署指令。
> Feishu Runtime Exposure 已关闭；对应 physical implementation 已在 approved repository hygiene cleanup 中退役。本文仅保留历史背景，不作为当前架构、任务或部署指令。
> 当前唯一 Agent 入口为 [AGENTS.md](../../../AGENTS.md)，工程事实见 [Current Engineering Handoff](../../AI_HANDOFF.md)。

# 推送草稿表模板结构

模板表已支持通过后端接口创建；字段结构会映射为 `lark-cli base +table-create --fields` 可执行 JSON。

## 表名

```text
推送草稿表
```

## 字段清单

| 字段名 | 类型 | 说明 |
|---|---|---|
| `article_id` | 自动编号 | 主键，格式 `yyyyMMdd + 3位序号` |
| `title` | 文本 | 文章标题 |
| `author` | 文本 | 作者 |
| `digest` | 文本 | 摘要 |
| `column` | 单选 | 公众号栏目，8 个固定选项 |
| `content_markdown` | 文本 | Markdown 正文 |
| `content_html` | 文本 | HTML 正文 |
| `cover_image_url` | URL | 封面图 URL |
| `status` | 单选 | 同步状态，3 个固定选项 |
| `wechat_draft_media_id` | 文本 | 微信草稿 media_id |
| `wechat_upload_result` | 文本 | 微信接口返回结果 |
| `missing_fields` | 文本 | 必填字段缺失检查结果 |
| `warning_fields` | 文本 | 非阻断告警 |
| `created_at` | 创建时间 | 记录创建时间 |
| `updated_at` | 修改时间 | 记录更新时间 |

## column 选项

- `造物笔记`
- `边走边想`
- `书籍推荐`
- `热钱之外`
- `AI 简报`
- `从卡点到解法`
- `工具炼金术`
- `概念补给站`

## status 选项

- `ready_to_upload`
- `uploaded_to_wechat`
- `failed`

## 触发规则

```text
status = ready_to_upload
```

当 `status` 被设置为 `ready_to_upload` 时，飞书 Workflow 调用后端 webhook。

## 写回规则

- 成功：后端写回 `status = uploaded_to_wechat`。
- 失败：后端写回 `status = failed`，同时写入 `wechat_upload_result`、`missing_fields` 或 `warning_fields`。

## 当前授权用户通知规则

目标规则：

```text
飞书消息通知当前授权用户
```

当前策略：

- 前期飞书初始化/授权后，可通过 `lark-cli auth status --json --verify` 获取当前授权用户的 `openId` 和 `userName`。
- Workflow 创建接口会固定使用当前授权用户 `openId` 作为通知接收人。
- P0 单用户假设是一个用户一个应用一个 Base，不共享；先保证同步闭环跑通。
- 多人协作阶段再考虑新增一个人员字段作为通知接收人字段；当前创建表严格遵守 15 字段模板，不额外加字段。
