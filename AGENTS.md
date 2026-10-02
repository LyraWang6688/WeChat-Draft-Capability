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

## Brand Ownership

正式 Brand Owner：`LyraWang6688/wechat-article-pilot`。
`content/brand/one-page-wechat.md` 是公众号品牌定位、核心标签、栏目体系、品牌颜色、内容规范、写作风格及 GEO / AI-Friendly Writing 原则的唯一正式 SSOT。品牌规则直接在上述品牌文件维护，无外部 upstream / 同步副本关系；不另建 Brand SSOT。

## Creative Layer vs Publishing Runtime

AI Content Creation = Flexible / Human-driven / Non-linear，可按需要组合 Title、Polish、Fact Check、GEO、Layout、Cover、Publish Check。
`AI / Human flexible creation → Human Authorization Gate → deterministic Publishing Runtime`。
Publishing Runtime = Deterministic / Contract-driven / Fail-closed；不把创作能力塞进 GitHub Action → Publisher 主链。本阶段不实现 Skill Orchestration。

## Safety-Critical Files

- .github/workflows/ci.yml：只读 CI Safety Gate（无 secret、无外部副作用）。
- .github/workflows/publish-ready-articles.yml：授权转换编排与不可变提交。
- scripts/detect-ready-transitions.mjs + scripts/lib/detect-transitions.mjs：授权转换检测唯一实现。
- scripts/validate-content.mjs + scripts/lib/content-validator.mjs + scripts/lib/reader.mjs：Content Contract 唯一规则（workspace / exact-ref 两模式）。
- src/services/publisher.service.ts：幂等与微信副作用编排。
- src/services/publisherStorage.service.ts：ledger integrity、写入顺序。
- .data/publisher-state.json：DELIVERY_STATE（或 PUBLISHER_STATE_FILE 配置路径）。
- content/articles/**：完整 Article Package，路径必须含 content/。
- content/brand/one-page-wechat.md：唯一正式 Brand SSOT。

## Never Treat As Garbage

Publisher Ledger、content.html、assets.json、Human Authorization workflow、Brand SSOT、未经分类的历史文档。

## Legacy Feishu

Feishu 非 Current Publishing Control Plane；Runtime = retired，physical implementation（public / lark services / legacy routes/templates）已在经明确批准、dependency-evidence 驱动的 repository hygiene cleanup 中退役。
历史资料归档于 docs/archive/legacy-feishu/（HISTORICAL ONLY），仅保留历史背景，不作为当前架构、任务或部署指令。

## Resolved Pre-E2E Correctness Items

Pre-E2E Safety Gate 已修复（结构与自动化层面）：

A. **已修复**：被发送给 Publisher 的 exact authorized commit 先通过同一套 Content Validator（`validate-content.mjs --ref`），validated SHA == published SHA，不再只校验 HEAD。
B. **Article Contract v1 已冻结**：固定 `meta.json` / `source.md` / `content.html` / `assets.json`，退休 `content_file` / `assets_file` 动态文件名，Docs == Validator == Publisher。
C. **已修复**：候选发现改为 push range 内任意 commit（含 merge commit，`diff-tree -m`）触过的目录，ready → draft → ready 且 endpoint diff 为空时仍检出。
D. **已建立**：只读 CI（`.github/workflows/ci.yml`）；`.env.example` 已修正 token 归属（PUBLISHER_ENDPOINT workflow-only；PUBLISHER_WEBHOOK_TOKEN 服务端 + workflow 共享）。

Six-Finding Correction（Codex review follow-up）：

E. **P1 已修复**：authorization target identity 只取 transitioned directory basename，`meta.json.article_id` 不决定「发布谁」；Validator 交叉校验目录名 == meta.article_id，不一致 FAIL CLOSED。回归 K。
F. **P1 已修复**：merge commit 也参与候选发现（`git diff-tree -m`），conflict-resolution merge 中才变成 ready 的目录不再被漏掉。回归 J。
G. **P1 已修复**：移除 push-level `paths:` filter —— endpoint diff 为空的 ready→draft→ready 再授权也能启动 workflow；普通 push 由内部 detector 判定 0 个 authorization 后正常结束，不产生 Publisher 调用。
H. **P2 已修复**：exact-ref reader 校验 Git tree entry 的 mode/type，只接受 regular blob（100644/100755），拒绝 tree / symlink / submodule。回归 M。
I. **P2 已修复**：CI 在 empty-tree fallback 下改用两点 diff（`EMPTY_TREE HEAD`）；三点形式会因 empty tree 不是 commit 而以 128 退出。
J. **P2 已修复**：candidate discovery 不再按 article_id 折叠目录，重复 article_id 目录可被检出；唯一映射只在唯一性校验之后建立。回归 L。
K. **已修复**：`vitest.config.ts` 显式排除 `dist/**`，避免编译副本与源码测试重复执行导致用例数翻倍。

这些不代表真实微信 E2E 已通过或 production ready。

## Known P1 Gaps

（无未决 P1。）原有两条已知缺口已随本 Safety Gate 关闭：

- ~~Validator validates HEAD，Publisher may publish authorized commit~~ → 见 Resolved 项 A。
- ~~Docs/Validator filename references vs Publisher fixed content.html/assets.json contract drift~~ → 见 Resolved 项 B。


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
- 不删 ledger；legacy physical cleanup 仅在明确批准并完成 dependency evidence 后执行，且不得改变 Current Publishing Logic；E2E 属于独立发布验证流程，不是 Repository Hygiene Gate；不改 PM2 name/path。
- Publishing / Validator / Publisher / WeChat 等 Safety-Critical Logic 仅在有明确任务、明确 scope 与对应 regression evidence 时修改，不得顺手重构；branch/worktree cleanup 独立处理，不擅自 merge/delete MCP PR #3。
