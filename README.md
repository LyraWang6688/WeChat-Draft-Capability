# WeChat Article Pilot

## 1. What It Is

在单一仓库中维护公众号 Article Package，由人授权具体内容版本，经 GitHub Actions 与 Publisher 送入微信公众号草稿箱。
Canonical Repository：`LyraWang6688/wechat-article-pilot`。正式发布由 Lyra 人工完成。
Agent 唯一当前入口：[AGENTS.md](AGENTS.md)；工程交接见 [docs/AI_HANDOFF.md](docs/AI_HANDOFF.md)。

## 2. Current Architecture

```text
content/articles/** → Content Validator → GitHub main
→ publish-ready-articles.yml
→ 检测 transition into ready_to_upload → exact authorized commit
→ source_commit（canonical full 40-char lowercase Git SHA）
→ POST /api/publisher/drafts
→ Publisher 按 source_commit 从 GitHub 拉取 Article Package
→ PublisherStateStore（idempotency / fail-closed）
→ WechatService → 微信公众号 Draft
```

工作流在 main 的内容 push 时运行，也支持 main 上的手动 dispatch；先校验 checkout HEAD，再扫描提交中的授权转换。最终 HEAD 必须仍为 `ready_to_upload`，并选取扫描范围内最后一次进入 ready 的提交。手动 dispatch 默认会调用 API，仅 `dry_run=true` 时不调用。

当前 Express runtime（`src/app.ts`）只暴露 `GET /api/health` 与 `POST /api/publisher/drafts`；未挂载 Feishu、system、template、integration 路由，也不 serve `public/**`。其余路径返回 404。

## 3. Article Lifecycle / State Ownership

```text
Content / Human Authorization Domain: draft → ready_to_upload
Publisher Delivery Domain: processing → uploaded_to_wechat
                           或调用微信前失败记录 failed
```

Content 只拥有 `draft` / `ready_to_upload`；Publisher 只拥有 `processing` / `uploaded_to_wechat` / `failed`。
Publisher 不修改文章 `meta.json`，不回写 Content status；`GithubContentService` 当前为 read-only。
微信阶段结果未知时保留 `processing`，不能把它当作可自动重试的 `failed`。

## 4. Human Authorization Contract

Human 把状态从 not-ready 转为 `ready_to_upload`，授权的是该 transition commit 对应的具体内容版本：

```text
Human Intent → status transition → authorized commit
→ immutable source_commit → Publisher fetch exact version
```

进入 ready 后的 later edit 不自动产生新的上传授权，也不会始终发布最新 HEAD。

- `draft → ready(B) → ready(C)`：授权版本是 B。
- `draft → ready(B) → draft(C) → ready(D)`：授权版本是 D。

`ready_to_upload` 只授权送入微信草稿箱；不授权正式发布或群发。API 用 Bearer token 鉴权，授权提交的选择由 workflow 完成，Publisher 不独立重建 Git 历史授权链。

## 5. Article Package

路径：`content/articles/{year}/{article_id}/`，article_id 为 `YYYY-MM-DD-<slug>`。

| 文件 | 当前用途 |
| --- | --- |
| `meta.json` | 元数据、Content status、文件引用 |
| `source.md` | 源稿 |
| `content.html` | 最终排版 HTML，交付资产，不得当垃圾清理 |
| `assets.json` | 资产清单，交付资产 |
| `assets/` 下 cover | `cover.path` 指向封面；Contract 要求 `cover.required=true` |

`content/index.json` 是低 token 索引，需与 meta 的 id/title/status/updated_at 一致。draft 可缺封面文件，ready 必须满足 required asset 存在性校验。完整内容约定见 [content/SCHEMA.md](content/SCHEMA.md)，内容操作见 [content/AI_HANDOFF.md](content/AI_HANDOFF.md)。

**KNOWN CONTRACT GAP（P1，未修复）**：Docs / Validator 支持 `meta.content_file`、`meta.assets_file` 引用；Publisher 固定读取 `content.html`、`assets.json`。Validator 当前校验 HEAD，Publisher 可能交付较早的 authorized commit。不得宣称两者已完全一致。

## 6. Publisher API

`POST /api/publisher/drafts`，请求头 `Authorization: Bearer <PUBLISHER_WEBHOOK_TOKEN>`。

```json
{
  "repository": "LyraWang6688/wechat-article-pilot",
  "article_id": "2026-09-29-ai-tools",
  "ref": "main",
  "source_commit": "b673a64e13cd8c0f80aee601809386f46c44e9ae"
}
```

