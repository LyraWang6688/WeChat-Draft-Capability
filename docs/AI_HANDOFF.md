# Current Engineering Handoff

## 1. Repository Identity

Canonical Repository：`LyraWang6688/wechat-draft-capability`。
唯一 Current Agent Entry：[根 AGENTS.md](../AGENTS.md)。本文是工程说明；[content/AI_HANDOFF.md](../content/AI_HANDOFF.md) 仅负责内容操作。[README](../README.md) 是产品/API/环境变量说明。
旧 Feishu 文档均为 HISTORICAL ONLY，不要以“先跑通飞书”作为当前任务。

## 2. Current Architecture

Single Repo Content Workspace → Human Authorization → GitHub Action → Immutable source_commit → Publisher → WeChat Draft。
正式发布仍由 Lyra 人工完成，Feishu 不再是 Current Publishing Control Plane。

## 3. Current Critical Path

```text
content/articles/** → scripts/validate-content.mjs → GitHub main
→ .github/workflows/publish-ready-articles.yml
→ transition into ready_to_upload → exact authorized commit
→ canonical full 40-char lowercase source_commit
→ POST /api/publisher/drafts → GithubContentService exact-version fetch
→ PublisherDraftService → PublisherStateStore
→ WechatService → 微信公众号 Draft
```

`src/app.ts` 只挂载 /api/health 与 /api/publisher；当前接口为 GET /api/health 与 POST /api/publisher/drafts。不 serve public；Feishu/system/template/integration 路由未挂载，其余请求 404。
services/index.ts 仅装配 Publisher 依赖图（GithubContentService、WechatService、FilePublisherStateStore、PublisherDraftService），不再装配 legacy 对象。

## 4. Current Publishing Contract

- 文章包在 `content/articles/{year}/{article_id}/`，含 meta.json、source.md、content.html、assets.json、assets 下 cover；以 content/index.json 定位，避免递归扫文章。
- API Bearer token 为 PUBLISHER_WEBHOOK_TOKEN；请求 repository/article_id/ref/source_commit，不发送完整 HTML。白名单默认 canonical 仓库。
- source_commit 严格 `^[0-9a-f]{40}$`。GithubContentService read-only，固定拉取 meta.json、content.html、assets.json 与 cover.path，全都按 source_commit 获取；不以 ref/main 最新 HEAD 取文件。
- Publisher 校验 schema、id、ready status、title、HTML、cover 等，然后实际调用 WechatService 的永久素材上传及 draft/add；微信 API 已接入代码。
- 当前正文图片处理升级未实现。API 与自动化测试不等于真实微信 E2E。

## 5. Human Authorization Contract

Human 将 not-ready → ready_to_upload，授权该 transition commit 的具体内容版本。
Human Intent → status transition → authorized commit → immutable source_commit → Publisher fetch exact version。

- draft → ready(B) → ready(C)：B 获授权，later edit C 不重新授权。
- draft → ready(B) → draft(C) → ready(D)：D 获授权。

workflow 扫描 push 范围（manual dispatch 为 HEAD 对 parent），选择最后一次进入 ready 的提交，且最终 HEAD 必须仍 ready。无新转换就跳过。
手动 dispatch 仅允许 main；dry_run 默认 false，hygiene 不触发 workflow。
授权历史选择由 workflow 完成；Publisher 接受受信调用方的 SHA，不独立审计 Git 历史中的人类意图。草稿上传授权不等于正式发布授权。

## 6. Publisher Safety Contract

幂等键 article_id + source_commit；默认 `.data/publisher-state.json` 是 **DELIVERY_STATE**，绝不是 cache/build artifact/generated garbage。

