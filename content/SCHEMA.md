# SCHEMA — Article Contract v1（Single-Repo Content Workspace）

本文档是 Content Workspace 的 **Single Contract Source**。任何变更必须先修改本文件并走 Change Request 流程，不得自行定义新格式。

## 1. 目录结构

Content Workspace 位于仓库的 `content/` 目录。每篇文章一个目录，按年份分组：

```
content/
  index.json
  SCHEMA.md
  AI_HANDOFF.md
  brand/
  articles/
    {year}/
      {article_id}/
        meta.json
        source.md
        content.html
        assets.json
        assets/
```

示例：`content/articles/2026/2026-09-29-ai-tools/`

Article Contract v1 **冻结文件名**：每个 Article Package 的 `meta.json`、`source.md`、`content.html`、`assets.json` 文件名固定，不支持通过 meta 字段动态配置或替换；`assets/` 目录存放封面等资产。Publisher 与 Validator 都按这些固定路径读取。

## 2. article_id

- **全局唯一**，不得与其他文章重复。
- **必须**符合格式 `YYYY-MM-DD-<slug>`（Publisher 兼容格式），例如 `2026-09-29-ai-tools`；其中 `YYYY-MM-DD` 必须是有效日历日期。
- `year` 必须与 `article_id` 中的年份一致，且目录路径必须与 `article_id` 匹配。

## 3. meta.json

最小结构（MVP 不允许随意增删字段）：

```json
{
  "schema_version": 1,
  "article_id": "2026-09-29-ai-tools",
  "title": "文章标题",
  "author": "Lyra Wang",
  "created_at": "2026-09-29",
  "updated_at": "2026-10-01",
  "status": "draft"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema_version` | number | 是 | 当前为 `1` |
| `article_id` | string | 是 | 全局唯一 |
| `title` | string | 是 | 文章标题 |
| `author` | string | 是 | 作者 |
| `created_at` | string | 是 | 创建日期 `YYYY-MM-DD` |
| `updated_at` | string | 是 | 最近更新日期 `YYYY-MM-DD` |
| `status` | string | 是 | 见下方 status 枚举 |

文章包内的 `source.md`、`content.html`、`assets.json` 为固定文件名，不再作为 meta 字段声明。

可选字段（MVP 允许）：`digest`、`column`。

## 4. status 枚举

MVP 只允许以下两个值：

| 值 | 含义 |
| --- | --- |
| `draft` | 内容仍在编辑 |
| `ready_to_upload` | 用户已允许自动化系统把当前版本送入微信公众号草稿箱 |

注意：
- Content Workspace 不拥有"微信上传成功/失败"的最终状态，那是 Publisher 的职责。
- `ready_to_upload` **不是**正式发布授权。

## 5. assets.json

MVP 结构：

```json
{
  "schema_version": 1,
  "cover": {
    "path": "assets/cover.jpg",
    "required": true
  },
  "body_images": []
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema_version` | number | 是 | 当前为 `1` |
| `cover.path` | string | 是 | 封面路径，相对文章目录 |
| `cover.required` | boolean | 是 | 当前必须为 `true` |
| `body_images` | array | 是 | MVP 允许为空数组 |

后续将升级 `assets.body_images`（正文插图读取 → 上传 → 替换 HTML 引用 → 创建草稿），由 Asset Processor 实现，不在本轮范围。

## 6. 引用规则与生命周期校验

### 6.1 固定文件名校验

- Article Package 必须包含固定命名的 `source.md`、`content.html`、`assets.json`（与 `meta.json` 同级），文件名不可通过 meta 字段替换。

### 6.2 assets 校验时机（生命周期校验）

资产校验跟随文章生命周期，而不是创建即校验：

- `status=draft`：允许 required asset 尚未齐全（例如 `cover.jpg` 未就位不影响 `draft` 状态）。
- 只有准备进入 `ready_to_upload` 时，才要求所有 `required=true` 的 asset 实际存在并通过验证。
- `cover.required=true` 时，封面文件是 `ready_to_upload` 的强制前置条件。
- 不增加新的 status 值；上述规则只约束状态转换时的校验时机。

## 7. 顶层索引 content/index.json（Index Contract v1）

用于低 token 检索。**顶层结构固定为：**

```json
{
  "schema_version": 1,
  "articles": []
}
```

`articles[]` 中单条记录**只允许以下 5 个字段**，不得复制整篇文章内容：

| 字段 | 说明 |
| --- | --- |
| `article_id` | 全局唯一 |
| `title` | 文章标题 |
| `status` | 与 meta.json 一致 |
| `path` | 文章目录路径，**仓库根相对路径**（以 `content/articles/` 开头），以 `/` 结尾 |
| `updated_at` | 与 meta.json 一致 |

`index.json` 中的 `article_id` / `title` / `status` / `updated_at` 必须与该文章 `meta.json` 保持一致。

## 8. schema_version

- 所有 JSON 文件（`meta.json` / `assets.json` / `index.json`）当前均为 `schema_version: 1`。
- 版本变更必须通过 Change Request 流程。