示例仅说明请求格式，不是发送指令，也不表示该 SHA 已授权该文章。请求不携带完整 HTML；`ref` 必填但读取版本由 `source_commit` 决定。仓库受 `PUBLISHER_ALLOWED_REPOSITORIES` 白名单限制。
成功返回 `{ok:true,data}`，data 含 article_id、status=`uploaded_to_wechat`、source_commit、wechat_draft_media_id、uploaded_at、idempotent_replay；错误为 `{ok:false,error}`，含 message/code/retryable 等字段。

## 7. Idempotency / Delivery Safety

这些是系统安全约束：

- Idempotency Key：`article_id + source_commit`（内部以 `::` 连接）；SHA 必须严格匹配 `^[0-9a-f]{40}$`，不 trim、不接受分支名、短 SHA 或大写变体。
- Ledger 默认 `.data/publisher-state.json`，分类 **DELIVERY_STATE**，不是 cache、build artifact 或 generated garbage；即使 gitignored，也禁止删除或清空以重试。
- 第一次 WeChat side effect 前持久化 `processing`；reserve 失败返回可重试 `STATE_SAVE_FAILED`，尚未调用微信。
- `uploaded_to_wechat` 可 idempotent replay；同键并发请求在单进程内合并。
- 微信阶段失败或成功结果保存失败均属于 unknown outcome：保留 `processing`，返回不可重试 `409 DELIVERY_OUTCOME_UNKNOWN`，须人工确认，禁止自动重试。
- corrupted ledger、duplicate idempotency key、invalid semantic record 全部 fail-closed；不允许 partial recovery 或静默去重。加载失败持续拒绝 find/save，不回退为空状态。
- 写链串行化，以临时文件 + rename 替换快照，写盘成功后才更新 memory state。当前实现未调用 fsync，不应扩大为断电持久性保证。
- 本地 ledger / in-flight 保护对应单进程模型；多副本共享存储与分布式锁尚未实现。

## 8. Environment Variables

当前 Publisher 服务必配凭证（只放服务端，不写入 Git 或日志）：

| 变量 | 用途 / 默认值 |
| --- | --- |
| `GITHUB_CONTENT_TOKEN` | canonical 仓库 Contents Read-only token |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 单公众号凭证 |
| `PUBLISHER_WEBHOOK_TOKEN` | API Bearer 鉴权 |

当前可配置变量：

| 变量 | 用途 / 默认值 |
| --- | --- |
| `PUBLISHER_STATE_FILE` | cwd 下 `.data/publisher-state.json` |
| `PUBLISHER_ALLOWED_REPOSITORIES` | `LyraWang6688/wechat-article-pilot`，逗号分隔 |
| `GITHUB_API_TIMEOUT_MS` | `30000` |
| `WECHAT_API_TIMEOUT_MS` | `120000` |
| `PORT` | 代码默认 `3000`，`.env.example` / PM2 dev 为 `3010` |
| `LOG_LEVEL` | `info` |

Workflow Secrets：`PUBLISHER_ENDPOINT`（服务 base URL）与 `PUBLISHER_WEBHOOK_TOKEN`。微信和 GitHub 内容凭证不交给 workflow。

Legacy-only：`LARK_CLI_BIN`、`LARK_CLI_TIMEOUT_MS`、`DEFAULT_BASE_TOKEN`、`DEFAULT_TABLE_ID`、`LOG_CLI_STDOUT`、`LOG_CLI_STDOUT_MAX_CHARS`、`LOG_CLI_STDERR_MAX_CHARS`；不是当前 Publisher 必需配置。参见 [.env.example](.env.example)。

## 9. Validation / Tests

```bash
npm ci
npm run typecheck
npm test
node scripts/validate-content.mjs
git diff --check
```

这是本地结构与自动化验证，不证明真实微信 E2E 或线上部署。开发命令 `npm run dev`；编译 `npm run build`；运行编译结果 `npm start`。Node 版本需满足 lockfile 中依赖的 engines。
PM2 配置仍为 `wechat-article-pilot-dev`、`/opt/wechat-article-pilot-dev`；本次 hygiene 不执行部署或重启。

## 10. Legacy Feishu Status

Feishu 已不是 Current Publishing Control Plane。Legacy Feishu Runtime Exposure 已关闭（runtime decommissioned）；残留 `public/**`、lark services、旧 routes/templates 等分类为 **LEGACY_IMPLEMENTATION**，不是 CURRENT_ARCHITECTURE。服务装配仍构造部分 legacy 对象，不代表路由仍可访问。
Physical cleanup deferred until E2E 并获得明确批准；本阶段不物理删除。旧资料保留原文并加 HISTORICAL ONLY 标识，不作为当前运行或部署指南。

## 11. Experimental MCP Channel

[PR #3](https://github.com/LyraWang6688/wechat-article-pilot/pull/3) 是 Experimental / Deferred Product Channel。2026-10-02 核验为 OPEN、未合并、未删除，不属于当前 main production path。本阶段不合并或删除它。
