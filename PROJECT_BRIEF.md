# PROJECT_BRIEF — WeChat Draft Capability

## Purpose

Canonical Repository：`LyraWang6688/WeChat-Draft-Capability`。
产品把文章内容与应用放在 Single Repo Content Workspace，让用户授权不可变内容版本送入微信草稿箱。正式发布由 Lyra 人工完成。
唯一 Current Agent Entry 为 [AGENTS.md](AGENTS.md)；工程接手见 [docs/AI_HANDOFF.md](docs/AI_HANDOFF.md)。

## Current User Flow

1. 在 `content/articles/{year}/{article_id}/` 维护 meta.json、source.md、content.html、assets.json 与 cover，并同步 `content/index.json`。
2. 校验内容；Human 从 draft / not-ready 转为 ready_to_upload，授权 transition commit 的具体版本。
3. 内容进入 GitHub main，workflow 用共享检测脚本扫描 push range 内的授权转换（候选目录取自 range 内任意 commit 触过的目录），对每个 exact authorized commit 运行同一套 Content Validator，通过后绑定 canonical 40 位小写 source_commit。
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

## Brand Ownership

正式 Brand Owner：`LyraWang6688/WeChat-Draft-Capability`。
[content/brand/one-page-wechat.md](content/brand/one-page-wechat.md) 是公众号品牌定位、核心标签、栏目体系、品牌颜色、内容规范、写作风格及 GEO / AI-Friendly Writing 原则的唯一正式 Single Source of Truth。规则直接在本仓库维护，不设外部 upstream 或同步副本，不另建 Brand SSOT。

AI / Human 创作层是 flexible、Human-driven、non-linear；标题、润色、事实核查、GEO、排版、封面与 Publish Check 可按需要组合。Human Authorization Gate 后进入 deterministic、Contract-driven、fail-closed 的 Publishing Runtime；创作能力不插入 GitHub Action → Publisher 主链。本阶段不实现 Skill Orchestration。

## Resolved Correctness Items (Pre-E2E Safety Gate)

以下 P1 / P2 已在 Safety Gate PR 中修复（结构与自动化层面）：

1. **已修复**：被发送给 Publisher 的 exact authorized commit 会先通过同一套 Content Validator，validated SHA == published SHA，不再只校验 checkout HEAD。
2. **已冻结 Article Contract v1**：正式文件名固定为 `meta.json` / `source.md` / `content.html` / `assets.json`，退休 `content_file` / `assets_file` 动态文件名，Docs == Validator == Publisher。
3. **已修复**：候选文章发现改为 push range 内任意 commit 触过的目录，ready → draft → ready 且 endpoint diff 为空时仍能检出 reauthorization。
4. **已修正**：`.env.example` 明确 `PUBLISHER_ENDPOINT` 为 workflow-only、`PUBLISHER_WEBHOOK_TOKEN` 为服务端与 workflow 共享凭证。
5. **已建立**：只读 CI（`.github/workflows/ci.yml`），与发布工作流隔离。

以上仅表示结构契约与自动化校验已统一，不代表已完成真实微信 E2E、不代表 production ready；首次真实 E2E 仍待执行。Safety Gate 未改 Publisher Ledger 业务语义、未合并 / 删除 MCP PR #3、未做 deployment；Legacy Feishu physical implementation 由独立的 repository hygiene cleanup（PR #11）退役，与本 Safety Gate 无关。

## Legacy Status

Feishu 已不是 Current Publishing Control Plane；runtime exposure retired。
`public/**`、lark services、旧 routes/templates 的 physical implementation 已在经明确批准、dependency-evidence 驱动的 repository hygiene cleanup 中退役，不是 CURRENT_ARCHITECTURE。
历史资料归档于 [docs/archive/legacy-feishu/](docs/archive/legacy-feishu/README.md)（HISTORICAL ONLY），不是当前任务或部署指令。

## Experimental Capabilities

[MCP PR #3](https://github.com/LyraWang6688/WeChat-Draft-Capability/pull/3)：Experimental / Deferred Product Channel，2026-10-02 为 OPEN、未合并、未删除，不属于当前 main 发布链；不得擅自合并或删除。

## Validation

按 [README](README.md) 执行 npm ci、typecheck、npm test、Content Validator、diff-check；自动化通过不证明微信真实 E2E 或 production 行为。
