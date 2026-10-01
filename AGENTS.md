# AGENTS.md

## Repository Identity

唯一 Current Agent Entry。Canonical Repository：`LyraWang6688/wechat-article-pilot`。
产品/API 见 README.md；工程细节见 docs/AI_HANDOFF.md；内容操作见 content/AI_HANDOFF.md（先 index 再目标文章，不递归读取所有文章、不重新排版）。

## Current Architecture / Canonical Publishing Chain

Single Repo Content Workspace → Human Authorization → GitHub Action → Immutable source_commit → Publisher → WeChat Draft。

`content/articles/** → scripts/validate-content.mjs → GitHub main → publish-ready-articles.yml → transition into ready_to_upload → exact authorized commit → source_commit → POST /api/publisher/drafts → GitHub exact-version fetch → PublisherStateStore → WechatService → WeChat Draft`。

Runtime 只挂载 GET /api/health、POST /api/publisher/drafts；无 Feishu 路由或 public 静态服务（src/app.ts）。

## Human Authorization Contract

not-ready → ready_to_upload 授权 transition commit 对应的具体内容版本。source_commit 严格 `^[0-9a-f]{40}$`，不是 latest HEAD。later edit 不自动授权。
draft → ready(B) → ready(C) 授权 B；draft → ready(B) → draft(C) → ready(D) 授权 D。
workflow 要求最终 HEAD 为 ready，选扫描范围内最后一次进入 ready 的提交。授权历史选择属于 workflow；Publisher 按受信请求 SHA 读文件，不独立重建历史授权链。送入草稿不等于正式发布授权。

## State Ownership / Safety

Content / Human Authorization：draft、ready_to_upload。Publisher Delivery：processing、uploaded_to_wechat、failed。
Publisher 不改文章 meta.json、不回写 Content status；GithubContentService read-only。
幂等键 article_id + source_commit；ledger `.data/publisher-state.json` 为 **DELIVERY_STATE**。
processing 必须在第一次微信副作用前持久化；uploaded_to_wechat 可 replay；unknown outcome 保留 processing、不可自动重试。
损坏 ledger、重复键、非法语义记录整体 fail-closed，不允许 partial recovery。写盘成功后才更新 memory state；当前临时文件 + rename 没有 fsync。单进程保护不等于多副本锁。

## Safety-Critical Files

- .github/workflows/publish-ready-articles.yml：授权转换与不可变提交。
- scripts/validate-content.mjs：Content Contract gate。
- src/services/publisher.service.ts：幂等与微信副作用编排。
- src/services/publisherStorage.service.ts：ledger integrity、写入顺序。
- .data/publisher-state.json：DELIVERY_STATE（或 PUBLISHER_STATE_FILE 配置路径）。
- content/articles/**：完整 Article Package，路径必须含 content/。

## Never Treat As Garbage

Publisher Ledger、content.html、assets.json、Human Authorization workflow、未经分类的历史文档。

## Legacy Feishu

Feishu 非 Current Publishing Control Plane；Runtime = retired，Physical code = pending cleanup after E2E 并获明确批准。
public / lark services / legacy routes/templates 属于 LEGACY_IMPLEMENTATION；仍装配对象不表示旧路由暴露。

## Known P1 Gaps

A. **KNOWN GAP**：Validator validates HEAD，Publisher may publish authorized commit。
B. **KNOWN GAP**：Docs/Validator filename references vs Publisher fixed content.html/assets.json contract drift。
Phase A 只记录，不修代码。

## MCP PR #3

Experimental / Deferred Product Channel，2026-10-02 OPEN、未合并、未删除。非 current main production path；不擅自 merge/delete。

## Validation Commands

```bash
npm ci
npm run typecheck
npm test
node scripts/validate-content.mjs
git diff --check
```

自动化通过不证明真实微信 E2E 或 production 状态。

## Change Rules

- Current Truth from code；以最新 origin/main 核对，dirty 工作区先报告，不覆盖修改。
- 历史文档标 HISTORICAL ONLY，不能作为当前任务或部署指令。
- repo hygiene 不 production publishing、不发真实草稿、不触发 workflow；不部署或改 secrets。
- 不删 ledger，不在 E2E 与明确批准之前物理删除 legacy；不改 PM2 name/path。
- 本 Phase A 禁改 publishing / Validator / Publisher / WeChat 业务逻辑；不修 P1、不清理分支/worktree、不 merge/delete PR #3。
