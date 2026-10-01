# AI_HANDOFF

本文件帮助任何 AI（或人类）快速理解 Content Workspace，无需递归读取所有文章。

## 读取顺序

1. `content/index.json` —— 低 token 索引，只看 `article_id` / `title` / `status` / `path` / `updated_at`
2. 目标文章 `content/articles/{year}/{article_id}/meta.json` —— 元数据与状态
3. 必要时才读取该文章的 `source.md`（源稿正文）
4. 需要设计 / 排版 / 品牌规范时，再读取 `content/brand/one-page-wechat.md`
5. 必要时读取该文章的 `assets.json`（资产清单）

目标是减少 AI 不必要地递归读取整个内容仓库。

## 规则（必须遵守）

- **不要递归读取整个 `content/articles/`**。先看 `index.json`，再按需定位。
- **不要自行修改 `content.html`**。它是最终排版产物，由内容生产流程生成。
- **不要重新排版**。
- **不要将 `ready_to_upload` 理解为正式发布授权**。`ready_to_upload` **不是**正式发布授权。
  - `ready_to_upload` 只表示：用户已允许自动化系统把当前版本送入微信公众号草稿箱。
  - 草稿 ≠ 正式发布。正式发布必须由 Lyra 人工完成。

## 状态说明

| status | 含义 |
| --- | --- |
| `draft` | 内容仍在编辑；允许 required asset 尚未齐全 |
| `ready_to_upload` | 用户已允许自动化系统把当前版本送入微信公众号草稿箱；进入前要求所有 required asset 实际存在并验证通过 |