- 第一次微信副作用前持久化 processing；reserve 失败尚无微信调用，返回可重试 STATE_SAVE_FAILED。
- uploaded_to_wechat 重放返回已有草稿结果；同键并发仅在单进程内合并，多副本需要共享存储与分布式锁。
- 微信阶段失败或成功状态未保存 → processing / unknown outcome；409 DELIVERY_OUTCOME_UNKNOWN，retryable=false，需人工确认，禁止自动重试。
- corrupted ledger、duplicate idempotency key、invalid semantic record 整体 fail-closed；不静默跳过、不 partial recovery、不自动去重。初始化失败持续拒绝 find/save。
- 写链串行化，先临时文件 + rename 写快照，成功后才更新 memory state。实现未调用 fsync，不扩大为断电持久性保证。
- 禁止删除 ledger 解除锁定；即使 `.data/` 已 gitignore，它仍是交付状态资产。

## 7. State Ownership

Content / Human Authorization Domain：draft、ready_to_upload 与文章内容。
Publisher Delivery Domain：processing、uploaded_to_wechat、failed 与 media_id / 错误 / 时间。
Publisher 不改文章 meta.json、不回写 Content status；GitHub adapter 当前 read-only。两套状态不能合并。

## 8. Brand Ownership / Creative Boundary

正式 Brand Owner：`LyraWang6688/wechat-draft-capability`。
[content/brand/one-page-wechat.md](../content/brand/one-page-wechat.md) 是品牌定位、核心标签、栏目体系、品牌颜色、内容规范、写作风格及 GEO / AI-Friendly Writing 原则的唯一正式 SSOT，直接维护，不设外部 upstream 或同步副本，不另建 Brand SSOT。

AI creation = Flexible / Human-driven / Non-linear；Title、Polish、Fact Check、GEO、Layout、Cover、Publish Check 可按需要组合。
`AI / Human flexible creation → Human Authorization Gate → deterministic Publishing Runtime`。
Publishing Runtime = Deterministic / Contract-driven / Fail-closed；创作阶段能力不属于 GitHub Action → Publisher 主链。本阶段只写清边界，不实现 Skill Orchestration。

## 9. Known P1 Gaps

**KNOWN GAP，仅记录，本阶段不修：**

A. Validator 校验 HEAD，Publisher 可能发布 authorized commit；完整结构/资产校验未与授权版本绑定。
B. Docs / Validator 支持 content_file/assets_file 引用，Publisher 固定 content.html/assets.json，filename Contract drift 未解决。

## 10. Legacy Feishu Status

Runtime decommissioned / exposure retired；旧 public、lark services、routes、templates 的 physical implementation 已在 repository physical cleanup 中移除，不是 CURRENT_ARCHITECTURE。
历史资料归档于 [docs/archive/legacy-feishu/](archive/legacy-feishu/README.md)（HISTORICAL ONLY），不执行其中旧联调或部署指令。

## 11. Experimental MCP PR #3

[PR #3](https://github.com/LyraWang6688/wechat-draft-capability/pull/3) 是 Experimental / Deferred Product Channel；2026-10-02 核验 OPEN、未合并、未删除，不属于当前 main production path。未经明确决定不合并或删除。

## 12. What NOT to Do

- repo hygiene 不发真实微信草稿，不触发默认会调用 API 的 workflow，不正式发布。
- 不删除或改写 ledger，不改 secrets，不部署或重启，不改 PM2 name/path。
- 不修本阶段 P1，不改 workflow / Validator / Publisher / WechatService 业务逻辑。
- 不做分支/worktree 清理，不合并或删除 MCP PR #3；legacy physical cleanup 须经明确批准与 dependency evidence，且不得改变 Current Publishing Logic。
- 不把 content.html/assets.json 当垃圾，不重新排版内容。
- 工作区非 clean 时先停下报告，不能覆盖用户修改；从最新 origin/main 确认事实。

## 13. Safe Validation Commands

```bash
npm ci
npm run typecheck
npm test
node scripts/validate-content.mjs
git diff --check
```

测试以 GitHub/微信替身隔离外部调用；Content Validator 只做本地检查。命令来自 package.json 与脚本实际入口，无 validate npm script。
当前服务端凭证与 workflow secrets 见 README / .env.example；不输出实际凭证。
PM2 配置是 wechat-article-pilot-dev / /opt/wechat-article-pilot-dev；文档对齐不验证线上部署状态、不执行历史服务器更新命令。
