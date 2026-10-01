# PROJECT_BRIEF — WeChat Article Pilot

## Purpose

Canonical Repository：`LyraWang6688/wechat-article-pilot`。
产品把文章内容与应用放在 Single Repo Content Workspace，让用户授权不可变内容版本送入微信草稿箱。正式发布由 Lyra 人工完成。
唯一 Current Agent Entry 为 [AGENTS.md](AGENTS.md)；工程接手见 [docs/AI_HANDOFF.md](docs/AI_HANDOFF.md)。

## Current User Flow

1. 在 `content/articles/{year}/{article_id}/` 维护 meta.json、source.md、content.html、assets.json 与 cover，并同步 `content/index.json`。
2. 校验内容；Human 从 draft / not-ready 转为 ready_to_upload，授权 transition commit 的具体版本。
3. 内容进入 GitHub main，workflow 检测授权转换，绑定 canonical 40 位小写 source_commit。
4. Publisher 从 GitHub 按 source_commit 读取包，持久化 processing，再上传微信永久封面素材、创建草稿并记录结果。
5. 人在公众号后台检查草稿，再决定正式发布。later edit 不自动授权新版本。

`draft → ready(B) → ready(C)` 授权 B；`draft → ready(B) → draft(C) → ready(D)` 授权 D。workflow 还要求最终 HEAD 为 ready，并在扫描范围内选择最后一次进入 ready 的提交。

## Current System Boundary

```text
content/articles/** → Content Validator → GitHub main
→ publish-ready-articles.yml → transition into ready_to_upload
→ exact authorized commit → immutable source_commit
→ POST /api/publisher/drafts → GitHub exact-version fetch
→ PublisherStateStore → WechatService → WeChat Draft
```

API 用 Bearer token 验证调用方，workflow 负责挑选授权提交；Publisher 不自行重建历史授权链。ref 是必填请求字段，但实际取文件用 source_commit。
范围包含内容校验、上传授权与草稿交付；正文插图处理升级、正式发布 / 群发、多公众号和多副本交付不属于当前实现承诺。

## Current Runtime

Node.js / Express / TypeScript。`src/app.ts` 只挂载 `GET /api/health`、`POST /api/publisher/drafts`；旧 Feishu / system / integration / template 路由与 public 静态服务不暴露，其余请求 404。
WechatService 已实现 access token、永久素材上传与 draft/add，不能再称微信 API 尚未接入。
`ecosystem.config.cjs` 保留 PM2 dev name `wechat-article-pilot-dev`、cwd `/opt/wechat-article-pilot-dev`、PORT 3010；这里只记录配置，不证明线上状态，不迁移部署。

## Current Data / State Ownership

| Domain | State / Data | Owner |
| --- | --- | --- |
| Content / Human Authorization | draft / ready_to_upload、Article Package、index | 内容流程与 Human |
| Publisher Delivery | processing / uploaded_to_wechat / failed | PublisherStateStore |

Publisher 不修改 content 内的 meta.json、不回写 Content status；GithubContentService read-only。
`.data/publisher-state.json` 是 DELIVERY_STATE，不能当 cache 或生成垃圾清除。

## Current Safety Contracts

- `article_id + source_commit` 幂等；source_commit 严格 `^[0-9a-f]{40}$`。
- processing 必须在第一次微信副作用前写入；reserve 失败可安全重试，成功交付可 replay。
- 微信阶段结果未知保留 processing，`DELIVERY_OUTCOME_UNKNOWN` 不自动重试，需人工确认。
- 损坏 ledger、重复键、非法语义记录整体 fail-closed，无 partial recovery。
- 写盘成功后再更新 memory；当前临时文件 + rename 原子替换未调用 fsync。
- 白名单限制 repository；凭证留在服务端；单进程去重不等于多副本锁。

## Known Gaps

**KNOWN GAP / P1，当前未修复：**

1. Validator 校验 checkout HEAD，而 Publisher 可读取较早的 authorized commit，不能称已验证该授权版本的完整 Content Contract。
2. Docs / Validator 的 content_file / assets_file 引用与 Publisher 固定 content.html / assets.json 存在 filename Contract drift。

本 Phase A 只做 Context / Docs / Identity 对齐，不修改 workflow、Validator、Publisher、WechatService 或 ledger 行为；不做 E2E 或 deployment。

## Legacy Status

Feishu 已不是 Current Publishing Control Plane；runtime exposure retired。
物理实现仍在 public、lark services、旧 routes/templates 等，分类 LEGACY_IMPLEMENTATION。删除延后至 E2E 并明确批准。
旧 Feishu 文档以 HISTORICAL ONLY 标识保留，不是当前任务或部署指令。

## Experimental Capabilities

[MCP PR #3](https://github.com/LyraWang6688/wechat-article-pilot/pull/3)：Experimental / Deferred Product Channel，2026-10-02 为 OPEN、未合并、未删除，不属于当前 main 发布链；不得擅自合并或删除。

## Validation

按 [README](README.md) 执行 npm ci、typecheck、npm test、Content Validator、diff-check；自动化通过不证明微信真实 E2E 或 production 行为。
