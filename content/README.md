# Content Workspace

「要AI不释手」微信公众号的内容资产工作区（Content Workspace），位于 `content/`。

## 这是什么

Content Workspace 是微信公众号内容的 **Single Source of Truth**：
保存文章源稿、排版 HTML、文章元数据、图片资产清单与品牌规范，并标记文章是否已准备好上传。

## Content Workspace 的职责

- 文章正文、排版 HTML、元数据、封面、正文插图
- Brand / One Page
- Content Validation
- 上传授权 Desired State

## 文章目录在哪里

```
content/articles/{year}/{article_id}/
```

示例：`content/articles/2026/2026-09-29-ai-tools/`

## One Page 在哪里

[content/brand/one-page-wechat.md](brand/one-page-wechat.md) 是微信公众号品牌定位、核心标签、栏目体系、品牌颜色、内容规范、写作风格及 GEO / AI-Friendly Writing 原则的唯一正式 Single Source of Truth。正式 Brand Owner 是 `LyraWang6688/wechat-article-pilot`，规则直接在该文件维护，不建立外部 upstream 或同步副本关系。

## Article Package 构成

一篇文章是一个完整 Article Package：

| 文件 | 说明 |
| --- | --- |
| `meta.json` | 元数据与状态（article_id / title / status / 文件引用） |
| `source.md` | 源稿正文（Markdown） |
| `content.html` | 最终排版 HTML（不在此手动改写） |
| `assets.json` | 资产清单（封面 / 正文插图） |
| `assets/` | 图片资产目录（cover / body images） |

## status 含义

| status | 含义 |
| --- | --- |
| `draft` | 内容仍在编辑；允许 required asset 尚未齐全 |
| `ready_to_upload` | 用户已允许自动化系统把当前版本送入微信公众号草稿箱；进入前要求所有 required asset 实际存在并验证通过 |

**上传草稿 ≠ 正式发布。** `ready_to_upload` 不是正式发布授权，正式发布必须由 Lyra 人工完成。

**日常修改 draft 不代表上传授权。** 无论修改正文、封面、插图或 HTML，只要文章仍为 `draft`，就不应触发微信上传。只有用户明确授权后，系统才应把 `draft → ready_to_upload` 这一状态变化作为真正的上传授权。

## State Ownership

- **Content Workspace**：只拥有内容与"是否允许上传"的 Desired State（`draft` / `ready_to_upload`）。
- **Publisher**：拥有实际上传交付/执行状态（上传成功 / 失败等）。
- Content 不新增 `uploaded` / `failed` / `processing` 等 Publisher 执行态。

## 结构校验

```bash
node scripts/validate-content.mjs
```

校验 JSON 可解析、article_id 唯一、status 枚举、path 匹配、meta 文件引用、index/meta 一致性，以及资产生命周期校验（draft 允许 required asset 缺失；ready_to_upload 要求全部就位）。仅依赖 Node.js 内置模块。
